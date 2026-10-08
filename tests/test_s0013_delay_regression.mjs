import assert from 'node:assert/strict';
import {authoritativeWindupTicks,legalWindowTicks,delayResponsibility,validInputEnvelope} from '../src/delay_rules.js';
const checks=[
 ['melee fast 2s',authoritativeWindupTicks({kind:'deploy',unit:'melee',mode:'fast'},3)===60],
 ['melee fast 80% =48 tick',legalWindowTicks(60)===48],
 ['ranged normal 5s',authoritativeWindupTicks({kind:'deploy',unit:'ranged',mode:'normal'},3)===150],
 ['flag legal window',legalWindowTicks(69)===55],
 ['source delay > 50%',delayResponsibility({team:'blue',tick:30,w:48,receiveTick:60,forwardTick:61}).responsibleTeam==='blue'],
 ['victim budget > 50%',delayResponsibility({team:'blue',tick:30,w:48,receiveTick:33,forwardTick:34}).responsibleTeam==='red'],
 ['no primary culprit',delayResponsibility({team:'red',tick:30,w:48,receiveTick:54,forwardTick:66}).responsibleTeam===null],
 ['legal input envelope',validInputEnvelope({kind:'deploy',team:'blue',unit:'melee',mode:'fast',seq:1,id:'blue:1',tick:60,cell:[1,2]},'blue',3)],
 ['no illegal speed mode',!validInputEnvelope({kind:'deploy',team:'blue',unit:'melee',mode:'ultra',seq:1,id:'blue:1',tick:60,cell:[1,2]},'blue',3)]
];
checks.forEach(([name,ok],i)=>{assert.ok(ok,name);console.log('PASS',i+1,name)});
console.log('RESULT:',checks.length+'/'+checks.length,'passed');
