// Runs the real shell against an isolated HTTP fixture; no database or user credentials.
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'smart-traffic-smoke-')));
let server;
const deadline = setTimeout(() => { console.error('Smoke test timed out'); app.exit(1); }, 60000);
const user = { id: 'fixture-account', name: 'Điều phối viên', email: 'fixture@example.com', role: 'admin' };
const intersection = { id: 'abcd-1234', name: 'Nguyễn Huệ – Lê Lợi', location: 'Quận 1 · Thành phố Hồ Chí Minh', mode: 'automatic', version: 1, north_south_green: 35, east_west_green: 30, yellow: 4, all_red: 3, signals: { northSouth: 'green', eastWest: 'red', remaining: 18 } };
const requests = [1, 2].map(index => ({ id: `00000000-0000-0000-0000-00000000000${index}`, account_name: `Test user ${index}`, request_email: 'user@example.com', request_phone: '0901234567', request_account_id: '00000000-0000-0000-0000-000000000003', status: 'pending', created_at: new Date().toISOString() }));
const createdUsers = [];
let activeUser = user;
let unavailable = false;
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const result = await window.webContents.executeJavaScript(`(async () => {
        const bridge = window.desktopTraffic;
        const base = ${JSON.stringify(base)};
        const login = await bridge.request(base, '/api/auth/login', {email:'fixture@example.com', password:'fixture-password'});
        const me = await bridge.request(base, '/api/auth/me');
        const forgot = await bridge.request(base, '/api/auth/forgot-password', {email:'fixture@example.com'});
        const otp = await bridge.request(base, '/api/auth/verify-otp', {challengeId:'fixture',code:'123456'});
        const health = await bridge.request(base, '/api/health');
        await bridge.clearSession();
        const cleared = await bridge.request(base, '/api/auth/me');
        let denied = false;
        try { await bridge.request(base, '//evil.example'); } catch { denied = true; }
        return { login:login.status, me:me.status, otp:otp.status, health:health.data.status, cleared:cleared.status, denied, panel:!!document.querySelector('.connection-panel'), title:document.title };
      })()`);
      assert.equal(result.login, 200);
      assert.equal(result.me, 200);
      assert.equal(result.otp, 200);
      assert.equal(result.health, 'ok');
      assert.equal(result.cleared, 401);
      assert.equal(result.denied, true);
      assert.equal(result.panel, true);
      assert.match(result.title, /Smart Traffic/);
      await window.webContents.executeJavaScript(`localStorage.setItem('smart-traffic.backend', ${JSON.stringify(base)})`);
      const loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
      window.reload();
      await loaded;
      const waitFor = expression => window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const end = Date.now() + 10000; const check = () => { if (${expression}) resolve(true); else if(Date.now()>end) reject(new Error('UI condition timed out')); else setTimeout(check, 50); }; check(); })`);
      await waitFor(`document.querySelector('#auth-form')`);
      await window.webContents.executeJavaScript(`document.querySelector('#forgot').click(); Array.from(document.querySelectorAll('button')).find(button => button.textContent==='Gửi yêu cầu cho quản trị viên').click();`);
      await waitFor(`document.querySelector('#recovery-dialog form')`);
      await window.webContents.executeJavaScript(`(() => { const form=document.querySelector('#recovery-dialog form'); for(const [key,value] of Object.entries({name:'Test user',email:'user@example.com',phone:'0901234567',accountId:'00000000-0000-0000-0000-000000000003'})) form.elements.namedItem(key).value=value; form.requestSubmit(); })()`);
      await waitFor(`document.querySelector('#recovery-feedback').textContent.includes('Fixture request accepted')`);
      console.log('PASS UC05 UI: submit personal-information recovery request');
      await window.webContents.executeJavaScript(`document.querySelector('.close-dialog').click(); for(const [key,value] of Object.entries({name:'Test user',email:'fixture@example.com',phone:'0901234567',accountId:'00000000-0000-0000-0000-000000000003'})) document.querySelector('#auth-form').elements.namedItem(key).value=value; document.querySelector('#auth-form').requestSubmit()`);
      await waitFor(`document.querySelector('#code')`);
      await window.webContents.executeJavaScript(`document.querySelector('#code').value='000000'; document.querySelector('#auth-form').requestSubmit()`);
      await waitFor(`document.querySelector('#feedback.error')?.textContent.includes('Fixture invalid OTP')`);
      assert.equal(await window.webContents.executeJavaScript(`!!document.querySelector('#code')`), true);
      await window.webContents.executeJavaScript(`document.querySelector('#code').value='123456'; document.querySelector('#auth-form').requestSubmit()`);
      await waitFor(`document.querySelector('#confirm')`);
      console.log('PASS UC06 UI: invalid email OTP is rejected and valid OTP opens password reset');
      await window.webContents.executeJavaScript(`document.querySelector('#password').value='Reset fixture password!'; document.querySelector('#confirm').value='Wrong fixture password!'; document.querySelector('#auth-form').requestSubmit()`);
      await waitFor(`document.querySelector('#feedback.error')?.textContent.includes('không khớp')`);
      await window.webContents.executeJavaScript(`document.querySelector('#confirm').value='Reset fixture password!'; document.querySelector('#auth-form').requestSubmit()`);
      await waitFor(`document.querySelector('#forgot')`);
      console.log('PASS UC03 UI: forgot-password email flow, confirmation validation and reset');
      await window.webContents.executeJavaScript(`document.querySelector('#email').value='fixture@example.com'; document.querySelector('#password').value='fixture-password'; document.querySelector('#auth-form').requestSubmit();`);
      await waitFor(`document.querySelector('[data-workspace=traffic-dashboard]')`);
      await window.webContents.executeJavaScript(`document.querySelector('[data-workspace=traffic-dashboard]').click()`);
      await waitFor(`document.querySelector('.signal-color.green')`);
      console.log('PASS UC01 UI: admin login reaches authenticated dashboard');
      for (const role of ['admin', 'user']) {
        await window.webContents.executeJavaScript(`document.querySelector('#create-user').click(); for(const [key,value] of Object.entries({name:'New fixture account',email:'new-${role}@example.com',role:'${role}',password:'New fixture password!',confirm:'Wrong fixture password!'})) document.querySelector('#auth-form').elements.namedItem(key).value=value; document.querySelector('#auth-form').requestSubmit()`);
        await waitFor(`document.querySelector('#feedback.error')?.textContent.includes('không khớp')`);
        await window.webContents.executeJavaScript(`document.querySelector('#confirm').value='New fixture password!'; document.querySelector('#auth-form').requestSubmit()`);
        await waitFor(`document.querySelector('#create-user')`);
        assert.equal(createdUsers.at(-1)?.role, role);
      }
      console.log('PASS UC04 UI: admin creates admin/user accounts and confirmation mismatch is blocked');
      await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.account button')).find(button=>button.textContent==='Xử lý yêu cầu đổi mật khẩu').click()`);
      await waitFor(`document.querySelector('[data-reject]')`);
      await window.webContents.executeJavaScript(`document.querySelector('[data-reject]').click()`);
      await waitFor(`document.querySelectorAll('[data-review]').length===1`);
      await window.webContents.executeJavaScript(`(() => { const form=document.querySelector('[data-review]'); form.elements.namedItem('password').value='Approved fixture password!'; form.elements.namedItem('confirm').value='Approved fixture password!'; form.requestSubmit(); })()`);
      await waitFor(`document.querySelectorAll('[data-review]').length===0`);
      console.log('PASS UC07 UI: admin views requests, rejects one and approves another');
      await window.webContents.executeJavaScript(`document.querySelector('.close-dialog').click(); document.querySelector('#change-password').click(); document.querySelector('#auth-form').requestSubmit()`);
      await waitFor(`document.querySelector('#code')`);
      await window.webContents.executeJavaScript(`document.querySelector('#code').value='123456'; document.querySelector('#auth-form').requestSubmit()`);
      await waitFor(`document.querySelector('#confirm')`);
      await window.webContents.executeJavaScript(`document.querySelector('#password').value='Changed fixture password!'; document.querySelector('#confirm').value='Changed fixture password!'; document.querySelector('#auth-form').requestSubmit()`);
      await waitFor(`document.querySelector('#forgot')`);
      console.log('PASS UC02 UI: password change requires email verification and returns to login');
      await window.webContents.executeJavaScript(`document.querySelector('#email').value='fixture@example.com'; document.querySelector('#password').value='fixture-password'; document.querySelector('#auth-form').requestSubmit()`);
      await waitFor(`document.querySelector('[data-workspace=traffic-dashboard]')`);
      await window.webContents.executeJavaScript(`document.querySelector('[data-workspace=traffic-dashboard]').click()`);
      await waitFor(`document.querySelector('.signal-color.green')`);
      const screenDir = path.resolve(__dirname, '../release/screenshots');
      mkdirSync(screenDir, { recursive: true });
      writeFileSync(path.join(screenDir, 'desktop.png'), (await window.webContents.capturePage()).toPNG());
      window.setSize(390, 844);
      await new Promise(resolve => setTimeout(resolve, 300));
      writeFileSync(path.join(screenDir, 'mobile-layout.png'), (await window.webContents.capturePage()).toPNG());
      // Polls must preserve unsaved timing edits.
      await window.webContents.executeJavaScript(`document.querySelector('[name=north_south_green]').value='45'`);
      await new Promise(resolve => setTimeout(resolve, 2300));
      assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[name=north_south_green]').value`), '45');
      unavailable = true;
      await waitFor(`document.querySelector('[data-signal]').textContent === 'Không có dữ liệu'`);
      assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.signal-color.green, .signal-color.red').length`), 0);
      unavailable = false;
      await window.webContents.executeJavaScript(`document.querySelector('#logout').click()`);
      await waitFor(`document.querySelector('#forgot')`);
      activeUser = { ...user, role: 'user' };
      await window.webContents.executeJavaScript(`document.querySelector('#email').value='fixture@example.com'; document.querySelector('#password').value='fixture-password'; document.querySelector('#auth-form').requestSubmit()`);
      await waitFor(`document.querySelector('[data-workspace=traffic-dashboard]')`);
      await window.webContents.executeJavaScript(`document.querySelector('[data-workspace=traffic-dashboard]').click()`);
      await waitFor(`document.querySelector('.signal-color.green')`);
      assert.equal(await window.webContents.executeJavaScript(`!!document.querySelector('#create-user') || !!document.querySelector('[data-configure]') || Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='Xử lý yêu cầu đổi mật khẩu')`), false);
      console.log('PASS UC01/UC04/UC07 UI: ordinary user sees monitoring and no admin controls');
      console.log('PASS: seven use-case UI flows, native cookies, endpoint restrictions, unsaved edits and stale signals; screenshots saved');
      clearTimeout(deadline); server.close(); app.exit(0);
    } catch (error) { console.error(error); server.close(); app.exit(1); }
  });
});
server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (unavailable) { res.statusCode = 503; res.end('{"message":"Fixture offline"}'); return; }
  if (req.url === '/api/auth/login') { res.setHeader('Set-Cookie', 'traffic_session=fixture; HttpOnly; SameSite=Lax; Path=/'); res.end(JSON.stringify({user:activeUser})); }
  else if (req.url === '/api/auth/logout') { res.setHeader('Set-Cookie', 'traffic_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); res.statusCode=204; res.end(); }
  else if (req.url === '/api/auth/users') {
    let body=''; req.on('data',chunk=>{body+=chunk}); req.on('end',()=>{ const data=JSON.parse(body); if(!['admin','user'].includes(data.role) || data.password!==data.confirm) { res.statusCode=400; res.end('{"message":"Fixture invalid account"}'); return; } const created={id:`00000000-0000-0000-0000-00000000000${createdUsers.length+4}`,name:data.name,email:data.email,role:data.role}; createdUsers.push(created); res.statusCode=201; res.end(JSON.stringify({user:created,message:'Fixture account created'})); });
  }
  else if (req.url === '/api/auth/forgot-password') { res.setHeader('Set-Cookie', 'traffic_otp=fixture; HttpOnly; SameSite=Lax; Path=/'); res.end('{"challengeId":"fixture"}'); }
  else if (req.url === '/api/auth/verify-otp') {
    let body=''; req.on('data',chunk=>{body+=chunk}); req.on('end',()=>{ const data=JSON.parse(body); res.statusCode=req.headers.cookie?.includes('traffic_otp=fixture') && data.code==='123456'?200:400; res.end(JSON.stringify(res.statusCode===200?{token:'a'.repeat(64)}:{message:'Fixture invalid OTP'})); });
  }
  else if (req.url === '/api/auth/reset-password') {
    let body=''; req.on('data',chunk=>{body+=chunk}); req.on('end',()=>{ const data=JSON.parse(body); res.statusCode=data.token==='a'.repeat(64) && data.password===data.confirm?200:400; res.end('{"message":"Fixture password reset"}'); });
  }
  else if (req.url === '/api/auth/change-password') {
    let body=''; req.on('data',chunk=>{body+=chunk}); req.on('end',()=>{ const data=JSON.parse(body); res.statusCode=data.token==='a'.repeat(64)?200:400; res.end('{"message":"Fixture changed"}'); });
  }
  else if (req.url === '/api/auth/recovery-requests') { if(req.method==='GET') res.end(JSON.stringify({requests})); else { res.statusCode=202; res.end('{"message":"Fixture request accepted"}'); } }
  else if (req.url.startsWith('/api/auth/recovery-requests/')) {
    let body=''; req.on('data',chunk=>{body+=chunk}); req.on('end',()=>{ const data=JSON.parse(body); const row=requests.find(row=>req.url.includes(row.id)); row.status=data.decision==='approve'?'approved':'rejected'; row.reviewed_at=new Date().toISOString(); res.end('{"message":"Fixture reviewed"}'); });
  }
  else if (req.url === '/api/auth/me') { res.statusCode = req.headers.cookie?.includes('traffic_session=fixture') ? 200 : 401; res.end(JSON.stringify({user:activeUser})); }
  else if (req.url === '/api/traffic/intersections') res.end(JSON.stringify({ intersections: [intersection], serverTime: new Date().toISOString(), simulation: true }));
  else res.end('{"status":"ok"}');
});
server.listen(0, '127.0.0.1', () => require('../src/main.cjs'));
