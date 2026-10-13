import {test} from 'node:test';import assert from 'node:assert/strict';
import {makeAdaptiveProvider,nativeOverrides,defaults,validateSettings} from './settings.js';
const req=(options={})=>({parent:{session:{header:{delegationDepth:0}},options:{}},prompt:[{type:'text',text:'bounded task'}],agentOptions:options});
test('live configurable capacity and per-task model routing',async()=>{
 let settings={...defaults,max_parallel:2};let live=0,peak=0;const models=[];
 const p=makeAdaptiveProvider({read:()=>settings,createNative:async x=>{models.push(x.model);return {start:async()=>{live++;peak=Math.max(peak,live);return {result:Promise.resolve({}),dispose:async()=>{live--;}}}};}});
 const a=await p.start(req({provider:'codex',model:'gpt-6-luna'}));const b=await p.start(req());
 assert.deepEqual(models,['gpt-6-luna','gpt-6.1-sol']);await assert.rejects(p.start(req()),/capacity/);
 await a.result;await assert.rejects(p.start(req()),/capacity/);
 settings={...settings,max_parallel:3};const c=await p.start(req());assert.equal(peak,3);
 settings={...settings,max_parallel:1};await assert.rejects(p.start(req()),/capacity/);
 await Promise.all([a.dispose(),a.dispose(),b.dispose(),c.dispose()]);assert.equal(p.active,0);
 const d=await p.start(req());await d.dispose();assert.equal(live,0);
});
test('Claude child uses DSH backend with a bounded second level',async()=>{
 let seen;const p=makeAdaptiveProvider({getHarness:()=>({start:async r=>{seen=r;return {result:Promise.resolve({}),dispose:async()=>{}};}})});
 const r=await p.start(req({provider:'claude',model:'claude-sonnet-5-5'}));assert.equal(seen.agentOptions.model,'claude-sonnet-5-5');assert.equal(seen.maxDepth,2);await r.dispose();
 const tooDeep=req();tooDeep.parent.session.header.delegationDepth=2;await assert.rejects(p.start(tooDeep),/depth/);
});
test('startup failure releases capacity; failed teardown retains it',async()=>{
 let fail=true;const p=makeAdaptiveProvider({read:()=>({...defaults,max_parallel:1}),createNative:async()=>({start:async()=>{if(fail)throw Error('startup');return {result:Promise.resolve({}),dispose:async()=>{throw Error('teardown');}};}})});
 await assert.rejects(p.start(req()),/startup/);assert.equal(p.active,0);fail=false;const r=await p.start(req());await assert.rejects(r.dispose(),/teardown/);assert.equal(p.active,1);
});
test('nested Codex flags select Luna without modifying global configuration',()=>{
 const argv=nativeOverrides({...defaults,nested_parallel:3},'high');assert(argv.includes('agents.enabled=true'));assert(argv.includes('agents.default_subagent_model="gpt-6-luna"'));assert(argv.includes('agents.max_concurrent_threads_per_session=3'));assert(argv.includes('model_reasoning_effort="high"'));
 assert.throws(()=>validateSettings({max_parallel:0}),/positive/);assert.throws(()=>validateSettings({max_parallel:1.5}),/positive/);assert.throws(()=>validateSettings({worker_provider:'unknown'}));
});
import {saveUiSettings,validateUiPayload} from './settings-ui-host.js';
import {runBoard,validateBoard,saveBoard,readBoard} from './board.js';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
function uiContext(){let parent={provider:'claude',model:'claude-sonnet-5-5',reasoningEffort:'high'};const saved=[];return {saved,agentDefaultModel:{currentSelection:()=>({...parent}),saveSelection:async p=>{parent={...p};saved.push({...p});}},llm:{resolveCallConfig:async p=>{if(p.model==='not-a-model')throw Error('Unknown model');}}};}
test('UI saves parent and auto/manual worker values through the same settings store',async()=>{
 const ctx=uiContext();let current={...defaults};const result=await saveUiSettings(ctx,{parent:{provider:'codex',model:'gpt-6-luna'},settings:{worker_provider:'codex',worker_model:'gpt-6-luna',max_parallel:3,parallelism_mode:'manual'}},new AbortController().signal,{read:()=>current,save:p=>{current={...current,...p};}});
 assert.equal(result.parent.model,'gpt-6-luna');assert.equal(result.settings.max_parallel,3);assert.equal(result.settings.parallelism_mode,'manual');
});
test('UI rejects invalid model or worker count before changing saved state',async()=>{
 const ctx=uiContext();let writes=0;const dep={read:()=>({...defaults}),save:()=>{writes++;}};
 await assert.rejects(saveUiSettings(ctx,{parent:{provider:'codex',model:'not-a-model'},settings:{}},new AbortController().signal,dep),/Unknown model/);
 assert.throws(()=>validateUiPayload({parent:{provider:'codex',model:'gpt-6-luna'},settings:{max_parallel:0}}),/positive/);assert.equal(writes,0);assert.equal(ctx.saved.length,0);
});
test('UI restores parent default if worker settings cannot be written',async()=>{
 const ctx=uiContext();await assert.rejects(saveUiSettings(ctx,{parent:{provider:'codex',model:'gpt-6-luna'},settings:{max_parallel:6}},new AbortController().signal,{read:()=>({...defaults}),save:()=>{throw Error('disk failure');}}),/disk failure/);assert.equal(ctx.agentDefaultModel.currentSelection().model,'claude-sonnet-5-5');
});
test('ordered board hands each completed result to the next model and applies Fast only to Codex',async()=>{
 const seen=[];const board={stages:[{role:'Plan',instruction:'Plan only',provider:'antigravity',model:'gemini-test',fast:false},{role:'Adapt',instruction:'Adapt for Codex',provider:'claude',model:'claude-test',fast:false},{role:'Implement',instruction:'Implement the plan',provider:'codex',model:'gpt-test',fast:true}]};
 const result=await runBoard({board,task:'Build a widget',parent:{},signal:new AbortController().signal,llm:{resolveCallConfig:async r=>seen.push(['route',r.provider,r.model])},subagents:{start:async(_provider,spec)=>{seen.push(['stage',spec.agentOptions.provider,spec.agentOptions.fast,spec.prompt[0].text]);return {result:Promise.resolve({stopReason:'completed',output:[{type:'text',text:`handoff ${seen.filter(x=>x[0]==='stage').length}`}] }),dispose:async()=>seen.push(['dispose'])};}}});
 assert.equal(result.final,'handoff 3');assert.match(seen.find(x=>x[0]==='stage'&&x[1]==='claude')[3],/handoff 1/);assert.match(seen.find(x=>x[0]==='stage'&&x[1]==='codex')[3],/handoff 2/);assert.match(seen.find(x=>x[0]==='stage'&&x[1]==='codex')[3],/Original user task.*Build a widget/s);assert.equal(seen.find(x=>x[0]==='stage'&&x[1]==='codex')[2],true);assert.equal(seen.filter(x=>x[0]==='dispose').length,3);
});
test('board stops on failure and keeps private local configuration out of source',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dsh-board-'));const path=join(dir,'board.json');
 try{const board={stages:[{role:'Review',instruction:'Read input',provider:'grok',model:'grok-test',fast:false}]};saveBoard(board,path);assert.deepEqual(readBoard(path),board);assert.throws(()=>validateBoard({stages:[{...board.stages[0],fast:true}]}),/Fast/);
 await assert.rejects(runBoard({board,task:'Task',parent:{},signal:new AbortController().signal,llm:{resolveCallConfig:async()=>{}},subagents:{start:async()=>({result:Promise.resolve({stopReason:'error',output:[],diagnostic:'failed'}),dispose:async()=>{}})}}),/stopped: error/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('native Codex worker receives per-run Fast setting',async()=>{
 let config;const p=makeAdaptiveProvider({createNative:async o=>{config=o;return {start:async()=>({result:Promise.resolve({}),dispose:async()=>{}})};}});
 const run=await p.start(req({provider:'codex',model:'gpt-6.1-sol',fast:true,readOnly:true}));assert.equal(config.fast,true);assert.equal(config.readOnly,true);assert(nativeOverrides(defaults,undefined,true,true).includes('service_tier="fast"'));assert(nativeOverrides(defaults,undefined,true,true).includes('sandbox_mode="read-only"'));await run.dispose();
});
