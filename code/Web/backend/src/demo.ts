import express, { Router, type Request } from 'express';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { libraryCatalog, libraryFile } from './demo-library.js';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { digest } from './security.js';

const directory = fileURLToPath(new URL('../inference/', import.meta.url));
const python = process.env.AI_PYTHON || fileURLToPath(new URL(process.platform === 'win32' ? '../inference/.venv/Scripts/python.exe' : '../inference/.venv/bin/python', import.meta.url));
const secret = randomBytes(32).toString('hex');
let child: ChildProcess | undefined, base = '', starting: Promise<void> | undefined;
async function startWorker() {
  if (child && base) return;
  if (starting) return starting;
  starting = (async () => {
    if (!existsSync(python)) throw new Error('Chưa cài Python AI. Chạy npm run ai:setup trong backend rồi thử lại.');
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer(); server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') { server.close(); reject(new Error('No worker port')); return; } server.close(() => resolve(address.port)); });
    });
    const endpoint = `http://127.0.0.1:${port}`;
    const worker = spawn(python, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port), '--no-access-log'], { cwd: directory, env: { ...process.env, TRAFFIC_AI_SECRET: secret, YOLO_CONFIG_DIR: `${directory}/.runtime`, YOLO_AUTOINSTALL: 'false' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child = worker;
    let failed = false;
    worker.on('error', () => { failed = true; });
    worker.on('exit', () => { failed = true; if (child === worker) { child = undefined; base = ''; } });
    worker.stderr?.on('data', () => { /* Runtime errors are returned as sanitized API messages. */ });
    for (let attempt = 0; attempt < 240; attempt++) {
      if (failed) break;
      try {
        const response = await fetch(`${endpoint}/health`, { headers: { 'x-ai-secret': secret }, signal: AbortSignal.timeout(1000) });
        if (response.ok) { base = endpoint; return; }
      } catch { /* Python is importing PyTorch. */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    worker.kill(); child = undefined;
    throw new Error('Không khởi động được AI runtime. Chạy npm run ai:setup; kiểm tra Python/PyTorch và thử lại.');
  })().finally(() => { starting = undefined; });
  return starting;
}
export function stopAiWorker() { child?.kill(); child = undefined; base = ''; }
process.once('exit', stopAiWorker);
process.once('SIGINT', () => child?.kill());
process.once('SIGTERM', () => child?.kill());

export function demoRouter(sessionToken: (req: Request) => string) {
  const router = Router();
  router.use(async (req, res, next) => {
    const token = sessionToken(req);
    if (!token) { res.status(401).json({ message: 'Vui lòng đăng nhập.' }); return; }
    const { rows } = await pool.query('SELECT u.id,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true', [digest(token)]);
    if (!rows[0]) { res.status(401).json({ message: 'Phiên đăng nhập đã hết hạn.' }); return; }
    if (rows[0].role !== 'admin') { res.status(403).json({ message: 'Chỉ quản trị viên được nạp và chạy model .pt trên máy chủ.' }); return; }
    res.locals.actor = rows[0]; next();
  });
  const proxy = (path: string, timeout: number) => async (req: Request, res: express.Response) => {
    try {
      await startWorker();
      const response = await fetch(`${base}/${path}`, { method: req.method, headers: { 'Content-Type': 'application/json', 'x-ai-secret': secret, 'x-ai-owner': res.locals.actor.id }, ...(req.method === 'GET' ? {} : { body: JSON.stringify(req.body) }), signal: AbortSignal.timeout(timeout) });
      const result = await response.json() as Record<string, unknown>;
      res.status(response.status).json(response.ok ? result : { message: result.detail || 'AI runtime không xử lý được yêu cầu.' });
    } catch (error) { res.status(503).json({ message: error instanceof Error && !base ? error.message : 'AI runtime không phản hồi. Giảm độ phân giải hoặc nạp lại model.' }); }
  };
  router.get('/catalog', async (_req, res) => { res.json(await libraryCatalog()); });
  router.get('/videos/:id/stream', async (req, res) => {
    const entry = await libraryFile('videos', req.params.id);
    if (!entry) { res.status(404).json({ message: 'Video không còn trong thư viện máy chủ.' }); return; }
    res.set('X-Content-Type-Options', 'nosniff');
    res.sendFile(entry.path, { acceptRanges: true, cacheControl: false }, error => { if (error && !res.headersSent) res.status((error as { status?: number }).status || 500).end(); });
  });
  router.post('/model-server', express.json({ limit: '1kb' }), async (req, res, next) => {
    const entry = await libraryFile('models', req.body?.id);
    if (!entry) { res.status(404).json({ message: 'Model không còn trong thư viện máy chủ.' }); return; }
    req.body = { data: (await readFile(entry.path)).toString('base64') };
    next();
  }, proxy('model', 180000));
  router.get('/health', proxy('health', 5000));
  router.post('/model', express.json({ limit: '135mb' }), (req, res, next) => {
    if (typeof req.body?.data !== 'string' || req.body.data.length > 139810136 || !/^[A-Za-z0-9+/]*={0,2}$/.test(req.body.data)) { res.status(400).json({ message: 'Model .pt không hợp lệ hoặc vượt quá 100 MB.' }); return; }
    next();
  }, proxy('model', 180000));
  router.post('/classify', express.json({ limit: '6mb' }), proxy('classify', 30000));
  router.post('/release', express.json({ limit: '1kb' }), proxy('release', 5000));
  return router;
}
