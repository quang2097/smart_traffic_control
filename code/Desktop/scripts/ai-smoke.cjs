const { app, BrowserWindow } = require('electron');
const { fork } = require('node:child_process');
const { resolve, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const web = process.argv.includes('--web-ai-test');
const temporary = mkdtempSync(join(tmpdir(), 'traffic-desktop-ai-'));
app.setPath('userData', temporary);
let child, window, stopping = false;
async function finish(code) {
  if (stopping) return; stopping = true; clearTimeout(deadline);
  if (child?.connected) { const exited = new Promise(resolve => child.once('exit', resolve)); child.send('stop'); await exited; }
  window?.destroy(); app.exit(code);
}
const deadline = setTimeout(() => { console.error('Desktop AI test timed out'); void finish(1); }, 240000);
const created = new Promise(resolve => app.once('browser-window-created', (_event, instance) => resolve(instance)));
app.whenReady().then(async () => {
  try {
    const backend = resolve(__dirname, '../../Web/backend');
    child = fork(resolve(backend, 'src/testing/ai-desktop-fixture.ts'), [], { cwd: backend, execPath: process.execPath,
      execArgv: ['--import', pathToFileURL(resolve(backend, 'node_modules/tsx/dist/loader.mjs')).href],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, silent: true });
    child.stderr.on('data', data => process.stderr.write(data));
    const details = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('exit', code => reject(new Error(`AI fixture exited: ${code}`))); });
    if (details.error) throw new Error(details.error);
    window = web ? new BrowserWindow({show:false,width:1360,height:900,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}}) : await created;
    await window.loadURL(web ? details.origin : 'traffic://app/');
    const evaluate = expression => window.webContents.executeJavaScript(expression);
    const wait = (expression, timeout = 15000) => evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+${timeout};const check=()=>{if(${expression})resolve(true);else if(Date.now()>end)reject(new Error('UI timeout: '+${JSON.stringify(expression)}));else setTimeout(check,50)};check()})`);
    await evaluate(`localStorage.setItem('smart-traffic.backend',${JSON.stringify(details.origin)})`);
    await window.loadURL(web ? details.origin : 'traffic://app/');
    await wait(`document.querySelector('#auth-form')`);
    await evaluate(`document.querySelector('#email').value=${JSON.stringify(details.email)};document.querySelector('#password').value=${JSON.stringify(details.password)};document.querySelector('#auth-form').requestSubmit()`);
    await wait(`document.querySelector('#demo-model-file')`);
    assert.equal(await evaluate(`window.desktopTraffic?.aiDemoVersion`), web ? undefined : 1);
    assert.equal(await evaluate(`document.querySelector('#demo-model-file').disabled`), false);
    window.webContents.debugger.attach('1.3');
    async function choose(selector, filename) {
      const { root } = await window.webContents.debugger.sendCommand('DOM.getDocument');
      const { nodeId } = await window.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
      await window.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [filename] });
    }
    await choose('#demo-video-file', details.video);
    await wait(`document.querySelector('#demo-video').videoWidth===640`);
    await choose('#demo-model-file', details.model);
    await evaluate(`document.querySelector('#demo-load-model').click()`);
    await wait(`document.querySelector('#demo-model-name').textContent.includes('3 lớp')`, 180000);
    console.log('PASS desktop: native authenticated model upload and blob video decode');
    await evaluate(`document.querySelector('#demo-crop').click();document.querySelector('#demo-overlay').scrollIntoView({block:'center'})`);
    const rect = await evaluate(`(()=>{const r=document.querySelector('#demo-overlay').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
    const start = { x: Math.round(rect.x+rect.width*.2), y: Math.round(rect.y+rect.height*.2) };
    const end = { x: Math.round(rect.x+rect.width*.8), y: Math.round(rect.y+rect.height*.8) };
    window.webContents.sendInputEvent({type:'mouseMove',...start});
    window.webContents.sendInputEvent({type:'mouseDown',...start,button:'left',clickCount:1});
    window.webContents.sendInputEvent({type:'mouseMove',...end,button:'left'});
    window.webContents.sendInputEvent({type:'mouseUp',...end,button:'left',clickCount:1});
    await wait(`document.querySelector('#demo-size-dialog').open`);
    await evaluate(`document.querySelector('#demo-width').value='160';document.querySelector('#demo-height').value='96';document.querySelector('#demo-size-form').requestSubmit();document.querySelector('#demo-play').click()`);
    await wait(`document.querySelector('#demo-result').textContent==='TEST congested'`);
    assert.match(await evaluate(`document.querySelector('#demo-crop-info').textContent`), /Vùng:/);
    assert.equal(await evaluate(`document.querySelector('#demo-input-preview').width`), 160);
    assert.equal(await evaluate(`document.querySelector('#demo-input-preview').height`), 96);
    assert.equal(await evaluate(`document.querySelectorAll('#demo-predictions li').length`), 3);
    console.log('PASS desktop: drag crop, exact rectangular resize, real PyTorch classification and overlay');
    const screenshots = resolve(__dirname, '../release/screenshots'); mkdirSync(screenshots,{recursive:true});
    await evaluate(`document.querySelector('#demo-play').click();document.querySelector('#demo-stage').scrollIntoView({block:'center'})`);
    await new Promise(resolve => setTimeout(resolve,150));
    writeFileSync(join(screenshots,'desktop-ai-classification.png'),(await window.webContents.capturePage()).toPNG());
    const downloads = window.webContents.session;
    const savedDownload = (filename, click) => new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Download timeout')),15000);
      downloads.once('will-download',(_event,item)=>{ const target=join(temporary,filename);item.setSavePath(target);item.once('done',(_event,state)=>{clearTimeout(timer);if(state==='completed')resolve(target);else reject(new Error('Download '+state))}); });
      evaluate(click).catch(reject);
    });
    const snapshot = await savedDownload('classification.png',`document.querySelector('#demo-snapshot').click()`);
    assert.ok(readFileSync(snapshot).length>1000);
    const config = await savedDownload('demo.json',`document.querySelector('#demo-save').click()`);
    const settings=JSON.parse(readFileSync(config,'utf8'));assert.equal(settings.width,160);assert.equal(settings.height,96);assert.ok(settings.crop.width<1);
    await choose('#demo-config',config);
    await wait(`document.querySelector('#demo-status').textContent.includes('khôi phục')`);
    console.log('PASS desktop: annotated snapshot and demo configuration export/import');
    await evaluate(`document.querySelector('#demo-play').click()`);
    await wait(`!document.querySelector('#demo-video').paused`);
    if(web)await evaluate(`document.querySelector('#demo-play').click()`);else window.webContents.send('traffic:pause-ai');
    await wait(`document.querySelector('#demo-video').paused`);
    await evaluate(`document.querySelector('#rl-tab').click()`);
    assert.equal(await evaluate(`document.querySelector('#rl-panel').hidden`),false);
    assert.equal(await evaluate(`document.querySelector('#rl-panel button').disabled`),true);
    await choose('#rl-model',details.model);await choose('#rl-video',details.video);
    await wait(`document.querySelector('#rl-files').textContent.includes('SYNTHETIC')`);
    await evaluate(`document.querySelector('#rl-panel').scrollIntoView({block:'center'})`);
    writeFileSync(join(screenshots,'desktop-rl-development.png'),(await window.webContents.capturePage()).toPNG());
    console.log('PASS desktop: background pause and separate development-stage RL workspace');
    await evaluate(`document.querySelector('#vision-tab').click();document.querySelector('#demo-video-source').value='server';document.querySelector('#demo-video-source').dispatchEvent(new Event('change'));document.querySelector('#demo-model-source').value='server';document.querySelector('#demo-model-source').dispatchEvent(new Event('change'))`);
    await wait(`document.querySelector('#demo-server-video').options.length===2`);
    await evaluate(`document.querySelector('#demo-server-video').selectedIndex=1;document.querySelector('#demo-use-server-video').click();document.querySelector('#demo-server-model').selectedIndex=1;document.querySelector('#demo-load-model').click()`);
    await wait(`document.querySelector('#demo-model-name').textContent.includes('3 lớp') && !document.querySelector('#demo-load-model').disabled && document.querySelector('#demo-video').readyState>=2`);
    await evaluate(`document.querySelector('#demo-resolution').click();document.querySelector('#demo-width').value='160';document.querySelector('#demo-height').value='96';document.querySelector('#demo-size-form').requestSubmit();document.querySelector('#demo-play').click()`);
    await wait(`document.querySelector('#demo-result').textContent==='TEST congested'`);
    await evaluate(`document.querySelector('#demo-seek').value='500';document.querySelector('#demo-seek').dispatchEvent(new Event('input'))`);
    await wait(`document.querySelector('#demo-video').currentTime>=4.9`);
    await wait(`document.querySelector('#demo-result').textContent==='TEST congested'`);
    await evaluate(`document.querySelector('#demo-play').click();document.querySelector('#demo-stage').scrollIntoView({block:'center'})`);
    writeFileSync(join(screenshots,'desktop-server-library.png'),(await window.webContents.capturePage()).toPNG());
    console.log('PASS desktop: server video library, byte-range seeking, server model selection and real classification');

    await evaluate(`document.querySelector('#vision-tab').click();document.querySelector('#demo-release').click()`);
    await wait(`document.querySelector('#demo-model-name').textContent==='Chưa nạp model'`);
    assert.equal(await evaluate(`document.querySelector('#demo-play').disabled`),true);
    await evaluate(`document.querySelector('#logout').click()`);await wait(`document.querySelector('#auth-form')`);
    console.log('PASS desktop: model release and logout; temporary backend/account cleaned up');
    window.webContents.debugger.detach();
    await finish(0);
  } catch(error) { console.error(error); await finish(1); }
});
if(!web)require('../src/main.cjs');
