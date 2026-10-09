import { DurableObject } from "cloudflare:workers";
// CX对战 S0015：仅包含无需运行战斗引擎的权威通信窗口与责任分摊。
// 必须与客户端 DEPLOY_MODE_RULES / BATTLE_FLAG_CONFIG 保持一致；升级战斗规则时同步审计。
const TICK_RATE = 30;
const DEPLOY_SECONDS = Object.freeze({
  melee: Object.freeze({ slow:6, normal:4, fast:2, ultra:10 }),
  ranged: Object.freeze({ slow:8, normal:5, fast:2, ultra:13 }),
  tank: Object.freeze({ slow:9, normal:6, fast:3, ultra:20 }),
  turret: Object.freeze({ slow:9, normal:6, fast:3, ultra:17 })
});
const FLAG_WINDUP_TICKS = Math.round(2.307692308 * TICK_RATE); // 69
const FLAG_TYPES = Object.freeze(['arrowRain','fireballRain','healing']);
function authoritativeWindupTicks(c,tier=3){
  if(!c||typeof c!=='object')return null;
  if(c.kind==='deploy'){
    if(tier!==4&&c.mode==='ultra')return null;
    const seconds=DEPLOY_SECONDS[c.unit]?.[c.mode];
    return Number.isInteger(seconds)?seconds*TICK_RATE:null;
  }
  return c.kind==='flag'&&FLAG_TYPES.includes(c.type)?FLAG_WINDUP_TICKS:null;
}
function legalWindowTicks(windupTicks){
  return Number.isSafeInteger(windupTicks)&&windupTicks>0?Math.floor(windupTicks*4/5):null;
}
// same server clock startAt, authoritative receive and forward timestamps in integer ticks
function serverTick(atMs,startAt){return Math.max(0,Math.floor((atMs-startAt)*TICK_RATE/1000));}
function delayResponsibility({team,tick,w,receiveTick,forwardTick}){
  const a=Math.min(w,Math.max(0,receiveTick-tick));
  const s=Math.min(w-a,Math.max(0,forwardTick-receiveTick));
  const b=w-a-s;
  const responsibleTeam=2*a>w?team:2*b>w?(team==='blue'?'red':'blue'):null;
  return {a,s,b,w,responsibleTeam};
}
function validInputEnvelope(c,team,tier=3){
  if(!c||c.team!==team||!Number.isSafeInteger(c.seq)||c.seq<1||c.seq>1000000||c.id!==`${team}:${c.seq}`||!Number.isInteger(c.tick)||c.tick<1||c.tick>5400||!Array.isArray(c.cell)||c.cell.length!==2||!c.cell.every(Number.isInteger))return false;
  const [x,y]=c.cell;
  if(x<0||x>=18||y<0||y>=32)return false;
  if(c.kind==='flag'&&(y===15||y===16||!['corner','center'].includes(c.anchorKind)))return false;
  return authoritativeWindupTicks(c,tier)!=null;
}

const SERVICE_VERSION='S0015', WIRE='CX_ORDERED_RELAY_S0015_V1', CORE='CX_SIM_30HZ_ORDERED_INPUT_439_V1';
const HUB_NAME='cx-global-match-hub-s0010', ROOM_PREFIX='room:', CASE_PREFIX='disconnect-evidence:', MAX_PENDING=32;
const PARAMS=Object.freeze({heartbeatMs:1000,connectionTimeoutMs:3000,waitingHeartbeatMs:10000,waitingTimeoutMs:30000,forwardReserveTicks:0,receiveMarginTicks:0,legalWindowPercent:80,ackGraceTicks:30,maxClockLagTicks:60,maxInputFutureTicks:12,proofTimeoutMs:15000,prepTicks:900,lockTicks:90,probeCount:3,disconnectObserveMs:1000,heartbeatAckTimeoutMs:3000,probeTimeoutMs:10000,disconnectForfeitAfterSeconds:60});
// S0015: D1 stores one keyed JSON document. Only the explicitly mutable transport fields
// can override code defaults; protocol/simulation/80%-windup invariants cannot change via D1.
const MUTABLE_LIMITS=Object.freeze({
 heartbeatMs:[500,3000],connectionTimeoutMs:[2000,20000],waitingHeartbeatMs:[1000,30000],
 waitingTimeoutMs:[10000,120000],heartbeatAckTimeoutMs:[2000,20000],
 disconnectObserveMs:[500,10000],proofTimeoutMs:[10000,60000],probeTimeoutMs:[5000,30000],
 disconnectForfeitAfterSeconds:[1,180]
});
function validateDbSettings(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('settings-not-an-object');
 const result={...PARAMS};
 for(const [key,value] of Object.entries(raw)){
  if(!Object.hasOwn(PARAMS,key))throw Error('unknown-setting:'+key);
  if(!Number.isSafeInteger(value))throw Error('invalid-number:'+key);
  const lim=MUTABLE_LIMITS[key];
  if(lim){if(value<lim[0]||value>lim[1])throw Error('out-of-range:'+key);result[key]=value;}
  else if(value!==PARAMS[key])throw Error('locked-setting:'+key);
 }
 if(result.connectionTimeoutMs<result.heartbeatMs*2||result.heartbeatAckTimeoutMs<result.heartbeatMs*2||result.waitingTimeoutMs<result.waitingHeartbeatMs*2)throw Error('inconsistent-heartbeat-timeouts');
 return Object.freeze(result);
}
async function loadServerSettings(db){
 if(!db)return {params:PARAMS,revision:0,source:'code-default',warning:'d1-not-configured'};
 try{
  const row=await db.prepare('SELECT settings_json,revision FROM server_settings WHERE config_key=?').bind('active').first();
  if(!row)return {params:PARAMS,revision:0,source:'code-default',warning:'settings-row-not-found'};
  const parsed=JSON.parse(row.settings_json);
  const params=validateDbSettings(parsed);
  return {params,revision:Number(row.revision)||0,source:'d1',warning:null};
 }catch(err){console.error('settings-load',String(err));return {params:PARAMS,revision:0,source:'code-default',warning:String(err).slice(0,160)};}
}

const isHash=h=>typeof h==='string'&&/^[0-9a-f]{16}$/.test(h);
// S0014: provisional four-account D1 login. A shared test password is NOT production authentication.
const TEST_PASSWORD_SHA256 = '8901345041f528cf98d149bcd4134f634b4a4abd7a4f3c847703204eecbab7b0';
const TEST_SESSION_MS = 12*60*60*1000;
const TEST_ACCOUNT_RE = /^test00[1-4]$/;
const authHeaders={'content-type':'application/json;charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*','access-control-allow-methods':'POST,OPTIONS','access-control-allow-headers':'content-type','vary':'Origin'};
const authJson=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:authHeaders});
async function sha256Hex(text){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');}
async function testAccountLogin(request,env){
 if(!env.CX_PLAYERS_DB)return authJson({ok:false,error:'d1-not-configured'},503);
 let d;try{if(Number(request.headers.get('content-length')||0)>4096)return authJson({ok:false,error:'invalid-request'},400);d=await request.json();}catch{return authJson({ok:false,error:'invalid-request'},400);}
 const user=String(d?.user||'');const pw=String(d?.pw||'');
 if(!TEST_ACCOUNT_RE.test(user)||pw.length>128||(await sha256Hex(pw))!==TEST_PASSWORD_SHA256)return authJson({ok:false,error:'invalid-credentials'},401);
 try{
  const player=await env.CX_PLAYERS_DB.prepare('SELECT player_id,username,nickname,account_status FROM players WHERE username=?').bind(user).first();
  if(!player||player.account_status!=='active')return authJson({ok:false,error:'account-unavailable'},403);
  const secret=crypto.getRandomValues(new Uint8Array(32));const token=Array.from(secret,x=>x.toString(16).padStart(2,'0')).join('');
  const hash=await sha256Hex(token);const now=Date.now(),expiresAt=now+TEST_SESSION_MS;
  await env.CX_PLAYERS_DB.batch([
   env.CX_PLAYERS_DB.prepare('INSERT INTO player_sessions(token_hash,player_id,created_at,expires_at) VALUES(?,?,?,?)').bind(hash,player.player_id,now,expiresAt),
   env.CX_PLAYERS_DB.prepare('UPDATE players SET last_seen_at=? WHERE player_id=?').bind(now,player.player_id)
  ]);
  return authJson({ok:true,playerId:player.player_id,username:player.username,nickname:player.nickname,token,expiresAt,serviceVersion:SERVICE_VERSION});
 }catch(e){console.error('test-account-login-db',String(e));return authJson({ok:false,error:'database-error'},503);}
}
async function verifyTestSession(env,token){
 if(!env.CX_PLAYERS_DB||typeof token!=='string'||!/^[0-9a-f]{64}$/.test(token))return null;
 const tokenHash=await sha256Hex(token);
 const player=await env.CX_PLAYERS_DB.prepare(`SELECT p.player_id,p.username,p.nickname FROM player_sessions s JOIN players p ON p.player_id=s.player_id WHERE s.token_hash=? AND s.expires_at>? AND p.account_status='active'`).bind(tokenHash,Date.now()).first();
 return player||null;
}


// S0015: authenticated one-match result lookup lets a disconnected client recover
// the server verdict via HTTPS after its WebSocket can no longer receive it.
async function lookupMyMatchResult(request,env){
 if(!env.CX_PLAYERS_DB)return authJson({ok:false,error:'d1-not-configured'},503);
 let d;try{if(Number(request.headers.get('content-length')||0)>4096)return authJson({ok:false,error:'invalid-request'},400);d=await request.json();}catch{return authJson({ok:false,error:'invalid-request'},400);}
 const roomId=d?.roomId;
 if(typeof roomId!=='string'||!/^CX_[a-fA-F0-9-]{30,50}$/.test(roomId))return authJson({ok:false,error:'invalid-room'},400);
 try{
  const player=await verifyTestSession(env,d.token);
  if(!player)return authJson({ok:false,error:'login-required'},401);
  const row=await env.CX_PLAYERS_DB.prepare(`SELECT match_id,blue_player_id,red_player_id,responsible_player_id,winner_player_id,win_stars,settlement_status FROM matches WHERE match_id=? AND (blue_player_id=? OR red_player_id=?)`).bind(roomId,player.player_id,player.player_id).first();
  if(!row||row.settlement_status!=='settled')return authJson({ok:true,found:false});
  const teams={blue:row.blue_player_id,red:row.red_player_id};
  const responsibleTeam=row.responsible_player_id===teams.blue?'blue':row.responsible_player_id===teams.red?'red':null;
  const winnerTeam=row.winner_player_id===teams.blue?'blue':row.winner_player_id===teams.red?'red':null;
  return authJson({ok:true,found:true,result:{responsibleTeam,winnerTeam,forfeit:!!winnerTeam,stars:row.win_stars,settlementStatus:'settled'}});
 }catch(err){console.error('lookup-match-result',String(err));return authJson({ok:false,error:'database-error'},503);}
}

const json=d=>new Response(JSON.stringify(d),{headers:{'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':'*'}});
export default {async fetch(request,env){
 const u=new URL(request.url);
 if(request.method==='OPTIONS'&&['/api/test-login','/api/match-result'].includes(u.pathname))return new Response(null,{status:204,headers:authHeaders});
 if(u.pathname==='/api/test-login')return request.method==='POST'?testAccountLogin(request,env):authJson({ok:false,error:'method-not-allowed'},405);
 if(u.pathname==='/api/match-result')return request.method==='POST'?lookupMyMatchResult(request,env):authJson({ok:false,error:'method-not-allowed'},405);
 if(u.pathname==='/ws'){
  if(request.method!=='GET'||request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('Expected WebSocket upgrade',{status:426});
  return env.CX_MATCH_HUB.getByName(HUB_NAME).fetch(request);
 }
 // The authoritative hub reports the values actually loaded into its memory (not just D1's newest row).
 const hub=env.CX_MATCH_HUB.getByName(HUB_NAME);
 return hub.fetch(new Request('https://cx-hub.internal/_internal/config-health'));
}};
export class CXMatchHub extends DurableObject {
 constructor(ctx,env){
  super(ctx,env);this.env=env;this.sessions=new Map();this.serial=Promise.resolve();
  this.activeConfig={params:PARAMS,revision:0,source:'code-default',warning:'loading'};
  ctx.blockConcurrencyWhile(async()=>{this.activeConfig=await loadServerSettings(env.CX_PLAYERS_DB);});
  for(const ws of ctx.getWebSockets()){
   const s=ws.deserializeAttachment();
   if(s&&s.status!=='spent')this.sessions.set(ws,s);
   else try{ws.close(1000,'session-ended');}catch{}
  }
  ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
 }
 setSession(ws,s){this.sessions.set(ws,s);ws.serializeAttachment(s);}
 send(ws,p){try{ws.send(JSON.stringify(p));return true;}catch{return false;}}
 params(room=null){return room?.params||this.activeConfig.params;}
 error(ws,code){this.send(ws,{op:'error',code,serviceVersion:SERVICE_VERSION});}
 retire(ws){
  const s=this.sessions.get(ws);if(s)this.setSession(ws,{...s,status:'spent',roomId:null,team:null,progress:null});
  this.sessions.delete(ws);try{ws.close(1000,'session-ended');}catch{}
 }
 async arm(pendingCase=false){
  const active=[...this.sessions.values()].filter(s=>['matched','waiting','probing'].includes(s.status));
  // Both peers may already be disconnected; pending verdict must still be finalized by an Alarm.
  const orphanedCases=pendingCase||(!active.length&&[...(await this.ctx.storage.list({prefix:ROOM_PREFIX})).values()].some(r=>r.disconnectCase));
  if(!active.length&&!orphanedCases)return;
  const at=Date.now()+(orphanedCases?500:active.some(s=>s.status==='matched')?1000:10000),old=await this.ctx.storage.getAlarm();
  if(old===null||old>at)await this.ctx.storage.setAlarm(at);
 }
 async fetch(request){
  if(new URL(request.url).pathname==='/_internal/config-health'){
   const c=this.activeConfig;
   return json({ok:true,serviceVersion:SERVICE_VERSION,wireProtocol:WIRE,simulationProtocol:CORE,tickRate:30,parameters:c.params,configRevision:c.revision,configSource:c.source,configWarning:c.warning,serverNow:Date.now()});
  }
  const [client,server]=Object.values(new WebSocketPair());this.ctx.acceptWebSocket(server);
  const session={sessionId:crypto.randomUUID(),status:'probing',roomId:null,team:null,played:false,lastSeen:Date.now(),probeStartedAt:Date.now(),progress:null,probeRows:[],hbChallenge:null,hbSeq:0,lastHbAckAt:null};
  this.setSession(server,session);
  this.send(server,{op:'connected',sessionId:session.sessionId,serviceVersion:SERVICE_VERSION,wireProtocol:WIRE,simulationProtocol:CORE,parameters:this.activeConfig.params,configRevision:this.activeConfig.revision,serverNow:Date.now()});
  this.sendClockProbe(server,session);
  await this.arm();
  return new Response(null,{status:101,webSocket:client});
 }
 webSocketMessage(ws,message){const receivedAt=Date.now();const t=this.serial.then(()=>this.message(ws,message,receivedAt));this.serial=t.catch(()=>{});return t;}
  // Server-only timestamps measure RTT. Client timestamps are for the client clock estimate, not trusted evidence.
  sendClockProbe(ws,s){
    const seq=s.probeRows.length+1,nonce=crypto.randomUUID(),sentAt=Date.now();
    s={...s,probePending:{seq,nonce,sentAt}};this.setSession(ws,s);
    this.send(ws,{op:'clock_probe',seq,nonce,serverSentAt:sentAt,probeCount:this.params().probeCount});
  }
  acceptClockProbe(ws,s,d,receivedAt){
    const q=s.probePending;
    if(s.status!=='probing'||!q||d.seq!==q.seq||d.nonce!==q.nonce||!Number.isFinite(d.clientReceivedAt)||!Number.isFinite(d.clientSentAt)||d.clientSentAt<d.clientReceivedAt||d.clientSentAt-d.clientReceivedAt>5000)return this.error(ws,'invalid-clock-probe');
    const row={seq:q.seq,serverSentAt:q.sentAt,serverReceivedAt:receivedAt,rttMs:Math.max(0,receivedAt-q.sentAt)};
    s={...s,probePending:null,probeRows:[...s.probeRows,row]};this.setSession(ws,s);
    this.send(ws,{op:'clock_probe_result',seq:q.seq,serverSentAt:q.sentAt,serverReceivedAt:receivedAt,clientReceivedAt:d.clientReceivedAt,clientSentAt:d.clientSentAt,rttMs:row.rttMs});
    if(s.probeRows.length<this.params().probeCount)this.sendClockProbe(ws,s);
    else {
      const bestRttMs=Math.min(...s.probeRows.map(r=>r.rttMs));
      this.setSession(ws,{...s,status:'idle'});
      this.send(ws,{op:'clock_probe_complete',samples:this.params().probeCount,bestRttMs});
    }
  }
  // Challenge is not guessable from a predictable heartbeat counter.
  verifyHeartbeatAck(ws,s,ack,receivedAt){
    if(s.hbChallenge&&ack===s.hbChallenge.nonce){
      s={...s,lastHbAckAt:receivedAt,hbAckCount:(s.hbAckCount||0)+1,hbChallenge:null};
      this.setSession(ws,s);
    }
    return s;
  }
  heartbeatChallenge(ws,s){
    if(!s.hbChallenge){
      s={...s,hbSeq:(s.hbSeq||0)+1,hbChallenge:{nonce:crypto.randomUUID(),sentAt:Date.now()}};
      this.setSession(ws,s);
    }
    return {serverHeartbeatSeq:s.hbSeq,serverHeartbeatToken:s.hbChallenge.nonce};
  }
  // No user IP, user-agent, or account credentials stored in the bounded room audit evidence.
  async preserveDisconnectEvidence(room,verdict,at){
    const key=CASE_PREFIX+String(at).padStart(14,'0')+':'+room.roomId;
    await this.ctx.storage.put(key,{roomId:room.roomId,at,reason:verdict.reason,responsibleTeam:verdict.responsibleTeam,causes:room.disconnectCase?.causes||{},probeEvidence:room.probeEvidence||{},heartbeatEvidence:verdict.observations});
    // Bound storage even without a ranking database; oldest cases are removed.
    const rows=await this.ctx.storage.list({prefix:CASE_PREFIX});
    const keys=[...rows.keys()].sort();
    if(keys.length>64)for(const k of keys.slice(0,keys.length-64))await this.ctx.storage.delete(k);
  }
  async beginDisconnect(room,team,reason,at=Date.now()){
    if(!room||!['blue','red'].includes(team))return;
    const incident=room.disconnectCase||{since:at,causes:{}};
    if(incident.causes[team])return;
    incident.causes[team]=reason;
    room.disconnectCase=incident;
    await this.ctx.storage.put(ROOM_PREFIX+room.roomId,room);
    await this.arm(true);
  }
  async finalizeDisconnect(room,at=Date.now()){
    if(room.finalVerdict)return this.completeDisconnectVerdict(room);
  const c=room.disconnectCase;if(!c||at-c.since<this.params(room).disconnectObserveMs)return false;
    const observations={};
    for(const team of ['blue','red']){
      const s=[...this.sessions.values()].find(x=>x.status==='matched'&&x.roomId===room.roomId&&x.team===team);
      observations[team]={connected:!!s,seenAgoMs:s?Math.max(0,at-s.lastSeen):null,ackAgoMs:s?.lastHbAckAt!=null?Math.max(0,at-s.lastHbAckAt):null,acks:s?.hbAckCount||0,probeRttMs:room.probeEvidence?.[team]?.map(r=>r.rttMs)||[]};
      if(s&&(at-s.lastSeen>=this.params(room).connectionTimeoutMs||(s.hbChallenge&&at-s.hbChallenge.sentAt>=this.params(room).heartbeatAckTimeoutMs)))c.causes[team]??='heartbeat-timeout';
    }
    const suspects=Object.keys(c.causes),culprit=suspects.length===1?suspects[0]:null;
    const peer=culprit==='blue'?'red':'blue',healthy=culprit&&observations[peer]?.connected&&observations[peer].seenAgoMs<this.params(room).connectionTimeoutMs&&observations[peer].ackAgoMs<this.params(room).heartbeatAckTimeoutMs&&observations[peer].acks>0;
    const responsibleTeam=healthy?culprit:null;
  const verdict={reason:responsibleTeam?'single-side-disconnect':'unattributed-disconnect',responsibleTeam,observations};
  // The threshold uses the FIRST observed outage, not the later attribution time.
  const firstFailureAt=c.since;
  const elapsedMs=room.startAt==null?0:Math.max(0,firstFailureAt-room.startAt);
  const eligible=!!responsibleTeam&&room.startAuthorized===true&&room.battleJoined?.blue===true&&room.battleJoined?.red===true&&room.startAt!=null&&elapsedMs>=this.params(room).disconnectForfeitAfterSeconds*1000;
  const winnerTeam=eligible?(responsibleTeam==='blue'?'red':'blue'):null;
  room.finalVerdict={...verdict,firstFailureAt,elapsedMs,forfeit:eligible,winnerTeam,stars:eligible?2:0};
  await this.ctx.storage.put(ROOM_PREFIX+room.roomId,room);
  return this.completeDisconnectVerdict(room);
  }
 async settleDisconnectMatch(room){
  const d=room.finalVerdict;if(!d)return false;
  const db=this.env.CX_PLAYERS_DB;if(!db)throw Error('d1-not-configured');
  const loser=d.forfeit?room.players[d.responsibleTeam]:null;
  const winner=d.forfeit?room.players[d.winnerTeam]:null;
  // Batch is atomic on D1. The 'pending' guard prevents duplicated wins after retries.
  await db.batch([
   db.prepare(`INSERT OR IGNORE INTO matches(match_id,blue_player_id,red_player_id,started_at,ended_at,first_disconnect_at,end_tick,end_reason,responsible_player_id,winner_player_id,loser_player_id,win_stars,config_revision,settlement_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`)
    .bind(room.roomId,room.players.blue,room.players.red,room.startAt||null,Date.now(),d.firstFailureAt,room.startAt?serverTick(d.firstFailureAt,room.startAt):0,d.reason,d.responsibleTeam?room.players[d.responsibleTeam]:null,winner,loser,d.stars,room.configRevision||0),
   db.prepare(`UPDATE players SET wins=wins+1 WHERE player_id=? AND EXISTS(SELECT 1 FROM matches WHERE match_id=? AND settlement_status='pending')`).bind(winner||'',room.roomId),
   db.prepare(`UPDATE players SET losses=losses+1,disconnect_losses=disconnect_losses+1 WHERE player_id=? AND EXISTS(SELECT 1 FROM matches WHERE match_id=? AND settlement_status='pending')`).bind(loser||'',room.roomId),
   db.prepare(`UPDATE matches SET settlement_status='settled' WHERE match_id=? AND settlement_status='pending'`).bind(room.roomId)
  ]);
  return true;
 }
 async completeDisconnectVerdict(room){
  if(!room.finalVerdict)return false;
  try{await this.settleDisconnectMatch(room);}
  catch(err){
   console.error('disconnect-settlement-pending',room.roomId,String(err));
   await this.arm(true);return false; // Never claim a ranked result before it is persisted.
  }
  const v=room.finalVerdict;
  await this.preserveDisconnectEvidence(room,v,Date.now());
  await this.closeRoom(room,v.reason,'disconnect',{responsibleTeam:v.responsibleTeam,forfeit:v.forfeit,winnerTeam:v.winnerTeam,stars:v.stars,firstDisconnectAt:v.firstFailureAt,elapsedMs:v.elapsedMs,configRevision:room.configRevision||0,settlementStatus:'settled'});
  return true;
 }
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
 proofExpired(room){return !!room.startAt&&Date.now()>=room.startAt+this.params(room).proofTimeoutMs&&Date.now()-room.verify.lastAdvancedAt>=this.params(room).proofTimeoutMs;}
 prepExpired(room){return !room.startAuthorized&&Date.now()>=(room.startAt??room.preStartAt+this.params(room).prepTicks/30*1000);}
 async message(ws,message,receivedAt=Date.now()){
  let s=this.sessions.get(ws);if(!s||s.status==='spent')return;
  if(typeof message!=='string'||message.length>65536)return this.error(ws,'invalid-envelope');let d;
  try{d=JSON.parse(message);}catch{return this.error(ws,'bad-json');}
  s={...s,lastSeen:receivedAt};this.setSession(ws,s);
  if(d?.op==='clock_probe_reply'){this.acceptClockProbe(ws,s,d,receivedAt);return;}
  // Initial heartbeat may race the three sequential server clock probes on slow mobiles.
  // Keep the probe state intact; a keepalive is not an invalid handshake packet.
  if(s.status==='probing'&&d?.op==='heartbeat'){this.send(ws,{op:'heartbeat',id:d.id,status:'probing',serverNow:Date.now()});return;}
  if(s.status==='probing')return this.error(ws,'clock-probe-required');
  if(d?.op==='ping')return this.error(ws,'server-clock-probe-only');
  if(d?.op==='join_queue'){
   if(d.wireProtocol!==WIRE||d.simulationProtocol!==CORE||d.tickRate!==30||s.probeRows?.length!==this.params().probeCount)return this.error(ws,'protocol-or-clock-probe-mismatch');
   if(s.played||s.status==='matched')return this.error(ws,'connection-already-used');
   // Bind verified, unexpired player identity to this WS session, never trust an arbitrary client playerId.
   let player;try{player=await verifyTestSession(this.env,d.authToken);}catch(e){console.error('queue-auth-db',String(e));return this.error(ws,'account-db-unavailable');}
   if(!player)return this.error(ws,'login-required');
   if([...this.sessions].some(([peer,other])=>peer!==ws&&other.playerId===player.player_id&&['waiting','matched'].includes(other.status)))return this.error(ws,'account-already-online');
   s={...s,playerId:player.player_id};this.setSession(ws,s);
   if(s.status!=='waiting')this.setSession(ws,{...s,status:'waiting',roomId:null,team:null,progress:null,ruleVersion:String(d.ruleVersion||''),tier:d.deploySpeedTierCount===4?4:3,queuedAt:Date.now()});
   this.send(ws,{op:'queued'});await this.match();await this.arm();return;
  }
  if(d?.op==='leave_queue'){if(s.status==='waiting')this.setSession(ws,{...s,status:'idle'});return;}
  if(d?.op==='heartbeat'&&s.status!=='matched'){this.send(ws,{op:'heartbeat',id:d.id,status:s.status,serverNow:Date.now()});await this.arm();return;}
  if(s.status!=='matched'||!s.roomId)return this.error(ws,'wrong-room');
  const room=await this.ctx.storage.get(ROOM_PREFIX+s.roomId);if(!room)return this.error(ws,'room-missing');
  // Freeze gameplay after the first disconnection observation, but keep validating the victim's heartbeat.
  if(room.disconnectCase){
   if(d.op==='heartbeat'){
    s=this.verifyHeartbeatAck(ws,s,d.serverHeartbeatAck,receivedAt);
    this.send(ws,{op:'heartbeat',id:d.id,status:'matched',serverNow:Date.now(),tick_server:room.startAt?serverTick(Date.now(),room.startAt):0,...this.heartbeatChallenge(ws,s),...this.confirmation(room)});
    await this.arm();
   }
   return;
  }
  if(d.op==='prebattle_abort'){await this.closeRoom(room,String(d.reason||'prebattle-aborted').slice(0,100),'reconnect');return;}
  if(this.prepExpired(room)){await this.closeRoom(room,'prebattle-deadline','reconnect');return;}
  if(['abort','leave_room','takeover'].includes(d.op)){if(room.startAuthorized&&room.startAt!=null&&Date.now()>=room.startAt)await this.beginDisconnect(room,s.team,'client-'+d.op);else await this.closeRoom(room,String(d.reason||'peer-left').slice(0,100),'reconnect');return;}
  if(d.op==='setup'){
   if(!Number.isInteger(d.prepTick)||d.prepTick<0||d.prepTick>this.params(room).prepTicks-this.params(room).lockTicks||d.prepTick>Math.max(0,Math.ceil((Date.now()-room.preStartAt)*30/1000))+this.params(room).maxClockLagTicks||!d.setup){await this.closeRoom(room,'invalid-setup-envelope','reconnect');return;}
   if(room.setup[s.team]){
    if(room.commitTicks[s.team]!==d.prepTick||JSON.stringify(room.setup[s.team])!==JSON.stringify(d.setup))await this.closeRoom(room,'setup-conflict','reconnect');
    return;
   }
   room.setup[s.team]=d.setup;room.commitTicks[s.team]=d.prepTick;
   if(room.setup.blue&&room.setup.red){
    room.startPreTick=Math.max(room.commitTicks.blue,room.commitTicks.red)+this.params(room).lockTicks;
    room.startAt=room.preStartAt+room.startPreTick/30*1000;room.verify.lastAdvancedAt=room.startAt;
    if(Date.now()>=room.startAt){await this.closeRoom(room,'setup-deadline','reconnect');return;}
   }
   await this.ctx.storage.put(ROOM_PREFIX+room.roomId,room);
   this.peer(room.roomId,s.team,{op:'peer_setup',team:s.team,prepTick:d.prepTick,setup:d.setup});return;
  }
  if(d.op==='initial_state'){
   if(room.startAuthorized&&room.verify.init[s.team]===d.initHash)return;
   if(!room.startAt||Date.now()>=room.startAt||d.startPreTick!==room.startPreTick){await this.closeRoom(room,'initial-deadline-or-tick','reconnect');return;}
   const problem=this.acceptProof(room,s.team,{initHash:d.initHash,progress:{tick:0,seq:0,ack_seq:0,ended:false},checkpoints:[{tick:0,hash:d.checkpointHash}]});
   if(problem||!isHash(d.initHash)){await this.closeRoom(room,problem||'invalid-initial-hash','reconnect');return;}
   const ready=room.verify.initConfirmed&&room.verify.confirmedTick===0;
   if(ready)room.startAuthorized=true;
   await this.ctx.storage.put(ROOM_PREFIX+room.roomId,room);
   if(ready)this.broadcast(room.roomId,{op:'start_confirm',startPreTick:room.startPreTick,startAt:room.startAt,...this.confirmation(room)});
   return;
  }
  const tick_server=room.startAt?serverTick(Date.now(),room.startAt):0;
  if(d.op==='heartbeat'){
   if(!room.startAuthorized&&(d.initHash!=null||d.progress!=null||d.checkpoints?.length)){await this.closeRoom(room,'unexpected-prebattle-proof','reconnect');return;}
   if(d.progress!=null){
    if(!this.validProgress(d.progress))return this.error(ws,'invalid-progress');
    if(s.progress&&(d.progress.tick<s.progress.tick||d.progress.seq<s.progress.seq||d.progress.ack_seq<s.progress.ack_seq))return this.error(ws,'regressed-progress');
    s={...s,progress:d.progress};this.setSession(ws,s);room.battleJoined[s.team]=true;
   }
   s=this.verifyHeartbeatAck(ws,s,d.serverHeartbeatAck,receivedAt);
   const peer=[...this.sessions.values()].find(v=>v.status==='matched'&&v.roomId===s.roomId&&v.team!==s.team);
   if(!peer||Date.now()-peer.lastSeen>=this.params(room).connectionTimeoutMs){await this.beginDisconnect(room,s.team==='blue'?'red':'blue','peer-timeout',receivedAt);return;}
   const problem=this.acceptProof(room,s.team,d);
   if(problem){await this.closeRoom(room,problem);return;}
   const confirmation=this.confirmation(room);
   if(confirmation.endTick!=null&&confirmation.confirmedTick===confirmation.endTick){await this.closeRoom(room,'verified-complete','finished',confirmation);return;}
   if(this.proofExpired(room)){await this.closeRoom(room,'checkpoint-timeout');return;}
   await this.ctx.storage.put(ROOM_PREFIX+room.roomId,room);
   this.send(ws,{op:'heartbeat',id:d.id,status:'matched',serverNow:Date.now(),tick_server,peer:peer.progress,battleActive:!!(room.battleJoined.blue&&room.battleJoined.red),...confirmation,...this.heartbeatChallenge(ws,s)});
   await this.arm();return;
  }
  // S0011: 接收超期由接收方报告；房间关闭前必须由服务器核验对应已转发操作。
  if(d.op==='timeout_report'&&room.startAuthorized){
   const op=room.relayEvidence?.[d.inputId];
   if(!op||op.senderTeam===s.team||op.forwardTick==null){this.error(ws,'invalid-timeout-report');return;}
   // 未超过权威窗口时禁止凭空提前中止对局。钟差造成的过早报告可在截止Tick后重试。
   if(serverTick(Date.now(),room.startAt)<=op.tick+op.windowTicks){this.send(ws,{op:'timeout_report_wait',inputId:d.inputId,notBeforeTick:op.tick+op.windowTicks+1});return;}
   const share=delayResponsibility({team:op.senderTeam,tick:op.tick,w:op.windowTicks,receiveTick:op.receiveTick,forwardTick:op.forwardTick});
   await this.closeRoom(room,'receive-deadline','delay',{responsibleTeam:share.responsibleTeam,inputId:d.inputId});return;
  }
  if(d.op==='relay'&&room.startAuthorized){
   const p=d.payload;if(!['input','ack'].includes(p?.kind))return this.error(ws,'unknown-relay-kind');
   if(p.kind==='input'){
    const c=p.command;
    // 不信任客户端 windup_ticks；权威表控制完整时长及80%传输窗口。
    if(!validInputEnvelope(c,s.team,room.tier)||!Number.isInteger(p.windup_ticks)||p.windup_ticks!==authoritativeWindupTicks(c,room.tier))return this.error(ws,'invalid-input-envelope');
    if(Object.keys(room.relayEvidence||{}).length>=1024)return this.error(ws,'relay-evidence-limit');
    const last=room.relaySeq?.[s.team]||{seq:0,tick:0};
    if(c.seq!==last.seq+1||c.tick<last.tick||c.tick>serverTick(receivedAt,room.startAt)+this.params(room).maxInputFutureTicks)return this.error(ws,'invalid-input-sequence');
    const fullTicks=authoritativeWindupTicks(c,room.tier),windowTicks=legalWindowTicks(fullTicks);
    const receiveTick=serverTick(receivedAt,room.startAt),forwardTick=serverTick(Date.now(),room.startAt);
    const evidence={senderTeam:s.team,tick:c.tick,seq:c.seq,fullTicks,windowTicks,receiveTick,forwardTick};
    // 已过合法窗口：由服务器根据实际收到与转发时刻判定，不再用客户端传来的Windup延长窗口。
    if(forwardTick>c.tick+windowTicks){
     const share=delayResponsibility({team:s.team,tick:c.tick,w:windowTicks,receiveTick,forwardTick});
     // 未被转发的指令不可能由接收方负责；只有来源段超半才认定发送方，否则未知。
     if(share.responsibleTeam!==s.team)share.responsibleTeam=null;
     await this.closeRoom(room,'forward-deadline','delay',{responsibleTeam:share.responsibleTeam,inputId:c.id});return;
    }
    // 记录已转发操作，允许稍后接收方根据该操作提交超期报告；不依赖客户端自报收包时刻。
    if(!this.peer(room.roomId,s.team,{op:'relay',team:s.team,tick_server:forwardTick,payload:p})){await this.beginDisconnect(room,s.team==='blue'?'red':'blue','peer-unavailable');return;}
    room.relaySeq??={blue:{seq:0,tick:0},red:{seq:0,tick:0}};
    room.relayEvidence??={};room.relaySeq[s.team]={seq:c.seq,tick:c.tick};room.relayEvidence[c.id]=evidence;
    await this.ctx.storage.put(ROOM_PREFIX+room.roomId,room);return;
   }
   if(!Number.isSafeInteger(p.ack_seq)||p.ack_seq<0||p.ack_seq>(room.relaySeq?.[s.team==='blue'?'red':'blue']?.seq||0))return this.error(ws,'invalid-ack');
   if(!this.peer(room.roomId,s.team,{op:'relay',team:s.team,tick_server,payload:p}))await this.beginDisconnect(room,s.team==='blue'?'red':'blue','peer-unavailable');return;
  }
  this.error(ws,'unexpected-message');
 }
 async match(){
  const e=[...this.sessions].filter(([,s])=>s.status==='waiting'&&!s.played&&Date.now()-s.lastSeen<this.params().waitingTimeoutMs).sort((a,b)=>a[1].queuedAt-b[1].queuedAt);
  while(e.length>1){
   const a=e.shift(),i=e.findIndex(([,s])=>s.ruleVersion===a[1].ruleVersion&&s.tier===a[1].tier);if(i<0)continue;
   const b=e.splice(i,1)[0],roomId='CX_'+crypto.randomUUID(),words=new Uint32Array(1);do{crypto.getRandomValues(words);}while(!words[0]);
   const now=Date.now(),room={roomId,matchSeed:words[0],createdAt:now,preStartAt:now,startAt:null,startPreTick:null,startAuthorized:false,tier:a[1].tier,probeEvidence:{blue:a[1].probeRows||[],red:b[1].probeRows||[]},relaySeq:{blue:{seq:0,tick:0},red:{seq:0,tick:0}},relayEvidence:{},battleJoined:{blue:false,red:false},setup:{blue:null,red:null},commitTicks:{blue:null,red:null},verify:{init:{},initConfirmed:false,confirmedTick:-1,pending:{blue:{},red:{}},ends:{},lastAdvancedAt:now},params:{...this.activeConfig.params},configRevision:this.activeConfig.revision};
   room.players={blue:a[1].playerId,red:b[1].playerId};
   await this.ctx.storage.put(ROOM_PREFIX+roomId,room);
   for(const [[ws,s],team]of [[a,'blue'],[b,'red']])this.setSession(ws,{...s,status:'matched',played:true,roomId,team,lastSeen:now,progress:null,lastHbAckAt:null,hbAckCount:0,hbChallenge:null});
   for(const [[ws],team]of [[a,'blue'],[b,'red']])this.send(ws,{op:'match_found',roomId,team,matchSeed:room.matchSeed,playerId:team==='blue'?room.players.blue:room.players.red,serverNow:now,preStartAt:room.preStartAt,wireProtocol:WIRE,simulationProtocol:CORE,tickRate:30,parameters:room.params,configRevision:room.configRevision});
  }
 }
 peer(roomId,team,p){let ok=false;for(const [ws,s]of this.sessions)if(s.status==='matched'&&s.roomId===roomId&&s.team!==team)ok=this.send(ws,p)||ok;return ok;}
 broadcast(roomId,p){for(const [ws,s]of this.sessions)if(s.status==='matched'&&s.roomId===roomId)this.send(ws,p);}
 async closeRoom(room,reason,transition='pve',extra={}){
  if(transition==='pve'&&(!room.startAuthorized||Date.now()<room.startAt||!room.battleJoined.blue||!room.battleJoined.red))transition='reconnect';
  this.broadcast(room.roomId,{op:'room_closed',reason,transition,...extra});
  for(const [ws,s]of [...this.sessions])if(s.roomId===room.roomId)this.retire(ws);
  await this.ctx.storage.delete(ROOM_PREFIX+room.roomId);
 }
 webSocketClose(ws){const t=this.serial.then(async()=>{
  const s=this.sessions.get(ws)||ws.deserializeAttachment();this.retire(ws);
  if(s?.status==='matched'&&s.roomId){const r=await this.ctx.storage.get(ROOM_PREFIX+s.roomId);if(r)await this.beginDisconnect(r,s.team,'websocket-close');}
 });this.serial=t.catch(()=>{});return t;}
 webSocketError(ws){return this.webSocketClose(ws);}
 alarm(){const t=this.serial.then(async()=>{
  const now=Date.now();
  for(const [ws,s]of [...this.sessions]){
   if(s.status==='matched'){const r=await this.ctx.storage.get(ROOM_PREFIX+s.roomId);if(r&&(now-s.lastSeen>=this.params(r).connectionTimeoutMs||(s.hbChallenge&&now-s.hbChallenge.sentAt>=this.params(r).heartbeatAckTimeoutMs)))await this.beginDisconnect(r,s.team,now-s.lastSeen>=this.params(r).connectionTimeoutMs?'heartbeat-timeout':'heartbeat-downlink-timeout');}
   else if(s.status==='waiting'&&now-s.lastSeen>=this.params().waitingTimeoutMs){this.send(ws,{op:'queue_expired'});this.retire(ws);}
   else if(s.status==='probing'&&now-s.probeStartedAt>=this.params().probeTimeoutMs){this.error(ws,'clock-probe-timeout');this.retire(ws);}
  }
  const rows=await this.ctx.storage.list({prefix:ROOM_PREFIX});
  for(const r of rows.values()){
   if(r.disconnectCase){await this.finalizeDisconnect(r,now);continue;}
   if(this.prepExpired(r))await this.closeRoom(r,'prebattle-deadline','reconnect');
   else if(this.proofExpired(r))await this.closeRoom(r,'checkpoint-timeout');
   else if(now-r.createdAt>=240000)await this.closeRoom(r,'room-expired');
  }
  await this.arm(rows.size?[...rows.values()].some(r=>r.disconnectCase):false);
 });this.serial=t.catch(()=>{});return t;}
}
