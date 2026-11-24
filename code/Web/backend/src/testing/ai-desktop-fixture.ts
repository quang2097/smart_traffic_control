// Disposable authenticated backend for the actual Electron AI workflow test.
import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pool } from '../db.js';
import { hashPassword } from '../security.js';

const id = randomUUID(), email = `desktop-ai-${id}@example.com`, password = 'Desktop AI fixture password!';
const directory = fileURLToPath(new URL('../../inference/', import.meta.url));
const python = fileURLToPath(new URL(process.platform === 'win32' ? '../../inference/.venv/Scripts/python.exe' : '../../inference/.venv/bin/python', import.meta.url));
const library = mkdtempSync(join(tmpdir(), 'traffic-ai-library-'));
let api: typeof import('../app.js')['app'] | undefined, stopWorker: (() => void) | undefined;
const gateway = express();
gateway.use((req,res,next) => { if(req.path.startsWith('/api/')) { if(api)api(req,res,next);else res.sendStatus(503); }else next(); });
gateway.use(express.static(fileURLToPath(new URL('../../../frontend/dist/', import.meta.url))));
const server = createServer(gateway);
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  try {
    stopWorker?.(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.query('DELETE FROM users WHERE id=$1', [id]);
    rmSync(library, { recursive: true, force: true });
  } finally { await pool.end(); process.exit(); }
}
process.on('message', message => { if (message === 'stop') void stop(); });
process.on('disconnect', () => { void stop(); });
try {
  const fixture = spawnSync(python, ['make_fixture.py'], { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (fixture.error || fixture.status !== 0) throw new Error('AI test assets could not be created. Run npm run ai:setup in Web/backend.');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test port');
  const origin = `http://127.0.0.1:${address.port}`;
  for (const kind of ['videos','models','policies']) mkdirSync(join(library,kind));
  copyFileSync(directory+'.runtime/SYNTHETIC-test-video.webm',join(library,'videos','SYNTHETIC-test-video.webm'));
  copyFileSync(directory+'.runtime/UNTRAINED-test-classifier.pt',join(library,'models','UNTRAINED-test-classifier.pt'));
  copyFileSync(directory+'.runtime/UNTRAINED-test-classifier.pt',join(library,'policies','UNTRAINED-test-policy.pt'));
  process.env.AI_LIBRARY_DIR = library;
  process.env.NODE_ENV = 'development'; process.env.APP_URL = origin;
  await pool.query("INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'Desktop AI QA','admin',$3)", [id, email, await hashPassword(password)]);
  api = (await import('../app.js')).app;
  stopWorker = (await import('../demo.js')).stopAiWorker;
  process.send?.({ origin, email, password, model: directory + '.runtime/UNTRAINED-test-classifier.pt', video: directory + '.runtime/SYNTHETIC-test-video.webm' });
} catch (error) { process.send?.({ error: (error as Error).message }); await stop(); }
