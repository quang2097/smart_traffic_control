import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pool } from '../db.js';
import { hashPassword } from '../security.js';

const id=randomUUID(), intersectionId=randomUUID(), email=`embedded-ui-${id}@example.com`, password='Embedded UI fixture password!';
const gateway=express(); let api: typeof import('../app.js')['app'] | undefined;
gateway.use((req,res,next)=>{if(req.path.startsWith('/api/')){if(api)api(req,res,next);else res.sendStatus(503);}else next();});
gateway.use(express.static(fileURLToPath(new URL('../../../frontend/dist/',import.meta.url))));
const server=createServer(gateway);let stopping=false;
async function stop(){if(stopping)return;stopping=true;try{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.query('DELETE FROM intersections WHERE id=$1',[intersectionId]);await pool.query('DELETE FROM users WHERE id=$1',[id]);}finally{await pool.end();process.exit();}}
process.on('message',message=>{if(message==='stop')void stop();});process.on('disconnect',()=>{void stop();});
try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No test port');
  const origin=`http://127.0.0.1:${address.port}`;process.env.NODE_ENV='development';process.env.APP_URL=origin;
  await pool.query("INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'ESP32 UI TEST','admin',$3)",[id,email,await hashPassword(password)]);
  await pool.query("INSERT INTO intersections(id,name,location) VALUES($1,'Wokwi UI TEST','Simulation')",[intersectionId]);
  api=(await import('../app.js')).app;process.send?.({origin,email,password,intersectionId});
}catch(error){process.send?.({error:(error as Error).message});await stop();}
