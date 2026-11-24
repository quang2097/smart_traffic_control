import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from './app.js';
import { pool } from './db.js';
import { digest, newToken } from './security.js';
import { stopAiWorker } from './demo.js';

test('AI API requires admin, loads real YOLO and classifies cropped frames', { skip: !existsSync('inference/.runtime/UNTRAINED-test-classifier.pt') }, async () => {
  const ids: string[] = [];
  const library = mkdtempSync(join(tmpdir(), 'traffic-library-api-')), previous = process.env.AI_LIBRARY_DIR;
  for (const kind of ['videos','models','policies']) mkdirSync(join(library,kind));
  copyFileSync('inference/.runtime/UNTRAINED-test-classifier.pt',join(library,'models','test.pt'));
  copyFileSync('inference/.runtime/SYNTHETIC-test-video.webm',join(library,'videos','test.webm'));
  process.env.AI_LIBRARY_DIR = library;
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const call = (path: string, cookie = '', body?: unknown, origin = 'http://localhost:5173') => fetch(`http://127.0.0.1:${address.port}/api/demo/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const cookies: Record<string, string> = {};
    for (const role of ['admin', 'user']) {
      const id = randomUUID(), token = newToken(); ids.push(id);
      await pool.query("INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'AI integration',$3,'unused')", [id, `${id}@example.com`, role]);
      await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [digest(token), id]);
      cookies[role] = `traffic_session=${token}`;
    }
    assert.equal((await call('health')).status, 401);
    assert.equal((await call('health', cookies.user)).status, 403);
    assert.equal((await call('model', cookies.admin, {}, 'https://untrusted.example')).status, 403);
    assert.equal((await call('model', cookies.admin, { data: 1 })).status, 400);
    const catalog = await (await call('catalog',cookies.admin)).json();
    assert.equal(catalog.models.length,1); assert.equal(catalog.videos.length,1);
    assert.equal(catalog.models[0].path,undefined);
    const stream = catalog.videos[0].streamPath;
    const videoUrl = `http://127.0.0.1:${address.port}${stream}`;
    assert.equal((await fetch(videoUrl)).status,401);
    const range=await fetch(videoUrl,{headers:{Cookie:cookies.admin,Range:'bytes=0-31'}});
    assert.equal(range.status,206); assert.equal((await range.arrayBuffer()).byteLength,32);
    assert.match(range.headers.get('content-range')!,/^bytes 0-31\//);
    assert.equal((await call('model-server',cookies.admin,{id:'../private.pt'})).status,404);
    const serverLoaded=await call('model-server',cookies.admin,{id:catalog.models[0].id});
    assert.equal(serverLoaded.status,200,await serverLoaded.clone().text());
    const loaded = await call('model', cookies.admin, { data: readFileSync('inference/.runtime/UNTRAINED-test-classifier.pt').toString('base64') });
    assert.equal(loaded.status, 200, await loaded.clone().text());
    const model = await loaded.json();
    const frame = { modelId: model.modelId, width: 160, height: 96, frame: readFileSync('inference/.runtime/test-frame.jpg').toString('base64') };
    const response = await call('classify', cookies.admin, frame);
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json();
    assert.equal(data.predictions[0].label, 'TEST congested');
    assert.ok(data.predictions[0].confidence > .8);
    assert.equal((await call('classify', cookies.admin, { ...frame, width: 0 })).status, 400);
    await call('release', cookies.admin, { modelId: model.modelId });
    assert.equal((await call('classify', cookies.admin, frame)).status, 410);
  } finally {
    stopAiWorker();
    if(previous===undefined)delete process.env.AI_LIBRARY_DIR;else process.env.AI_LIBRARY_DIR=previous;
    rmSync(library,{recursive:true,force:true});
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [ids]);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.end();
  }
});
