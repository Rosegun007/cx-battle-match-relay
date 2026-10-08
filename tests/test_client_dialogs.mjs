import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const client=process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(import.meta.dirname,'../../client/CXBattle_Client_S0012-0001-1_ServerPing_DisconnectVerdict.html');
const html=fs.readFileSync(client,'utf8');
const start=html.indexOf('      function openOnlineDisconnectDialogS11(');
const end=html.indexOf('      function openOnlineDelayDialogS11(',start);
assert.ok(start>0&&end>start);
const fn=html.slice(start,end);
let n=0;
for(const sample of [
 {responsibleTeam:'blue',localTeam:'blue',title:'Your Disconnect',record:true},
 {responsibleTeam:'blue',localTeam:'red',title:'Enemy Disconnect',record:true},
 {responsibleTeam:null,localTeam:'blue',title:'Unknown Disconnect',record:false},
 {responsibleTeam:null,localTeam:'red',title:'Unknown Disconnect',record:false},
 {localLoss:true,localTeam:'blue',title:'Connection Lost',record:true},
]){
 const dialogs=[];
 class DlgStdA{constructor(title){this.title=title;this.buttons=[];dialogs.push(this);}addButton(b){this.buttons.push(b)}open(){this.opened=true}}
 class BtnStdA{static STYLE_YELLOW=1;static STYLE_ORANGE=2;static STYLE_GREEN=3;constructor(_a,label,style,enabled,fn){Object.assign(this,{label,style,enabled,fn})}}
 const env={DlgStdA,BtnStdA,online:{localTeam:sample.localTeam},cxNet20361:{pendingAcks:new Map(),incoming:[],seals:[]},performance:{now:()=>100},simTime:0,log(){},disconnectOnline(){},closeHudDeployPopup(){},closeCurrentDialog(){},buildOnlineRecord20361(){return sample.record?{}:null},saveOnlineEffectiveBattleRecord(){},draw(){},enterOnlineMode(){},initializeReplayModeStandard(){},updateRecordPanel(){},setRunStateUI(){},updateUI(){}};
 vm.runInNewContext(fn+';openOnlineDisconnectDialogS11('+JSON.stringify(sample)+');',env);
 const d=dialogs.at(-1);
 assert.equal(d.title,sample.title);assert.deepEqual(d.buttons.map(x=>x.label),['Save Record','Rematch','Options']);assert.equal(d.buttons[0].enabled,sample.record);assert.equal(d.opened,true);
 n++;console.log(`PASS ${n} ${sample.title} fixed layout`);
}
assert.match(html,/CX_CLIENT_VERSION = 'S0012-0001-1'/);
assert.match(html,/<title>CX对战 S0012-0001-1/);
assert.match(html,/ctx\.fillText\('S0012-0001-1'/);
assert.match(html,/CX_ORDERED_RELAY_S0012_V1/);
assert.ok(!html.includes("op:'ping', clientNow"));
console.log('PASS 6 version, protocol, and no client-driven clock probing');
console.log('RESULT: 6/6 passed');
