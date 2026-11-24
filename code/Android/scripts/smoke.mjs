// Test a running debug APK's real WebView/native HTTP bridge using an isolated fixture.
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const sdk = process.env.ANDROID_HOME || `${process.env.LOCALAPPDATA}/Android/Sdk`;
const executable = resolve(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
const adb = (...args) => {
  const result = spawnSync(executable, ['-s', serial, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
};
const user = { id: 'fixture-account', name: 'Điều phối viên', email: 'fixture@example.com', role: 'admin' };
const row = { id: 'abcd-1234', name: 'TEST · Nguyễn Huệ – Lê Lợi', location: 'Dữ liệu kiểm thử · Không phải đèn thực', mode: 'automatic', version: 1, north_south_green: 35, east_west_green: 30, yellow: 4, all_red: 3, signals: { northSouth: 'green', eastWest: 'red', remaining: 18 } };
let offline = false;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (offline) { res.statusCode = 503; res.end('{"message":"Fixture offline"}'); return; }
  if (req.url === '/api/auth/login') { res.setHeader('Set-Cookie', 'traffic_session=fixture; HttpOnly; SameSite=Lax; Path=/'); res.end(JSON.stringify({user})); }
  else if (req.url === '/api/auth/forgot-password') { res.setHeader('Set-Cookie', 'traffic_otp=fixture; HttpOnly; SameSite=Lax; Path=/'); res.end('{"challengeId":"fixture"}'); }
  else if (req.url === '/api/auth/verify-otp') { res.statusCode = req.headers.cookie?.includes('traffic_otp=fixture') ? 200 : 401; res.end('{"token":"fixture"}'); }
  else if (req.url === '/api/auth/me') { res.statusCode = req.headers.cookie?.includes('traffic_session=fixture') ? 200 : 401; res.end(JSON.stringify({user})); }
  else if (req.url === '/api/auth/logout') { res.setHeader('Set-Cookie', 'traffic_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); res.statusCode = 204; res.end(); }
  else if (req.url === '/api/traffic/intersections') res.end(JSON.stringify({ intersections: [row], serverTime: new Date().toISOString(), simulation: true }));
  else res.end('{"status":"ok"}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
let ws;
let originalBackend;
let evaluate;
try {
  adb('shell', 'am', 'start', '-n', 'com.smarttraffic.android/.MainActivity');
  const sockets = adb('shell', 'cat', '/proc/net/unix');
  const pid = adb('shell', 'pidof', 'com.smarttraffic.android');
  const socket = sockets.match(new RegExp(`@webview_devtools_remote_${pid}\\b`))?.[0].slice(1);
  if (!socket) throw new Error('No debug WebView socket. Launch the debug APK and retry.');
  adb('forward', 'tcp:9223', `localabstract:${socket}`);
  const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
  const target = targets.find(item => item.type === 'page' && item.url.startsWith('https://localhost'));
  if (!target) throw new Error('Smart Traffic WebView was not found');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const callback = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) callback?.reject(new Error(message.error.message));
    else callback?.resolve(message.result);
  };
  const command = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const deadline = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(deadline); resolve(value); }, reject: error => { clearTimeout(deadline); reject(error); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async expression => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      try { if (await evaluate(expression)) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Android UI timed out: ${expression}`);
  };
  // Native HTTP reaches the host through the emulator address, without a Vite server.
  const backend = `http://10.0.2.2:${port}`;
  originalBackend = await evaluate(`localStorage.getItem('smart-traffic.backend')`);
  await evaluate(`localStorage.setItem('smart-traffic.backend', ${JSON.stringify(backend)})`);
  await command('Page.reload', {});
  await wait(`!!document.querySelector('#auth-form')`);
  assert.equal(await evaluate(`!!document.querySelector('.connection-panel')`), true);
  await evaluate(`document.querySelector('#email').value='fixture@example.com'; document.querySelector('#password').value='fixture-password'; document.querySelector('#auth-form').requestSubmit()`);
  await wait(`!!document.querySelector('[data-workspace=traffic-dashboard]')`);await evaluate(`document.querySelector('[data-workspace=traffic-dashboard]').click()`);
  await wait(`!!document.querySelector('.signal-color.green')`);
  const native = `window.Capacitor.Plugins.CapacitorHttp`;
  assert.equal(await evaluate(`(async () => (await ${native}.request({url:${JSON.stringify(backend + '/api/auth/me')},method:'GET'})).status)()`), 200);
  await evaluate(`${native}.request({url:${JSON.stringify(backend + '/api/auth/forgot-password')},method:'POST',headers:{'Content-Type':'application/json'},data:{email:'fixture@example.com'}})`);
  assert.equal(await evaluate(`(async () => (await ${native}.request({url:${JSON.stringify(backend + '/api/auth/verify-otp')},method:'POST',headers:{'Content-Type':'application/json'},data:{challengeId:'fixture',code:'123456'}})).status)()`), 200);
  await evaluate(`document.querySelector('[name=north_south_green]').value='45'`);
  await new Promise(resolve => setTimeout(resolve, 2300));
  assert.equal(await evaluate(`document.querySelector('[name=north_south_green]').value`), '45');
  const directory = fileURLToPath(new URL('../android/app/build/outputs/', import.meta.url));
  mkdirSync(directory, { recursive: true });
  const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(resolve(directory, 'android-dashboard.png'), Buffer.from(screenshot.data, 'base64'));
  offline = true;
  await wait(`document.querySelector('[data-signal]')?.textContent === 'Không có dữ liệu'`);
  assert.equal(await evaluate(`document.querySelectorAll('.signal-color.green, .signal-color.red').length`), 0);
  offline = false;
  await evaluate(`document.querySelector('#logout').click()`);
  await wait(`!!document.querySelector('#auth-form')`);
  assert.equal(await evaluate(`(async () => (await ${native}.request({url:${JSON.stringify(backend + '/api/auth/me')},method:'GET'})).status)()`), 401);
  console.log('PASS: Android bundled UI, native HTTP over emulator host, login/session and OTP cookies, dashboard, unsaved edits, stale colors, logout; screenshot saved');
} finally {
  if (evaluate) {
    try {
      await evaluate(`window.Capacitor.Plugins.CapacitorCookies.clearAllCookies()`);
      await evaluate(originalBackend === null ? `localStorage.removeItem('smart-traffic.backend')` : `localStorage.setItem('smart-traffic.backend', ${JSON.stringify(originalBackend)})`);
      await evaluate(`location.reload()`);
    } catch {}
  }
  ws?.close();
  server.close();
  try { adb('forward', '--remove', 'tcp:9223'); } catch {}
}
