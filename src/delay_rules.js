// CX对战 S0012：仅包含无需运行战斗引擎的权威通信窗口与责任分摊。
// 必须与客户端 DEPLOY_MODE_RULES / BATTLE_FLAG_CONFIG 保持一致；升级战斗规则时同步审计。
export const TICK_RATE = 30;
export const DEPLOY_SECONDS = Object.freeze({
  melee: Object.freeze({ slow:6, normal:4, fast:2, ultra:10 }),
  ranged: Object.freeze({ slow:8, normal:5, fast:2, ultra:13 }),
  tank: Object.freeze({ slow:9, normal:6, fast:3, ultra:20 }),
  turret: Object.freeze({ slow:9, normal:6, fast:3, ultra:17 })
});
export const FLAG_WINDUP_TICKS = Math.round(2.307692308 * TICK_RATE); // 69
export const FLAG_TYPES = Object.freeze(['arrowRain','fireballRain','healing']);
export function authoritativeWindupTicks(c,tier=3){
  if(!c||typeof c!=='object')return null;
  if(c.kind==='deploy'){
    if(tier!==4&&c.mode==='ultra')return null;
    const seconds=DEPLOY_SECONDS[c.unit]?.[c.mode];
    return Number.isInteger(seconds)?seconds*TICK_RATE:null;
  }
  return c.kind==='flag'&&FLAG_TYPES.includes(c.type)?FLAG_WINDUP_TICKS:null;
}
export function legalWindowTicks(windupTicks){
  return Number.isSafeInteger(windupTicks)&&windupTicks>0?Math.floor(windupTicks*4/5):null;
}
// same server clock startAt, authoritative receive and forward timestamps in integer ticks
export function serverTick(atMs,startAt){return Math.max(0,Math.floor((atMs-startAt)*TICK_RATE/1000));}
export function delayResponsibility({team,tick,w,receiveTick,forwardTick}){
  const a=Math.min(w,Math.max(0,receiveTick-tick));
  const s=Math.min(w-a,Math.max(0,forwardTick-receiveTick));
  const b=w-a-s;
  const responsibleTeam=2*a>w?team:2*b>w?(team==='blue'?'red':'blue'):null;
  return {a,s,b,w,responsibleTeam};
}
export function validInputEnvelope(c,team,tier=3){
  if(!c||c.team!==team||!Number.isSafeInteger(c.seq)||c.seq<1||c.seq>1000000||c.id!==`${team}:${c.seq}`||!Number.isInteger(c.tick)||c.tick<1||c.tick>5400||!Array.isArray(c.cell)||c.cell.length!==2||!c.cell.every(Number.isInteger))return false;
  const [x,y]=c.cell;
  if(x<0||x>=18||y<0||y>=32)return false;
  if(c.kind==='flag'&&(y===15||y===16||!['corner','center'].includes(c.anchorKind)))return false;
  return authoritativeWindupTicks(c,tier)!=null;
}
