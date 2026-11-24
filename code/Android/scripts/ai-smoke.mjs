import { fork, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const backendDir = fileURLToPath(new URL('../../Web/backend/', import.meta.url));
const child = fork(resolve(backendDir, 'src/testing/ai-desktop-fixture.ts'), [], {
  cwd: backendDir, execArgv: ['--import', pathToFileURL(resolve(backendDir, 'node_modules/tsx/dist/loader.mjs')).href], silent: true,
});
child.stderr.on('data', data => process.stderr.write(data));
const sdk = process.env.ANDROID_HOME || `${process.env.LOCALAPPDATA}/Android/Sdk`;
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
const executable = resolve(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const adb = (...args) => {
  const result = spawnSync(executable, ['-s', serial, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
};
let ws, evaluate, originalBackend, port;
try {
  const details = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('exit', code => reject(new Error(`AI backend exited: ${code}`))); });
  if (details.error) throw new Error(details.error);
  port = new URL(details.origin).port;
  adb('reverse', `tcp:${port}`, `tcp:${port}`);
  adb('shell', 'am', 'start', '-n', 'com.smarttraffic.android/.MainActivity');
  let socket;
  for (let i=0; i<50 && !socket; i++) {
    let pid;
    try { pid = adb('shell', 'pidof', 'com.smarttraffic.android'); }
    catch { await new Promise(resolve=>setTimeout(resolve,100)); continue; }
    socket = adb('shell', 'cat', '/proc/net/unix').match(new RegExp(`@webview_devtools_remote_${pid}\\b`))?.[0].slice(1);
    if (!socket) await new Promise(resolve=>setTimeout(resolve,100));
  }
  if (!socket) throw new Error('Debug WebView not found; install and launch the current debug APK.');
  adb('forward', 'tcp:9223', `localabstract:${socket}`);
  const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
  const target = targets.find(item => item.type==='page' && item.url.startsWith('https://localhost'));
  if (!target) throw new Error('App WebView not found');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
  let sequence=0; const pending=new Map();
  ws.onmessage = event => { const message=JSON.parse(event.data);
    const callback=pending.get(message.id); if(callback){pending.delete(message.id);if(message.error)callback.reject(new Error(message.error.message));else callback.resolve(message.result)} };
  const command=(method,params)=>new Promise((resolve,reject)=>{
    const id=++sequence;const deadline=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out`))},15000);
    pending.set(id,{resolve:value=>{clearTimeout(deadline);resolve(value)},reject:error=>{clearTimeout(deadline);reject(error)}});ws.send(JSON.stringify({id,method,params}));
  });
  evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value};
  const wait=async (expression,timeout=15000)=>{const end=Date.now()+timeout;while(Date.now()<end){try{if(await evaluate(expression))return}catch{}await new Promise(resolve=>setTimeout(resolve,100))}throw new Error(`Android AI UI timed out: ${expression}`)};
  originalBackend=await evaluate(`localStorage.getItem('smart-traffic.backend')`);
  await evaluate(`localStorage.setItem('smart-traffic.backend',${JSON.stringify(`http://127.0.0.1:${port}`)})`);
  await command('Page.reload',{});await wait(`!!document.querySelector('#auth-form')`);
  await evaluate(`document.querySelector('#email').value=${JSON.stringify(details.email)};document.querySelector('#password').value=${JSON.stringify(details.password)};document.querySelector('#auth-form').requestSubmit()`);
  await wait(`document.querySelector('#demo-server-video')?.options.length===2`);
  assert.equal(await evaluate(`document.querySelectorAll('#ai-workspace input[type=file]').length`),0);
  assert.equal(await evaluate(`document.querySelector('#demo-video-source').options.length`),1);
  assert.equal(await evaluate(`document.querySelector('#demo-model-source').options.length`),1);
  await evaluate(`document.querySelector('#demo-server-video').selectedIndex=1;document.querySelector('#demo-use-server-video').click();document.querySelector('#demo-server-model').selectedIndex=1;document.querySelector('#demo-load-model').click()`);
  await wait(`document.querySelector('#demo-video').videoWidth===640`);
  await wait(`document.querySelector('#demo-model-name').textContent.includes('3 lớp')`,180000);
  await evaluate(`document.querySelector('#demo-crop').click();document.querySelector('#demo-overlay').scrollIntoView({block:'center'})`);
  const r=await evaluate(`(()=>{const r=document.querySelector('#demo-overlay').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`);
  const points=[{x:r.x+r.width*.15,y:r.y+r.height*.15},{x:r.x+r.width*.8,y:r.y+r.height*.8}];
  await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[points[0]]});
  await command('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[points[1]]});
  await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await wait(`document.querySelector('#demo-size-dialog').open`);
  await evaluate(`document.querySelector('#demo-width').value='160';document.querySelector('#demo-height').value='96';document.querySelector('#demo-size-form').requestSubmit();document.querySelector('#demo-play').click()`);
  await wait(`document.querySelector('#demo-result').textContent==='TEST congested'`,30000);
  assert.equal(await evaluate(`document.querySelector('#demo-input-preview').width`),160);
  await evaluate(`document.querySelector('#demo-seek').value='500';document.querySelector('#demo-seek').dispatchEvent(new Event('input'))`);
  await wait(`document.querySelector('#demo-video').currentTime>=4.9`);
  await wait(`document.querySelector('#demo-result').textContent==='TEST congested'`);
  await evaluate(`document.querySelector('#demo-play').click();document.querySelector('#demo-stage').scrollIntoView({block:'center'})`);
  const output=fileURLToPath(new URL('../android/app/build/outputs/',import.meta.url));mkdirSync(output,{recursive:true});
  await wait(`Array.from(document.querySelector('#demo-overlay').getContext('2d').getImageData(0,0,640,360).data).some((value,index)=>index%4===3 && value>0)`);
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const screenshot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(resolve(output,'android-ai-server-library.png'),Buffer.from(screenshot.data,'base64'));
  adb('shell','screencap','-p','/data/local/tmp/traffic-ai-test.png');adb('pull','/data/local/tmp/traffic-ai-test.png',resolve(output,'android-ai-device-screen.png'));
  await evaluate(`document.querySelector('#rl-tab').click()`);
  assert.equal(await evaluate(`document.querySelector('#rl-panel button').disabled`),true);
  assert.equal(await evaluate(`document.querySelectorAll('#ai-workspace input[type=file]').length`),0);
  await evaluate(`document.querySelector('#rl-server-model').selectedIndex=1;document.querySelector('#rl-server-model').dispatchEvent(new Event('change'));document.querySelector('#rl-server-video').selectedIndex=1;document.querySelector('#rl-server-video').dispatchEvent(new Event('change'))`);
  assert.match(await evaluate(`document.querySelector('#rl-files').textContent`),/SYNTHETIC/);
  await evaluate(`document.querySelector('#vision-tab').click();document.querySelector('#demo-play').click()`);
  await wait(`!document.querySelector('#demo-video').paused`);
  adb('shell','input','keyevent','KEYCODE_HOME');
  await wait(`document.querySelector('#demo-video').paused`);
  adb('shell','am','start','-n','com.smarttraffic.android/.MainActivity');
  await evaluate(`document.querySelector('#demo-release').click()`);
  await wait(`document.querySelector('#demo-play').disabled`);
  await evaluate(`document.querySelector('#logout').click()`);await wait(`!!document.querySelector('#auth-form')`);
  console.log('PASS Android: server-only sources, authenticated video and seeking, real YOLO classification, touch crop/resize, RL server selectors, background pause, release and logout');
} finally {
  if(evaluate){try{await evaluate(`window.Capacitor.Plugins.TrafficCamera.stopMedia()`);await evaluate(`window.Capacitor.Plugins.CapacitorCookies.clearAllCookies()`);await evaluate(originalBackend===null?`localStorage.removeItem('smart-traffic.backend')`:`localStorage.setItem('smart-traffic.backend',${JSON.stringify(originalBackend)})`);await evaluate(`location.reload()`)}catch{}}
  ws?.close();try{adb('forward','--remove','tcp:9223');if(port)adb('reverse','--remove',`tcp:${port}`)}catch{}
  if(child.connected){const stopped=new Promise(resolve=>child.once('exit',resolve));child.send('stop');await stopped}
}
