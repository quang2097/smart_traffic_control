import { Router, type Request } from 'express';
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { digest, newToken } from './security.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const phases = ['waiting','green','yellow','clearance'];
const command = (row: any) => row ? { id: row.id, redAxis: row.red_axis, redSeconds: row.red_seconds, yellowSeconds: row.yellow_seconds, clearanceSeconds: row.clearance_seconds } : null;
export function embeddedRouter(sessionToken: (req: Request) => string) {
  const router = Router();
  // Devices use a dedicated credential, never a browser login or an admin password.
  router.post('/exchange', async (req, res) => {
    const body = req.body ?? {}, bearer = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!bearer || !uuid.test(body.deviceId || '')) { res.status(401).json({ message: 'Invalid device credential.' }); return; }
    if (typeof body.bootId !== 'string' || !/^[a-f0-9]{32}$/.test(body.bootId) || !phases.includes(body.phase) ||
      !Number.isInteger(body.completedId) || body.completedId < 0 || !Number.isInteger(body.remainingMs) || body.remainingMs < 0 || body.remainingMs > 180000 ||
      (body.activeId !== null && (!Number.isInteger(body.activeId) || body.activeId < 1))) { res.status(400).json({ message: 'Invalid device report.' }); return; }
    if ((body.phase === 'waiting' && body.activeId !== null) || (body.phase !== 'waiting' && body.activeId === null) || (body.phase === 'yellow' && body.remainingMs > 3000) || (body.phase === 'clearance' && body.remainingMs > 2000)) { res.status(400).json({message:'Inconsistent phase report.'});return; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const device = (await client.query('SELECT * FROM embedded_devices WHERE id=$1 AND token_hash=$2 AND enabled=true FOR UPDATE', [body.deviceId, digest(bearer)])).rows[0];
      if (!device) { await client.query('ROLLBACK'); res.status(401).json({ message: 'Invalid device credential.' }); return; }
      if (device.boot_id && device.boot_id !== body.bootId) {
        await client.query("UPDATE embedded_commands SET status='aborted',completed_at=now() WHERE device_id=$1 AND status IN ('queued','offered','started')", [device.id]);
      }
      if (body.completedId) {
        const completed = (await client.query('SELECT * FROM embedded_commands WHERE device_id=$1 AND id=$2', [device.id, body.completedId])).rows[0];
        if (!completed || !['offered','started','completed'].includes(completed.status) || (await client.query("SELECT 1 FROM embedded_commands WHERE device_id=$1 AND id<$2 AND status='queued' LIMIT 1", [device.id, body.completedId])).rowCount) {
          await client.query('ROLLBACK'); res.status(409).json({ message: 'Unknown or out-of-order completed command.' }); return;
        }
        await client.query("UPDATE embedded_commands SET status='completed',completed_at=now() WHERE device_id=$1 AND id<=$2 AND status IN ('offered','started')", [device.id, body.completedId]);
      }
      if (body.activeId !== null) {
        const active = (await client.query('SELECT * FROM embedded_commands WHERE device_id=$1 AND id=$2', [device.id, body.activeId])).rows[0];
        if (!active || !['offered','started'].includes(active.status) || body.activeId <= body.completedId) { await client.query('ROLLBACK'); res.status(409).json({ message: 'Unknown active command.' }); return; }
        await client.query("UPDATE embedded_commands SET status='started',started_at=coalesce(started_at,now()) WHERE device_id=$1 AND id=$2", [device.id, body.activeId]);
      }
      const next = (await client.query("SELECT * FROM embedded_commands WHERE device_id=$1 AND status IN ('queued','offered') AND ($2::integer IS NULL OR id<>$2) ORDER BY id LIMIT 1", [device.id, body.activeId])).rows[0];
      if (next) await client.query("UPDATE embedded_commands SET status='offered' WHERE id=$1", [next.id]);
      await client.query('UPDATE embedded_devices SET boot_id=$2,last_seen=now(),reported=$3 WHERE id=$1', [device.id, body.bootId, JSON.stringify({ phase: body.phase, activeId: body.activeId, completedId: body.completedId, remainingMs: body.remainingMs })]);
      await client.query('COMMIT');
      res.json({ protocol: 1, next: command(next), pollMs: 1000 });
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });
  router.use(async (req, res, next) => {
    const token = sessionToken(req);
    const { rows } = await pool.query('SELECT u.id,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true', [digest(token)]);
    if (!token || !rows[0]) { res.status(401).json({ message: 'Vui lòng đăng nhập.' }); return; }
    if (rows[0].role !== 'admin') { res.status(403).json({ message: 'Chỉ quản trị viên được cấu hình ESP32.' }); return; }
    res.locals.actor = rows[0]; next();
  });
  router.get('/devices', async (_req, res) => {
    const devices = (await pool.query('SELECT d.id,d.name,d.intersection_id,d.enabled,d.boot_id,d.last_seen,d.reported,i.name AS intersection_name FROM embedded_devices d JOIN intersections i ON i.id=d.intersection_id ORDER BY d.created_at')).rows;
    for (const device of devices) {
      device.commands = (await pool.query('SELECT id,red_axis,red_seconds,status,created_at,started_at,completed_at FROM embedded_commands WHERE device_id=$1 ORDER BY id DESC LIMIT 20', [device.id])).rows.reverse();
      device.online = Boolean(device.last_seen && Date.now() - new Date(device.last_seen).getTime() < 10000);
      const last = (await pool.query("SELECT red_axis FROM embedded_commands WHERE device_id=$1 AND status<>'aborted' ORDER BY id DESC LIMIT 1",[device.id])).rows[0];
      device.nextRedAxis = last?.red_axis === 'north_south' ? 'east_west' : 'north_south';
    }
    res.json({ devices, simulation: true, serverTime: new Date() });
  });
  router.post('/devices', async (req, res) => {
    const { intersectionId, name } = req.body ?? {};
    if (!uuid.test(intersectionId || '') || typeof name !== 'string' || !name.trim() || name.trim().length > 120) { res.status(400).json({ message: 'Chọn nút giao và tên thiết bị hợp lệ.' }); return; }
    const token = newToken(), id = randomUUID();
    const result = await pool.query('INSERT INTO embedded_devices(id,intersection_id,name,token_hash) SELECT $1,id,$3,$4 FROM intersections WHERE id=$2 ON CONFLICT(intersection_id) DO NOTHING RETURNING id', [id, intersectionId, name.trim(), digest(token)]);
    if (!result.rows[0]) { res.status(409).json({ message: 'Nút giao không tồn tại hoặc đã có ESP32.' }); return; }
    res.status(201).json({ deviceId: id, token, message: 'Lưu thông tin này để nhập qua Serial. Token chỉ hiển thị một lần.' });
  });
  router.post('/devices/:id/credential', async (req, res) => {
    if (!uuid.test(String(req.params.id))) { res.status(400).json({message:'ID không hợp lệ.'}); return; }
    const token=newToken();const result=await pool.query('UPDATE embedded_devices SET token_hash=$2 WHERE id=$1 RETURNING id',[req.params.id,digest(token)]);
    if(!result.rows[0]){res.status(404).json({message:'Không tìm thấy thiết bị.'});return;}
    res.json({deviceId:req.params.id,token});
  });
  router.post('/devices/:id/queue', async (req, res) => {
    const { redAxis, redSeconds, requestId } = req.body ?? {};
    if (!uuid.test(String(req.params.id)) || !uuid.test(requestId || '') || !['north_south','east_west'].includes(redAxis) || !Number.isInteger(redSeconds) || redSeconds < 10 || redSeconds > 180) { res.status(400).json({ message: 'Thời gian giữ phải là số nguyên 10–180 giây; hướng đỏ và requestId phải hợp lệ.' }); return; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const device = (await client.query('SELECT id FROM embedded_devices WHERE id=$1 AND enabled=true FOR UPDATE', [req.params.id])).rows[0];
      if (!device) { await client.query('ROLLBACK'); res.status(404).json({ message: 'Không tìm thấy thiết bị.' }); return; }
      const existing = (await client.query('SELECT * FROM embedded_commands WHERE request_id=$1', [requestId])).rows[0];
      if (existing) {
        await client.query('ROLLBACK');
        if (existing.device_id !== device.id || existing.red_axis !== redAxis || existing.red_seconds !== redSeconds) { res.status(409).json({ message: 'requestId đã dùng cho lệnh khác.' }); return; }
        if(existing.status==='aborted'){res.status(409).json({message:'Lệnh đã hủy sau reset; dùng requestId mới.'});return;}
        res.json({ command: command(existing), duplicate: true }); return;
      }
      const last = (await client.query("SELECT red_axis FROM embedded_commands WHERE device_id=$1 AND status<>'aborted' ORDER BY id DESC LIMIT 1", [device.id])).rows[0];
      if (last?.red_axis === redAxis) { await client.query('ROLLBACK'); res.status(409).json({ message: 'Lệnh kế tiếp phải đổi sang hướng đỏ đối diện.' }); return; }
      const count = (await client.query("SELECT count(*)::int AS count FROM embedded_commands WHERE device_id=$1 AND status IN ('queued','offered')", [device.id])).rows[0].count;
      if (count >= 8) { await client.query('ROLLBACK'); res.status(409).json({ message: 'Hàng đợi đã có 8 lệnh. Chờ ESP32 thực hiện.' }); return; }
      const created = (await client.query('INSERT INTO embedded_commands(device_id,red_axis,red_seconds,request_id,actor_id) VALUES($1,$2,$3,$4,$5) RETURNING *', [device.id, redAxis, redSeconds, requestId, res.locals.actor.id])).rows[0];
      await client.query('COMMIT'); res.status(201).json({ command: command(created) });
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });
  return router;
}
