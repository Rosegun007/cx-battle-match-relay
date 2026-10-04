import { DurableObject } from "cloudflare:workers";
const SERVICE_VERSION='S0009', WIRE='CX_ORDERED_RELAY_S0009_V1', CORE='CX_SIM_30HZ_ORDERED_INPUT_439_V1';
const HUB_NAME='cx-global-match-hub-s0009', ROOM_PREFIX='room:', MAX_PENDING=32;
const PARAMS=Object.freeze({heartbeatMs:1000,connectionTimeoutMs:3000,waitingHeartbeatMs:10000,waitingTimeoutMs:30000,forwardReserveTicks:6,receiveMarginTicks:2,ackGraceTicks:30,maxClockLagTicks:60,proofTimeoutMs:15000});
const isHash=h=>typeof h==='string'&&/^[0-9a-f]{16}$/.test(h);
const json=d=>new Response(JSON.stringify(d),{headers:{'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':'*'}});
export default {async fetch(request,env){
 const u=new URL(request.url);
 if(u.pathname==='/ws'){
  if(request.method!=='GET'||request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('Expected WebSocket upgrade',{status:426});
  return env.CX_MATCH_HUB.getByName(HUB_NAME).fetch(request);
 }
 return json({ok:true,serviceVersion:SERVICE_VERSION,wireProtocol:WIRE,simulationProtocol:CORE,tickRate:30,parameters:PARAMS,serverNow:Date.now()});
}};
export class CXMatchHub extends DurableObject {
 constructor(ctx,env){
  super(ctx,env);this.sessions=new Map();this.serial=Promise.resolve();
  for(const ws of ctx.getWebSockets()){
   const s=ws.deserializeAttachment();
   if(s&&s.status!=='spent')this.sessions.set(ws,s);
   else try{ws.close(1000,'session-ended');}catch{}
  }
  ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
 }
 setSession(ws,s){this.sessions.set(ws,s);ws.serializeAttachment(s);}
 send(ws,p){try{ws.send(JSON.stringify(p));return true;}catch{return false;}}
 error(ws,code){this.send(ws,{op:'error',code,serviceVersion:SERVICE_VERSION});}
 retire(ws){
  const s=this.sessions.get(ws);if(s)this.setSession(ws,{...s,status:'spent',roomId:null,team:null,progress:null});
  this.sessions.delete(ws);try{ws.close(1000,'session-ended');}catch{}
 }
 async arm(){
  const active=[...this.sessions.values()].filter(s=>s.status==='matched'||s.status==='waiting');if(!active.length)return;
  const at=Date.now()+(active.some(s=>s.status==='matched')?1000:10000),old=await this.ctx.storage.getAlarm();
  if(old===null||old>at)await this.ctx.storage.setAlarm(at);
 }
 async fetch(){
  const [client,server]=Object.values(new WebSocketPair());this.ctx.acceptWebSocket(server);
  this.setSession(server,{sessionId:crypto.randomUUID(),status:'idle',roomId:null,team:null,played:false,lastSeen:Date.now(),progress:null});
  this.send(server,{op:'connected',serviceVersion:SERVICE_VERSION,wireProtocol:WIRE,simulationProtocol:CORE,parameters:PARAMS,serverNow:Date.now()});
  return new Response(null,{status:101,webSocket:client});
 }
 webSocketMessage(ws,message){const t=this.serial.then(()=>this.message(ws,message));this.serial=t.catch(()=>{});return t;}
 validProgress(p){return p&&Number.isInteger(p.tick)&&p.tick>=0&&p.tick<=5400&&Number.isSafeInteger(p.seq)&&p.seq>=0&&p.seq<=1000000&&Number.isSafeInteger(p.ack_seq)&&p.ack_seq>=0&&p.ack_seq<=1000000&&typeof p.ended==='boolean';}
 // Only compare client-supplied digests. No simulation or gameplay validation runs here.
 acceptProof(room,team,d){
  const v=room.verify,p=d.progress;
  if(d.initHash!=null){
   if(!isHash(d.initHash))return 'invalid-initial-hash';
   if(v.init[team]&&v.init[team]!==d.initHash)return 'initial-hash-conflict';
   v.init[team]=d.initHash;
   if(v.init.blue&&v.init.red){if(v.init.blue!==v.init.red)return 'initial-state-mismatch';v.initConfirmed=true;}
  }
  if(p?.ended){if(v.ends[team]!=null&&v.ends[team]!==p.tick)return 'terminal-tick-conflict';v.ends[team]=p.tick;}
  if(v.ends.blue!=null&&v.ends.red!=null&&v.ends.blue!==v.ends.red)return 'terminal-tick-mismatch';
  const rows=d.checkpoints??[];
  if(!Array.isArray(rows)||rows.length>MAX_PENDING)return 'invalid-checkpoints';
  for(const row of rows){
   if(!p||!row||!Number.isInteger(row.tick)||row.tick<0||row.tick>p.tick||!isHash(row.hash)||!(row.tick<=1||row.tick%30===0||(p.ended&&row.tick===p.tick)))return 'invalid-checkpoint';
   if(row.tick<=v.confirmedTick)continue; // Idempotent retry after an acknowledgement was delayed.
   const old=v.pending[team][row.tick];if(old&&old!==row.hash)return 'checkpoint-conflict';
   v.pending[team][row.tick]=row.hash;
   const peer=v.pending[team==='blue'?'red':'blue'][row.tick];if(peer&&peer!==row.hash)return 'state-mismatch';
  }
  if(Object.keys(v.pending.blue).length>MAX_PENDING||Object.keys(v.pending.red).length>MAX_PENDING)return 'checkpoint-backlog';
  if(v.initConfirmed){
   while(true){
    let next=v.confirmedTick<0?0:v.confirmedTick===0?1:v.confirmedTick===1?30:v.confirmedTick+30;
    if(v.ends.blue!=null&&v.ends.blue===v.ends.red&&v.ends.blue>v.confirmedTick)next=Math.min(next,v.ends.blue);
    if(!v.pending.blue[next]||!v.pending.red[next])break;
    if(v.pending.blue[next]!==v.pending.red[next])return 'state-mismatch';
    delete v.pending.blue[next];delete v.pending.red[next];v.confirmedTick=next;v.lastAdvancedAt=Date.now();
   }
  }
  return null;
 }
 confirmation(room){const v=room.verify;return {initConfirmed:v.initConfirmed,confirmedTick:v.confirmedTick,endTick:v.ends.blue!=null&&v.ends.blue===v.ends.red?v.ends.blue:null};}
 proofExpired(room){return !!room.startAt&&Date.now()>=room.startAt+PARAMS.proofTimeoutMs&&Date.now()-room.verify.lastAdvancedAt>=PARAMS.proofTimeoutMs;}
 async message(ws,message){
  let s=this.sessions.get(ws);if(!s||s.status==='spent')return;
  if(typeof message!=='string'||message.length>65536)return this.error(ws,'invalid-envelope');let d;
  try{d=JSON.parse(message);}catch{return this.error(ws,'bad-json');}
  s={...s,lastSeen:Date.now()};this.setSession(ws,s);
  if(d?.op==='ping'){this.send(ws,{op:'pong',clientNow:d.clientNow,serverNow:Date.now()});return;}
  if(d?.op==='join_queue'){
   if(d.wireProtocol!==WIRE||d.simulationProtocol!==CORE||d.tickRate!==30)return this.error(ws,'protocol-mismatch');
   if(s.played||s.status==='matched')return this.error(ws,'connection-already-used');
   if(s.status!=='waiting')this.setSession(ws,{...s,status:'waiting',roomId:null,team:null,progress:null,ruleVersion:String(d.ruleVersion||''),tier:d.deploySpeedTierCount===4?4:3,queuedAt:Date.now()});
   this.send(ws,{op:'queued'});await this.match();await this.arm();return;
  }
  if(d?.op==='leave_queue'){if(s.status==='waiting')this.setSession(ws,{...s,status:'idle'});return;}
  if(d?.op==='heartbeat'&&s.status!=='matched'){this.send(ws,{op:'heartbeat',id:d.id,status:s.status,serverNow:Date.now()});await this.arm();return;}
  if(s.status!=='matched'||!s.roomId)return this.error(ws,'wrong-room');
  const room=await this.ctx.storage.get(ROOM_PREFIX+s.roomId);if(!room)return this.error(ws,'room-missing');
  if(['abort','leave_room','takeover'].includes(d.op)){await this.closeRoom(room,String(d.reason||'peer-left').slice(0,100));return;}
  if(d.op==='setup'){
   if(room.startAt||room.setup[s.team])return;
   room.setup[s.team]=d.setup;await this.ctx.storage.put(ROOM_PREFIX+room.roomId,room);this.peer(room.roomId,s.team,{op:'peer_ready',team:s.team});
   if(room.setup.blue&&room.setup.red){
    room.startAt=Date.now()+4000;room.verify.lastAdvancedAt=room.startAt;
    await this.ctx.storage.put(ROOM_PREFIX+room.roomId,room);
    this.broadcast(room.roomId,{op:'start_plan',wireProtocol:WIRE,simulationProtocol:CORE,parameters:PARAMS,startAt:room.startAt,setup:room.setup});
   }return;
  }
  const tick_server=room.startAt?Math.max(0,Math.floor((Date.now()-room.startAt)*30/1000)):0;
  if(d.op==='heartbeat'){
   if(d.progress!=null){
    if(!this.validProgress(d.progress))return this.error(ws,'invalid-progress');
    if(s.progress&&(d.progress.tick<s.progress.tick||d.progress.seq<s.progress.seq||d.progress.ack_seq<s.progress.ack_seq))return this.error(ws,'regressed-progress');
    s={...s,progress:d.progress};this.setSession(ws,s);
   }
   const peer=[...this.sessions.values()].find(v=>v.roomId===s.roomId&&v.team!==s.team);
   if(!peer||Date.now()-peer.lastSeen>=PARAMS.connectionTimeoutMs){await this.closeRoom(room,'peer-timeout');return;}
   const problem=this.acceptProof(room,s.team,d);
   if(problem){await this.closeRoom(room,problem);return;}
   const confirmation=this.confirmation(room);
   if(confirmation.endTick!=null&&confirmation.confirmedTick===confirmation.endTick){await this.closeRoom(room,'verified-complete','finished',confirmation);return;}
   if(this.proofExpired(room)){await this.closeRoom(room,'checkpoint-timeout');return;}
   await this.ctx.storage.put(ROOM_PREFIX+room.roomId,room);
   this.send(ws,{op:'heartbeat',id:d.id,status:'matched',serverNow:Date.now(),tick_server,peer:peer.progress,...confirmation});
   await this.arm();return;
  }
  if(d.op==='relay'&&room.startAt){
   const p=d.payload;if(!['input','ack'].includes(p?.kind))return this.error(ws,'unknown-relay-kind');
   if(p.kind==='input'){
    const c=p.command,w=p.windup_ticks;
    if(!c||c.team!==s.team||!Number.isInteger(c.tick)||c.tick<1||!Number.isInteger(w)||w<1||w>900)return this.error(ws,'invalid-input-envelope');
    if(tick_server+PARAMS.forwardReserveTicks>c.tick+w-PARAMS.receiveMarginTicks){await this.closeRoom(room,'forward-deadline');return;}
   }
   if(p.kind==='ack'&&(!Number.isSafeInteger(p.ack_seq)||p.ack_seq<0))return this.error(ws,'invalid-ack');
   if(!this.peer(room.roomId,s.team,{op:'relay',team:s.team,tick_server,payload:p}))await this.closeRoom(room,'peer-unavailable');return;
  }
  this.error(ws,'unexpected-message');
 }
 async match(){
  const e=[...this.sessions].filter(([,s])=>s.status==='waiting'&&!s.played&&Date.now()-s.lastSeen<PARAMS.waitingTimeoutMs).sort((a,b)=>a[1].queuedAt-b[1].queuedAt);
  while(e.length>1){
   const a=e.shift(),i=e.findIndex(([,s])=>s.ruleVersion===a[1].ruleVersion&&s.tier===a[1].tier);if(i<0)continue;
   const b=e.splice(i,1)[0],roomId='CX_'+crypto.randomUUID(),words=new Uint32Array(1);do{crypto.getRandomValues(words);}while(!words[0]);
   const now=Date.now(),room={roomId,matchSeed:words[0],createdAt:now,prepDeadline:now+27000,startAt:null,setup:{blue:null,red:null},verify:{init:{},initConfirmed:false,confirmedTick:-1,pending:{blue:{},red:{}},ends:{},lastAdvancedAt:now}};
   await this.ctx.storage.put(ROOM_PREFIX+roomId,room);
   for(const [[ws,s],team]of [[a,'blue'],[b,'red']])this.setSession(ws,{...s,status:'matched',played:true,roomId,team,lastSeen:now,progress:null});
   for(const [[ws],team]of [[a,'blue'],[b,'red']])this.send(ws,{op:'match_found',roomId,team,matchSeed:room.matchSeed,serverNow:now,prepDeadline:room.prepDeadline,wireProtocol:WIRE,simulationProtocol:CORE,tickRate:30,parameters:PARAMS});
  }
 }
 peer(roomId,team,p){let ok=false;for(const [ws,s]of this.sessions)if(s.status==='matched'&&s.roomId===roomId&&s.team!==team)ok=this.send(ws,p)||ok;return ok;}
 broadcast(roomId,p){for(const [ws,s]of this.sessions)if(s.status==='matched'&&s.roomId===roomId)this.send(ws,p);}
 async closeRoom(room,reason,transition='pve',extra={}){
  this.broadcast(room.roomId,{op:'room_closed',reason,transition,...extra});
  for(const [ws,s]of [...this.sessions])if(s.roomId===room.roomId)this.retire(ws);
  await this.ctx.storage.delete(ROOM_PREFIX+room.roomId);
 }
 webSocketClose(ws){const t=this.serial.then(async()=>{
  const s=this.sessions.get(ws)||ws.deserializeAttachment();this.retire(ws);
  if(s?.roomId){const r=await this.ctx.storage.get(ROOM_PREFIX+s.roomId);if(r)await this.closeRoom(r,'peer-disconnected');}
 });this.serial=t.catch(()=>{});return t;}
 webSocketError(ws){return this.webSocketClose(ws);}
 alarm(){const t=this.serial.then(async()=>{
  const now=Date.now();
  for(const [ws,s]of [...this.sessions]){
   if(s.status==='matched'&&now-s.lastSeen>=PARAMS.connectionTimeoutMs){const r=await this.ctx.storage.get(ROOM_PREFIX+s.roomId);if(r)await this.closeRoom(r,'connection-timeout');}
   else if(s.status==='waiting'&&now-s.lastSeen>=PARAMS.waitingTimeoutMs){this.send(ws,{op:'queue_expired'});this.retire(ws);}
  }
  const rows=await this.ctx.storage.list({prefix:ROOM_PREFIX});
  for(const r of rows.values()){
   if(this.proofExpired(r))await this.closeRoom(r,'checkpoint-timeout');
   else if(now-r.createdAt>=240000)await this.closeRoom(r,'room-expired');
  }
  await this.arm();
 });this.serial=t.catch(()=>{});return t;}
}
