import { DurableObject } from "cloudflare:workers";
const SERVICE_VERSION = "S0007";
const WIRE = "CX_ORDERED_RELAY_2036_V1";
const CORE = "CX_SIM_30HZ_ORDERED_INPUT_439_V1";
const HUB_NAME = "cx-global-match-hub-2036-v1";
const ROOM_PREFIX = "room:";
const json = (data,status=200) => new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json","cache-control":"no-store","access-control-allow-origin":"*"}});
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/ws'){
      if(request.method!=='GET'||request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('Expected WebSocket upgrade',{status:426});
      return env.CX_MATCH_HUB.getByName(HUB_NAME).fetch(request);
    }
    return json({ok:true,service:'cx-battle-match-relay',serviceVersion:SERVICE_VERSION,wireProtocol:WIRE,simulationProtocol:CORE,tickRate:30,serverNow:Date.now()});
  }
};
export class CXMatchHub extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);this.sessions=new Map();
    for(const ws of ctx.getWebSockets()){const s=ws.deserializeAttachment();if(s)this.sessions.set(ws,s);}
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
    // Serialize room metadata changes across asynchronous storage calls.
    this.serial=Promise.resolve();
  }
  setSession(ws,s){this.sessions.set(ws,s);ws.serializeAttachment(s);}
  send(ws,p){try{ws.send(JSON.stringify(p));return true;}catch{return false;}}
  error(ws,code){this.send(ws,{op:'error',code,serviceVersion:SERVICE_VERSION});}
  async fetch(){
    const [client,server]=Object.values(new WebSocketPair());this.ctx.acceptWebSocket(server);
    this.setSession(server,{sessionId:crypto.randomUUID(),status:'idle',roomId:null,team:null});
    this.send(server,{op:'connected',serviceVersion:SERVICE_VERSION,wireProtocol:WIRE,simulationProtocol:CORE,serverNow:Date.now()});
    return new Response(null,{status:101,webSocket:client});
  }
  webSocketMessage(ws,message){const task=this.serial.then(()=>this.message(ws,message));this.serial=task.catch(()=>{});return task;}
  async message(ws,message){
    if(typeof message!=='string'||message.length>65536)return this.error(ws,'invalid-envelope');
    let d;try{d=JSON.parse(message);}catch{return this.error(ws,'bad-json');}
    const s=this.sessions.get(ws);if(!s)return;
    if(d?.op==='ping'){this.send(ws,{op:'pong',clientNow:d.clientNow,serverNow:Date.now()});return;}
    if(d?.op==='join_queue'){
      if(d.wireProtocol!==WIRE||d.simulationProtocol!==CORE||d.tickRate!==30)return this.error(ws,'protocol-mismatch');
      if(s.status==='matched')return this.error(ws,'already-matched');
      if(s.status!=='waiting')this.setSession(ws,{...s,status:'waiting',ruleVersion:String(d.ruleVersion||''),tier:d.deploySpeedTierCount===4?4:3,queuedAt:Date.now()});
      this.send(ws,{op:'queued'});await this.match();return;
    }
    if(d?.op==='leave_queue'){if(s.status==='waiting')this.setSession(ws,{...s,status:'idle'});return;}
    if(s.status!=='matched'||!s.roomId||d.roomId!==s.roomId)return this.error(ws,'wrong-room');
    const room=await this.ctx.storage.get(ROOM_PREFIX+s.roomId);if(!room)return this.error(ws,'room-missing');
    if(d.op==='leave_room'||d.op==='abort'){await this.closeRoom(room,String(d.reason||'peer-left').slice(0,100));return;}
    if(d.op==='setup'){
      if(room.startAt||room.setup[s.team])return; // Final per-player commitment, not mutable thereafter.
      room.setup[s.team]=d.setup;await this.ctx.storage.put(ROOM_PREFIX+room.roomId,room);
      this.peer(room.roomId,s.team,{op:'peer_ready',roomId:room.roomId,team:s.team});
      if(room.setup.blue&&room.setup.red){
        room.startAt=Date.now()+4000;await this.ctx.storage.put(ROOM_PREFIX+room.roomId,room);
        this.broadcast(room.roomId,{op:'start_plan',roomId:room.roomId,wireProtocol:WIRE,simulationProtocol:CORE,startAt:room.startAt,setup:room.setup});
      }
      return;
    }
    // No unit/cost/placement/hash adjudication, server timestamps, re-ticking or sender echo.
    if(d.op==='relay'&&room.startAt){
      if(!['init','input','seal','checkpoint'].includes(d.payload?.kind))return this.error(ws,'unknown-relay-kind');
      if(!this.peer(room.roomId,s.team,{op:'relay',roomId:room.roomId,team:s.team,payload:d.payload}))await this.closeRoom(room,'peer-unavailable');
      return;
    }
    this.error(ws,'unexpected-message');
  }
  async match(){
    const entries=[...this.sessions].filter(([,s])=>s.status==='waiting').sort((a,b)=>a[1].queuedAt-b[1].queuedAt);
    while(entries.length>1){
      const a=entries.shift(),i=entries.findIndex(([,s])=>s.ruleVersion===a[1].ruleVersion&&s.tier===a[1].tier);if(i<0)continue;
      const b=entries.splice(i,1)[0],roomId='CX_'+crypto.randomUUID(),words=new Uint32Array(1);do{crypto.getRandomValues(words);}while(!words[0]);
      const now=Date.now(),room={roomId,matchSeed:words[0],createdAt:now,prepDeadline:now+27000,startAt:null,setup:{blue:null,red:null}};
      await this.ctx.storage.put(ROOM_PREFIX+roomId,room);
      for(const [[ws,s],team]of [[a,'blue'],[b,'red']])this.setSession(ws,{...s,status:'matched',roomId,team});
      for(const [[ws],team]of [[a,'blue'],[b,'red']])this.send(ws,{op:'match_found',roomId,team,matchSeed:room.matchSeed,serverNow:now,prepDeadline:room.prepDeadline,wireProtocol:WIRE,simulationProtocol:CORE,tickRate:30});
      // Cleanup abandoned persisted rooms, including silent disconnections during hibernation.
      await this.ctx.storage.setAlarm(now+240000);
    }
  }
  peer(roomId,team,p){let ok=false;for(const [ws,s]of this.sessions)if(s.status==='matched'&&s.roomId===roomId&&s.team!==team)ok=this.send(ws,p)||ok;return ok;}
  broadcast(roomId,p){for(const [ws,s]of this.sessions)if(s.status==='matched'&&s.roomId===roomId)this.send(ws,p);}
  async closeRoom(room,reason){
    this.broadcast(room.roomId,{op:'room_closed',roomId:room.roomId,reason});
    for(const [ws,s]of this.sessions)if(s.roomId===room.roomId)this.setSession(ws,{...s,status:'idle',roomId:null,team:null});
    await this.ctx.storage.delete(ROOM_PREFIX+room.roomId);
  }
  webSocketClose(ws){const task=this.serial.then(async()=>{const s=this.sessions.get(ws)||ws.deserializeAttachment();this.sessions.delete(ws);if(s?.roomId){const room=await this.ctx.storage.get(ROOM_PREFIX+s.roomId);if(room)await this.closeRoom(room,'peer-disconnected');}});this.serial=task.catch(()=>{});return task;}
  webSocketError(ws){return this.webSocketClose(ws);}
  alarm(){const task=this.serial.then(async()=>{const rows=await this.ctx.storage.list({prefix:ROOM_PREFIX});for(const room of rows.values())if(Date.now()-room.createdAt>=240000)await this.closeRoom(room,'room-expired');if((await this.ctx.storage.list({prefix:ROOM_PREFIX})).size)await this.ctx.storage.setAlarm(Date.now()+60000);});this.serial=task.catch(()=>{});return task;}
}
