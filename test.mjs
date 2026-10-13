import {test} from 'node:test';import assert from 'node:assert/strict';
import {makeAdaptiveProvider,nativeOverrides,defaults,validateSettings} from './settings.js';
import {beginActivity,finishActivity,listActivities,updateActivityStream} from './activity.js';
import {extractJobHistory,readJobHistory} from './session-history.js';
import {validatePlanGraph,savePlanGraph,readPlanGraph,sessionPlanPath} from './plan-graph.js';
import {codexNotificationEvent,appendTranscriptEvent,readTranscriptEvents} from './native-transcript.js';
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
 const result=await runBoard({board,task:'Build a widget',parent:{},signal:new AbortController().signal,llm:{resolveCallConfig:async r=>seen.push(['route',r.provider,r.model])},onStage:e=>seen.push(['event',e.event,e.role??e.status]),subagents:{start:async(_provider,spec)=>{seen.push(['provider',_provider,spec.toolFilter]);seen.push(['stage',spec.agentOptions.provider,spec.agentOptions.fast,spec.prompt[0].text]);return {result:Promise.resolve({stopReason:'completed',output:[{type:'text',text:`handoff ${seen.filter(x=>x[0]==='stage').length}`}] }),dispose:async()=>seen.push(['dispose'])};}}});
 assert.equal(result.final,'handoff 3');assert.match(seen.find(x=>x[0]==='stage'&&x[1]==='claude')[3],/handoff 1/);assert.match(seen.find(x=>x[0]==='stage'&&x[1]==='codex')[3],/handoff 2/);assert.match(seen.find(x=>x[0]==='stage'&&x[1]==='codex')[3],/Original user task.*Build a widget/s);assert.equal(seen.find(x=>x[0]==='stage'&&x[1]==='codex')[2],true);assert.deepEqual(seen.filter(x=>x[0]==='provider').map(x=>[x[1],x[2]]),[['spawn',{allow:[]}],['spawn',{allow:[]}],['adaptive-worker',undefined]]);assert.equal(seen.filter(x=>x[0]==='dispose').length,3);
 assert.deepEqual(seen.filter(x=>x[0]==='event').map(x=>x[1]),['started','finished','started','finished','started','finished']);
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
test('command graph details stay scoped to one session and follow worker completion',async()=>{
 const events=[];const sessionId='graph-test-session';
 const p=makeAdaptiveProvider({getHarness:()=>({start:async()=>({result:Promise.resolve({stopReason:'completed',output:[{type:'text',text:'finished task'}]}),dispose:async()=>{}})}),onState:e=>events.push(e)});
 const request=req({provider:'claude',model:'claude-test'});request.parent.session.header.id=sessionId;request.label='Review files';request.prompt=[{type:'text',text:'Check only the named files'}];
 const run=await p.start(request);await run.result;await run.dispose();
 for(const event of events){if(event.event==='started')beginActivity(event.sessionId,{id:event.id,label:event.label,prompt:event.prompt});if(event.event==='finished')finishActivity(event.sessionId,event.id,event.status,event.output);}
 const id=listActivities(sessionId)[0].id;updateActivityStream(sessionId,id,'Working');assert.equal(listActivities(sessionId)[0].stream,'Working');updateActivityStream(sessionId,id,null,true);
 assert.deepEqual(listActivities('other-session'),[]);
 assert.deepEqual(listActivities(sessionId).map(row=>[row.label,row.prompt,row.status,row.output]),[['Review files','Check only the named files','completed','finished task']]);
});
test('command graph limits agent nodes and keeps shell jobs out of the diagram',async()=>{
 let plugin;let stateCall=0;const React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:props??{},children}),useState(value){stateCall++;return [stateCall===1?true:stateCall===2?{board:{stages:[]},parent:{provider:'claude',model:'test'},planGraph:{nodes:[{id:'review',role:'Planned reviewer',instruction:'Review later',provider:'codex',model:'test'}],edges:[{from:'parent',to:'review'}]}}:value,()=>{}];},useEffect(){}};
 const previousWindow=globalThis.window,previousDocument=globalThis.document;
 try{
  globalThis.window={__ModuleLoader__:{load:definition=>{plugin=definition.factory(name=>name==='react'?React:{createPortal:node=>node});}}};globalThis.document={body:{}};
  await import('./client.js?graph-ui-test');
  let Graph;const ctx={effect(){},locale:{bind:()=>key=>key},get:()=>({rpc:{}}),slots:{inject:(_slot,register)=>register(),register:(slot,component)=>{if(slot.id==='adaptive-team-command-graph')Graph=component;}}};plugin.apply(ctx);
  const rows=[...Array.from({length:12},(_,i)=>({id:`agent-${i}`,kind:'subagent',label:`Worker ${i}`,status:'completed',startedAt:i+1})),...Array.from({length:8},(_,i)=>({id:`shell-${i}`,kind:'bash',label:`private-command-${i}`,status:'completed',startedAt:i+1}))];
  const tree=Graph({sessionId:'s',useJobs:selector=>selector({rows:{s:rows},observed:{}}),watchRows:()=>()=>{},observe:()=>()=>{},rpc:{},sendToParent:async()=>{},killJob:async()=>true});
  const visit=(node,fn)=>{if(Array.isArray(node)){node.forEach(child=>visit(child,fn));return;}if(!node||typeof node!=='object')return;fn(node);visit(node.children,fn);};
  const graphs=[];visit(tree,node=>{if(node.props.className==='atg-graph')graphs.push(node);});assert.equal(graphs.length,2);const graph=graphs[1];
  const plannedText=[];visit(graphs[0],node=>{for(const child of node.children)if(typeof child==='string')plannedText.push(child);});assert(plannedText.includes('Planned reviewer'));
  const graphText=[];visit(graph,node=>{for(const child of node.children)if(typeof child==='string')graphText.push(child);});
  assert.equal(graphText.filter(text=>/^Worker \d+$/.test(text)).length,6);
  assert(!graphText.some(text=>text.includes('private-command')));
  const allText=[];visit(tree,node=>{for(const child of node.children)if(typeof child==='string')allText.push(child);});
  assert(allText.some(text=>text.includes('ツール・コマンド実行 8 件')));
  assert(allText.some(text=>text.includes('過去の担当・中断した担当 6 件')));
 }finally{globalThis.window=previousWindow;globalThis.document=previousDocument;}
});
test('planned graph supports fan-out and join before execution',()=>{
 const graph={nodes:[{id:'a',role:'Plan',instruction:'Prepare options',provider:'claude',model:'test'},{id:'b',role:'Research',instruction:'Find evidence',provider:'codex',model:'test'},{id:'c',role:'Join',instruction:'Combine results',provider:'grok',model:'test'}],edges:[{from:'parent',to:'a'},{from:'parent',to:'b'},{from:'a',to:'c'},{from:'b',to:'c'}]};
 assert.deepEqual(validatePlanGraph(graph),graph);
 const dir=mkdtempSync(join(tmpdir(),'dsh-plan-'));const path=join(dir,'plan-graph.json');try{savePlanGraph(graph,path);assert.deepEqual(readPlanGraph(path),graph);}finally{rmSync(dir,{recursive:true,force:true});}
 assert.throws(()=>validatePlanGraph({...graph,edges:[{from:'parent',to:'a'}]}),/path from the parent/);
 assert.throws(()=>validatePlanGraph({...graph,edges:[...graph.edges,{from:'c',to:'a'}]}),/cycle/);
 assert.throws(()=>validatePlanGraph({...graph,nodes:[graph.nodes[0],graph.nodes[0]]}),/unique/);
 assert.notEqual(sessionPlanPath('session-11111111-1111-1111-1111-111111111111'),sessionPlanPath('session-22222222-2222-2222-2222-222222222222'));
 assert.throws(()=>sessionPlanPath('../private'),/Invalid session ID/);
});
test('saved worker calls reconnect prompts and results by job id',()=>{
 const events=[
  {type:'tool/call',time:1234,data:{callId:'call-a',name:'worker',arguments:JSON.stringify({description:'Review',provider:'codex',model:'test-model',prompt:'Inspect a sample file'})}},
  {type:'tool/result',data:{message:{toolCallId:'call-a',content:[{type:'text',text:'Started as subagent-7'}]}}},
  {type:'tool/call',data:{callId:'call-b',name:'job_output',arguments:JSON.stringify({job_id:'subagent-7'})}},
  {type:'tool/result',data:{message:{toolCallId:'call-b',content:[{type:'text',text:'Review completed'}]}}}
 ];
 assert.deepEqual(extractJobHistory(events)['subagent-7'],{prompt:'Inspect a sample file',provider:'codex',model:'test-model',description:'Review',startedAt:1234,status:'recorded',output:'Review completed'});
 assert.deepEqual(readJobHistory('../other-session'),{});
});
test('native Codex progress becomes a private chronological chat',()=>{
 const previous=process.env.DSH_HOME,home=mkdtempSync(join(tmpdir(),'dsh-chat-'));
 process.env.DSH_HOME=home;
 try{
  const sessionId='session-11111111-1111-1111-1111-111111111111',activityId='22222222-2222-2222-2222-222222222222';
  const started=codexNotificationEvent({method:'item/started',params:{item:{type:'commandExecution',command:'npm test'}}});
  const completed=codexNotificationEvent({method:'item/completed',params:{item:{type:'commandExecution',command:'npm test',aggregatedOutput:'14 tests passed',status:'completed'}}});
  const reply=codexNotificationEvent({method:'item/completed',params:{item:{type:'agentMessage',phase:'commentary',text:'Checking the result'}}});
  assert.equal(codexNotificationEvent({method:'item/agentMessage/delta',params:{delta:'private'}}),null);
  for(const event of [started,completed,reply])appendTranscriptEvent(sessionId,activityId,event);
  assert.deepEqual(readTranscriptEvents(sessionId,activityId).map(row=>[row.kind,row.text]),[['tool-start','npm test'],['tool','npm test'],['assistant','Checking the result']]);
  assert.deepEqual(readTranscriptEvents('../other',activityId),[]);
 }finally{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;rmSync(home,{recursive:true,force:true});}
});
