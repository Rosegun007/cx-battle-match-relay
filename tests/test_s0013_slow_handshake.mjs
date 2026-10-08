import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const src=path.resolve(dir,'../src/index.js');
const clientFile=process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(dir,'handshake_client_functions.txt');
const original=await fs.readFile(src,'utf8');
const html=await fs.readFile(clientFile,'utf8');
const tmp=path.resolve(dir,'../src/__handshake_temp.mjs');
await fs.writeFile(tmp,original.replace('import { DurableObject } from "cloudflare:workers";','class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}'));
let CXMatchHub;
try{({CXMatchHub}=await import(pathToFileURL(tmp).href+'?integration=1'));}finally{await fs.unlink(tmp)}
let clockMs=1700000000000,checks=0;
const oldNow=Date.now;Date.now=()=>clockMs;
const ok=(x,name)=>{assert.ok(x,name);console.log('PASS '+(++checks)+' '+name);};
class FakeSocket{
 constructor(){this.messages=[];this.closed=false;this.attachment=null;}
 send(v){if(this.closed)throw Error('closed');this.messages.push(JSON.parse(v));}
 serializeAttachment(s){this.attachment=structuredClone(s)}
 deserializeAttachment(){return this.attachment}
 close(){this.closed=true}
}
globalThis.WebSocketRequestResponsePair=class{};
globalThis.WebSocketPair=class{constructor(){this[0]=new FakeSocket();this[1]=new FakeSocket();}};
globalThis.Response=class{constructor(body,opts){this.body=body;this.opts=opts;}};
const mem=new Map();let alarm;
const ctx={accepted:[],getWebSockets(){return[]},acceptWebSocket(s){this.accepted.push(s)},setWebSocketAutoResponse(){},storage:{async get(k){return mem.get(k)},async put(k,v){mem.set(k,structuredClone(v))},async delete(k){mem.delete(k)},async list({prefix}={}){return new Map([...mem.entries()].filter(([k])=>!prefix||k.startsWith(prefix)))},async getAlarm(){return alarm??null},async setAlarm(v){alarm=v}}};
const hub=new CXMatchHub(ctx,{});
const first=html.indexOf('      function startOnlineClockProbe('),last=html.indexOf('      function refreshOnlineUI()',first);
assert(first>=0);
const code=last>first?html.slice(first,last):html.slice(first,html.indexOf('      function sendHeartbeatS8(',first));
const hbFirst=html.indexOf('      function sendHeartbeatS8('),hbLast=html.indexOf('      function handleHeartbeatS8(',hbFirst);
assert(hbFirst>=0);
const hbCode=hbLast>hbFirst?html.slice(hbFirst,hbLast):html.slice(hbFirst);
function fakeClient(ws){
 const outgoing=[];
 const sim={
  online:{status:'connecting',connectionGeneration:1,probeCount:0,ws:{readyState:1},bestClockRtt:Infinity},
  cxNet20361:{lastBeatPerf:-Infinity,params:{waitingHeartbeatMs:10000,heartbeatMs:1000},beats:new Map(),failed:false,complete:false},
  WebSocket:{OPEN:1},performance:{now:()=>clockMs},Date,Number,Math,crypto,
  CX_WIRE_20361:'CX_ORDERED_RELAY_S0013_V1',CX_SIMULATION_439:'CX_SIM_30HZ_ORDERED_INPUT_439_V1',CX_RULE_VERSION:'S0005-0455',liveDeploySpeedTierCount:3,
  onlineSend:d=>{outgoing.push(d);return true},startHeartbeatTimerS8:g=>{sim.started=(sim.started||0)+1},orderedOnline20361:()=>true
 };
 vm.createContext(sim);vm.runInContext(code+hbCode,sim);
 return {ws,sim,outgoing,seen:[],serverErrors:[],probeEvents:0,slowMs:430};
}
async function processOne(c,p){
 c.seen.push(p.op);if(p.op==='error'){c.serverErrors.push(p.code);return}
 switch(p.op){
 case 'connected':ok(p.wireProtocol===c.sim.CX_WIRE_20361,'server/client WIRE agree');c.sim.online.status='connected';c.sim.startOnlineClockProbe();break;
 case 'clock_probe':
  c.probeEvents++;
  // 430ms per probe, so 3 probes cannot complete within one second.
  clockMs+=c.slowMs;
  // Client timer and foreground-triggered heartbeat must not intrude on probing.
  c.sim.sendHeartbeatS8(true);
  ok(!c.outgoing.some(q=>q.op==='heartbeat'),'no premature heartbeat during probe '+p.seq);
  c.sim.replyServerClockProbeS11(p);
  break;
 case 'clock_probe_result':c.sim.handleServerClockResultS11(p);break;
 case 'clock_probe_complete':c.sim.completeServerClockProbeS11(p);break;
 case 'queued':c.sim.online.status='waiting';break;
 case 'heartbeat':break;
 case 'match_found':c.sim.online.status='matched';break;
 }
}
async function drain(c,stopAtQueued=false){
 for(let rounds=0;rounds<40;rounds++){
  let progressed=false;
  while(c.ws.messages.length){const packet=c.ws.messages.shift();await processOne(c,packet);progressed=true;}
  while(c.outgoing.length){await hub.webSocketMessage(c.ws,JSON.stringify(c.outgoing.shift()));progressed=true;}
  if(!progressed)break;
 }
 if(stopAtQueued)ok(c.sim.online.status==='waiting','client entered Waiting');
}
try{
 await hub.fetch();const a=fakeClient(ctx.accepted.at(-1));
 // Explicit regression: even if a legacy client sends a heartbeat mid-probe, server must not reject it.
 await hub.webSocketMessage(a.ws,JSON.stringify({op:'heartbeat',id:9}));
 ok(a.ws.messages.some(x=>x.op==='heartbeat'&&x.status==='probing'),'probing heartbeat accepted as harmless keepalive');
 ok(!a.ws.messages.some(x=>x.op==='error'),'probing heartbeat did not cause protocol error');
 await drain(a,true);
 ok(a.probeEvents===3&&a.sim.online.probeCount===3,'all 3 genuine client probe replies processed');
 ok(a.sim.started===1,'ordinary heartbeat timer started only after 3 successful probes');
 ok(a.serverErrors.length===0,'no server handshake errors');
 await hub.fetch();const b=fakeClient(ctx.accepted.at(-1));await drain(b);
 await drain(a);
 ok(b.probeEvents===3&&b.sim.started===1,'second client three-probe handshake completed');
 ok(a.sim.online.status==='matched'&&b.sim.online.status==='matched','2 clients advanced from Waiting to match_found');
 ok(a.serverErrors.length===0&&b.serverErrors.length===0,'end-to-end handshake stayed error-free');
 console.log('RESULT: '+checks+'/'+checks+' passed; each 3-probe handshake was 1290ms');
}finally{Date.now=oldNow}
