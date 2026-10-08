import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const base=path.dirname(fileURLToPath(import.meta.url));
const entry=path.resolve(base,'../src/index.js');
const temp=path.resolve(base,'../src/__court_test_temp.mjs');
const original=await fs.readFile(entry,'utf8');
await fs.writeFile(temp,original.replace('import { DurableObject } from "cloudflare:workers";','class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}'));
const {CXMatchHub}=await import(pathToFileURL(temp).href+'?v=1');
await fs.unlink(temp);
const realNow=Date.now;
let ms=1700000000000;
Date.now=()=>ms;
let total=0;
const ok=(condition,label)=>{assert.ok(condition,label);total++;console.log(`PASS ${String(total).padStart(2,'0')} ${label}`)};
class FakeSocket{
  constructor(){this.messages=[];this.attachment=null;this.closed=false;}
  send(v){if(this.closed)throw Error('closed');this.messages.push(JSON.parse(v));}
  serializeAttachment(v){this.attachment=structuredClone(v);}
  deserializeAttachment(){return this.attachment;}
  close(){this.closed=true;}
  last(op){return this.messages.filter(x=>x.op===op).at(-1);}
}
class Pair {constructor(){this[0]=new FakeSocket();this[1]=new FakeSocket();}}
globalThis.WebSocketPair=Pair;
globalThis.WebSocketRequestResponsePair=class {};
globalThis.Response=class{constructor(body,opts){this.body=body;this.opts=opts;}};
function context(){
 const mem=new Map();let nextAlarm=null;
 return {accepted:[],mem,getWebSockets(){return[]},acceptWebSocket(s){this.accepted.push(s)},setWebSocketAutoResponse(){},storage:{
 async get(k){return structuredClone(mem.get(k));},
 async put(k,v){mem.set(k,structuredClone(v))},
 async delete(k){mem.delete(k)},
 async list({prefix}={}){return new Map([...mem.entries()].filter(([k])=>!prefix||k.startsWith(prefix)).map(([k,v])=>[k,structuredClone(v)]))},
 async getAlarm(){return nextAlarm},async setAlarm(v){nextAlarm=v}
 }};
}
async function scenario(){
 const ctx=context(),hub=new CXMatchHub(ctx,{});
 const tx=async(s,obj)=>hub.webSocketMessage(s,JSON.stringify(obj));
 async function attach(){await hub.fetch();return ctx.accepted.at(-1)}
 async function probe(s){
  for(let seq=1;seq<=3;seq++){
   const q=s.last('clock_probe');ok(q.seq===seq,`probe ${seq} server-initiated`);
   ms+=27+seq;
   await tx(s,{op:'clock_probe_reply',seq,nonce:q.nonce,clientReceivedAt:ms-1,clientSentAt:ms});
   const result=s.last('clock_probe_result');ok(result.seq===seq&&result.rttMs===27+seq,`server-owned RTT #${seq}`);
  }
  ok(s.last('clock_probe_complete').samples===3,'only after exactly 3 probes completed');
 }
 const a=await attach();
 ok(a.messages[0].op==='connected'&&a.messages[1].op==='clock_probe','connected, then challenge');
 await tx(a,{op:'join_queue',wireProtocol:'CX_ORDERED_RELAY_S0013_V1',simulationProtocol:'CX_SIM_30HZ_ORDERED_INPUT_439_V1',tickRate:30});
 ok(a.last('error').code==='clock-probe-required','premature queue rejected');
 const first=a.last('clock_probe');
 await tx(a,{op:'clock_probe_reply',seq:1,nonce:'forged',clientReceivedAt:ms,clientSentAt:ms});
 ok(a.last('error').code==='invalid-clock-probe'&&a.last('clock_probe').nonce===first.nonce,'forged clock nonce refused');
 await probe(a);
 const b=await attach();await probe(b);
 const join={op:'join_queue',wireProtocol:'CX_ORDERED_RELAY_S0013_V1',simulationProtocol:'CX_SIM_30HZ_ORDERED_INPUT_439_V1',tickRate:30,ruleVersion:'S0005-0455',deploySpeedTierCount:3};
 await tx(a,join);await tx(b,join);
 ok(a.last('match_found')?.team==='blue'&&b.last('match_found')?.team==='red','both players matched with new wire protocol');
 const rid=a.last('match_found').roomId;
 ok((await ctx.storage.get('room:'+rid)).probeEvidence.blue.length===3,'server RTT evidence saved in room');
 await tx(a,{op:'heartbeat',id:1});await tx(b,{op:'heartbeat',id:1});
 ok(typeof a.last('heartbeat').serverHeartbeatToken==='string','server creates random heartbeat challenge');
 const aToken=a.last('heartbeat').serverHeartbeatToken,bToken=b.last('heartbeat').serverHeartbeatToken;
 ms+=1000;
 await tx(a,{op:'heartbeat',id:2,serverHeartbeatAck:aToken});
 await tx(b,{op:'heartbeat',id:2,serverHeartbeatAck:bToken});
 ok(hub.sessions.get(a).hbAckCount===1&&hub.sessions.get(b).hbAckCount===1,'independent duplex heartbeat evidence');
 const staleA=aToken;
 ms+=1000;
 await tx(a,{op:'heartbeat',id:3,serverHeartbeatAck:staleA});
 ok(hub.sessions.get(a).hbAckCount===1,'stale heartbeat token cannot refresh acknowledgement');
 await hub.webSocketClose(a);
 ok(!b.last('room_closed'),'single disconnect enters observation window, no immediate verdict');
 ms+=1000;
 await tx(b,{op:'heartbeat',id:3,serverHeartbeatAck:b.last('heartbeat').serverHeartbeatToken});
 await hub.alarm();
 ok(b.last('room_closed')?.transition==='disconnect'&&b.last('room_closed')?.responsibleTeam==='blue','healthy B receives A responsibility');
 ok([...ctx.mem.keys()].some(k=>k.startsWith('disconnect-evidence:')),'persistent bounded evidence created before room deletion');
 ok(!(await ctx.storage.get('room:'+rid)),'room destroyed only after verdict');
 return total;
}
async function bothDisconnect(){
 const ctx=context(),hub=new CXMatchHub(ctx,{}),tx=async(s,d)=>hub.webSocketMessage(s,JSON.stringify(d));
 async function connect(){await hub.fetch();let s=ctx.accepted.at(-1);for(let i=1;i<=3;i++){const q=s.last('clock_probe');ms+=25;await tx(s,{op:'clock_probe_reply',seq:i,nonce:q.nonce,clientReceivedAt:ms,clientSentAt:ms})}return s;}
 const a=await connect(),b=await connect();
 const join={op:'join_queue',wireProtocol:'CX_ORDERED_RELAY_S0013_V1',simulationProtocol:'CX_SIM_30HZ_ORDERED_INPUT_439_V1',tickRate:30,ruleVersion:'S0005-0455'};
 await tx(a,join);await tx(b,join);const rid=a.last('match_found').roomId;
 await hub.webSocketClose(a);await hub.webSocketClose(b);
 ok(!!(await ctx.storage.get('room:'+rid))?.disconnectCase,'both peers closed, case remains pending');
 ms+=500;await hub.alarm();
 ok(!!(await ctx.storage.get('room:'+rid))?.disconnectCase,'first alarm does not prematurely close both-peer case');
 ms+=600;await hub.alarm();
 ok(!(await ctx.storage.get('room:'+rid)),'orphaned case finalized without active sockets');
 const evidence=[...ctx.mem.entries()].find(([k])=>k.startsWith('disconnect-evidence:'))?.[1];
 ok(evidence?.responsibleTeam===null&&Object.keys(evidence.causes).length===2,'two close events yield unknown responsibility');
}
async function downlinkTimeout(){
 const ctx=context(),hub=new CXMatchHub(ctx,{}),tx=async(s,d)=>hub.webSocketMessage(s,JSON.stringify(d));
 async function connect(){await hub.fetch();let s=ctx.accepted.at(-1);for(let i=1;i<=3;i++){const q=s.last('clock_probe');ms+=15;await tx(s,{op:'clock_probe_reply',seq:i,nonce:q.nonce,clientReceivedAt:ms,clientSentAt:ms})}return s;}
 const a=await connect(),b=await connect();
 const join={op:'join_queue',wireProtocol:'CX_ORDERED_RELAY_S0013_V1',simulationProtocol:'CX_SIM_30HZ_ORDERED_INPUT_439_V1',tickRate:30,ruleVersion:'S0005-0455'};
 await tx(a,join);await tx(b,join);
 await tx(a,{op:'heartbeat',id:1});await tx(b,{op:'heartbeat',id:1});
 let bAck=b.last('heartbeat').serverHeartbeatToken;
 ms+=1100;
 await tx(a,{op:'heartbeat',id:2,serverHeartbeatAck:a.last('heartbeat').serverHeartbeatToken});
 await tx(b,{op:'heartbeat',id:2,serverHeartbeatAck:bAck});bAck=b.last('heartbeat').serverHeartbeatToken;
 // A keeps sending upstream packets, but does NOT prove receiving new server challenges.
 for(let i=3;i<=5;i++){
  ms+=1000;
  await tx(a,{op:'heartbeat',id:i,serverHeartbeatAck:'invalid'});
  await tx(b,{op:'heartbeat',id:i,serverHeartbeatAck:bAck});bAck=b.last('heartbeat').serverHeartbeatToken;
 }
 await hub.alarm();
 let room=(await ctx.storage.list({prefix:'room:'})).values().next().value;
 ok(room.disconnectCase?.causes.blue==='heartbeat-downlink-timeout','one-way downlink failure discovered even when A upstream alive');
 ms+=1100;await tx(b,{op:'heartbeat',id:6,serverHeartbeatAck:bAck});await hub.alarm();
 ok(b.last('room_closed')?.responsibleTeam==='blue','one-sided heartbeat missing ack attributed to A connection side');
}
async function probeExpiry(){
 const ctx=context(),hub=new CXMatchHub(ctx,{});await hub.fetch();
 const s=ctx.accepted[0];ok(s.last('clock_probe')?.seq===1,'pending server probe exists');
 ms+=11000;await hub.alarm();
 ok(s.closed&&s.last('error')?.code==='clock-probe-timeout','stalled pre-match probing is retired after 10s');
}
async function unknownWhenVictimNotProven(){
 const ctx=context(),hub=new CXMatchHub(ctx,{}),tx=async(s,d)=>hub.webSocketMessage(s,JSON.stringify(d));
 async function connect(){await hub.fetch();let s=ctx.accepted.at(-1);for(let i=1;i<=3;i++){const q=s.last('clock_probe');ms+=20;await tx(s,{op:'clock_probe_reply',seq:i,nonce:q.nonce,clientReceivedAt:ms,clientSentAt:ms})}return s;}
 const a=await connect(),b=await connect();
 const join={op:'join_queue',wireProtocol:'CX_ORDERED_RELAY_S0013_V1',simulationProtocol:'CX_SIM_30HZ_ORDERED_INPUT_439_V1',tickRate:30,ruleVersion:'S0005-0455'};
 await tx(a,join);await tx(b,join);
 await tx(b,{op:'heartbeat',id:1}); // B hasn't confirmed any server downlink challenge.
 await hub.webSocketClose(a);ms+=1100;
 await tx(b,{op:'heartbeat',id:2,serverHeartbeatAck:'fabricated'});
 await hub.alarm();
 ok(b.last('room_closed')?.transition==='disconnect'&&b.last('room_closed')?.responsibleTeam===null,'unverified surviving peer -> Unknown, not guessed culprit');
}
try{await scenario();await bothDisconnect();await downlinkTimeout();await probeExpiry();await unknownWhenVictimNotProven();console.log(`RESULT: ${total}/${total} passed`)}finally{Date.now=realNow;}
