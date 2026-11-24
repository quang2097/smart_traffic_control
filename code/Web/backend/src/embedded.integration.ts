import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app } from './app.js';
import { pool } from './db.js';
import { digest, newToken } from './security.js';

test('ESP32 provisioning, scoped credentials, immutable queued commands, acknowledgments and reboot recovery', async () => {
  const users: string[] = [], intersectionId=randomUUID();
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}/api/embedded`;
  const call=(path:string,cookie='',body?:unknown)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  try {
    const cookies:Record<string,string>={};
    for(const role of ['admin','user']){const id=randomUUID(),token=newToken();users.push(id);await pool.query("INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'Embedded test',$3,'unused')",[id,`${id}@example.com`,role]);await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[digest(token),id]);cookies[role]=`traffic_session=${token}`;}
    await pool.query("INSERT INTO intersections(id,name,location) VALUES($1,'Wokwi test','Test')",[intersectionId]);
    assert.equal((await call('/devices')).status,401);assert.equal((await call('/devices',cookies.user)).status,403);
    const enroll=await call('/devices',cookies.admin,{intersectionId,name:'ESP32 test'});assert.equal(enroll.status,201);
    const credential=await enroll.json();
    assert.equal((await pool.query('SELECT token_hash FROM embedded_devices WHERE id=$1',[credential.deviceId])).rows[0].token_hash,digest(credential.token));
    const path=`/devices/${credential.deviceId}/queue`,firstRequest=randomUUID();
    const first=await call(path,cookies.admin,{redAxis:'north_south',redSeconds:10,requestId:firstRequest});assert.equal(first.status,201);const a=(await first.json()).command;
    assert.equal((await call(path,cookies.admin,{redAxis:'north_south',redSeconds:10,requestId:firstRequest})).status,200);
    assert.equal((await call(path,cookies.admin,{redAxis:'north_south',redSeconds:180,requestId:firstRequest})).status,409);
    assert.equal((await call(path,cookies.admin,{redAxis:'north_south',redSeconds:20,requestId:randomUUID()})).status,409);
    assert.equal((await call(path,cookies.admin,{redAxis:'east_west',redSeconds:9,requestId:randomUUID()})).status,400);
    const b=(await (await call(path,cookies.admin,{redAxis:'east_west',redSeconds:30,requestId:randomUUID()})).json()).command;
    let report={deviceId:credential.deviceId,bootId:'a'.repeat(32),phase:'waiting',activeId:null as number|null,completedId:0,remainingMs:0};
    const exchange=(token=credential.token)=>fetch(base+'/exchange',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(report)});
    assert.equal((await exchange('0'.repeat(64))).status,401);
    assert.equal((await (await exchange()).json()).next.id,a.id);
    assert.equal((await (await exchange()).json()).next.id,a.id,'Lost response must resend the same command');
    report={...report,phase:'green',activeId:a.id,remainingMs:9000};
    let response=await exchange();assert.equal(response.status,200);assert.equal((await response.json()).next.id,b.id);
    const c=(await (await call(path,cookies.admin,{redAxis:'north_south',redSeconds:20,requestId:randomUUID()})).json()).command;
    report.remainingMs=4000;const next=(await (await exchange()).json()).next;assert.equal(next.id,b.id);assert.equal(next.redSeconds,30);
    assert.equal((await pool.query('SELECT red_seconds FROM embedded_commands WHERE id=$1',[a.id])).rows[0].red_seconds,10);
    report={...report,activeId:b.id,completedId:a.id,remainingMs:30000};assert.equal((await (await exchange()).json()).next.id,c.id);
    await pool.query("UPDATE embedded_devices SET last_seen=now()-interval '15 seconds' WHERE id=$1",[credential.deviceId]);
    const listed=(await (await call('/devices',cookies.admin)).json()).devices.find((row:any)=>row.id===credential.deviceId);assert.equal(listed.online,false);assert.equal(listed.token,undefined);assert.equal(listed.token_hash,undefined);
    const rotated=await (await call(`/devices/${credential.deviceId}/credential`,cookies.admin,{})).json();assert.equal((await exchange()).status,401);
    report={...report,bootId:'b'.repeat(32),phase:'waiting',activeId:null,completedId:0,remainingMs:0};
    response=await exchange(rotated.token);assert.equal(response.status,200);assert.equal((await response.json()).next,null,'Reboot must not replay an old pending phase');
    assert.equal((await pool.query('SELECT status FROM embedded_commands WHERE id=$1',[b.id])).rows[0].status,'aborted');
    const newPhase=await call(path,cookies.admin,{redAxis:'east_west',redSeconds:25,requestId:randomUUID()});assert.equal(newPhase.status,201);
    assert.equal((await call(path,cookies.user,{redAxis:'north_south',redSeconds:25,requestId:randomUUID()})).status,403);
  } finally {
    await pool.query('DELETE FROM intersections WHERE id=$1',[intersectionId]);await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);
    await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();
  }
});
