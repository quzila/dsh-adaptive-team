import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
export const settingsPath=join(process.env.DSH_HOME??join(homedir(),'.dsh'),'local-plugins/claude-codex-team/settings.json');
export const providers=Object.freeze(['codex','claude','grok','antigravity']);
export const defaults=Object.freeze({worker_provider:'codex',worker_model:'gpt-6.1-sol',worker_fast:false,max_parallel:4,parallelism_mode:'auto',nested_model:'gpt-6-luna',nested_parallel:2,max_depth:2});
export function validateSettings(next){
 for(const k of Object.keys(next))if(!Object.hasOwn(defaults,k))throw Error(`Unknown setting: ${k}`);
 for(const k of ['max_parallel','nested_parallel','max_depth'])if(k in next && (!Number.isSafeInteger(next[k])||next[k]<1))throw Error(`${k} must be a positive safe integer`);
 for(const k of ['worker_model','nested_model'])if(k in next && (typeof next[k]!=='string'||!next[k].trim()))throw Error(`${k} must be a model ID`);
 if('worker_provider' in next&&!providers.includes(next.worker_provider))throw Error('Unsupported worker provider');
 if('worker_fast' in next&&typeof next.worker_fast!=='boolean')throw Error('worker_fast must be boolean');
 if('parallelism_mode' in next&&!['auto','manual'].includes(next.parallelism_mode))throw Error('parallelism_mode must be auto or manual');
 return next;
}
export function readSettings(path=settingsPath){try{return {...defaults,...validateSettings(JSON.parse(readFileSync(path,'utf8')))};}catch(e){if(e.code==='ENOENT')return {...defaults};throw e;}}
export function saveSettings(patch,path=settingsPath){validateSettings(patch);const next={...readSettings(path),...patch};mkdirSync(join(path,'..'),{recursive:true});const temp=`${path}.${process.pid}.tmp`;writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600});renameSync(temp,path);return next;}
export function nativeOverrides(s,effort,fast=false,readOnly=false){return [
 '-c','agents.enabled=true',
 '-c',`agents.default_subagent_model=${JSON.stringify(s.nested_model)}`,
 '-c',`agents.max_concurrent_threads_per_session=${s.nested_parallel}`,
 ...(effort?['-c',`model_reasoning_effort=${JSON.stringify(effort)}`]:[]),
 ...(fast?['-c','service_tier="fast"']:[]),
 ...(readOnly?['-c','sandbox_mode="read-only"']:[]),
];}
export function makeAdaptiveProvider({read=readSettings,createNative,getHarness,onState=()=>{},onChild=()=>{}}){
 let active=0;
 const notify=event=>{try{onState(event);}catch{}};
 const provider={name:'adaptive-worker',capabilities:{agentOptions:true,outputSchema:false,depthLimit:false,toolFilter:false,persona:false},inheritsParentContext:false,
 get agentRouteDefaults(){const s=read();return {provider:s.worker_provider,model:s.worker_model};},
 get active(){return active;},
 async start(request){
  const s=read();const options=request.agentOptions??{};
  const route=options.provider??s.worker_provider;const model=options.model??s.worker_model;
  if(!providers.includes(route))throw Error(`Unsupported worker provider: ${route}`);
  const fast=options.fast??(route===s.worker_provider&&model===s.worker_model?s.worker_fast:false);
  if(typeof fast!=='boolean'||fast&&route!=='codex')throw Error('Fast mode requires a Codex worker');
  if(options.readOnly!==undefined&&typeof options.readOnly!=='boolean')throw Error('readOnly must be boolean');
  if(options.maxTokens!==undefined)throw Error('Native workers do not support maxTokens; select a model instead.');
  const depth=Math.max(request.parent?.session?.header?.delegationDepth??0,request.parent?.options?.subagentDepth??0);
  if(depth>=s.max_depth)throw Error(`Delegation depth limit reached (${s.max_depth}). Finish this task without another child.`);
  if(active>=s.max_parallel)throw Error(`Worker capacity reached (${active}/${s.max_parallel}). Collect or stop an existing job before starting another.`);
  active++;
  const activityId=randomUUID(),sessionId=request.parent?.session?.header?.id;
  const prompt=(request.prompt??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').slice(0,20000);
  const boardStage=prompt.startsWith('You are stage ');
  notify({event:'started',id:activityId,sessionId,label:request.label,provider:route,model,fast,prompt:boardStage?'':prompt,boardStage,active,limit:s.max_parallel});
  let run;
  try{
   if(route==='codex'){
    const native=await createNative({model,reasoningEffort:options.reasoningEffort,fast,readOnly:options.readOnly??false,settings:s,sessionId,activityId});
    const {agentOptions,...nativeRequest}=request;
    const guidance=`Native subtasks are enabled. For independent smaller tasks you may use Codex spawn_agent with an explicit model and reasoning_effort, defaulting to ${s.nested_model}. Limit simultaneously open native subagents to ${s.nested_parallel}. Supply self-contained context and disjoint file ownership, wait for their completion and close them if the API exposes an explicit close operation; otherwise the app-server owner disposes the finished tree. Do not create deeper nested teams. Honor the parent's requested delegation count; do not delegate trivial tasks unnecessarily.\n\n`;
    run=await native.start({...nativeRequest,prompt:[{type:'text',text:guidance},...request.prompt]});
   }else{
    const harness=getHarness();if(!harness)throw Error('DSH in-process spawn provider is unavailable');
    const {fast:unused,readOnly:unusedReadOnly,...childOptions}=options;
    run=await harness.start({...request,maxDepth:s.max_depth,agentOptions:{...childOptions,provider:route,model}});
   }
  }catch(e){active--;notify({event:'finished',id:activityId,sessionId,status:'failed',output:e.message,active,limit:s.max_parallel});throw e;}
  try{onChild(sessionId,activityId,run.id);}catch{}
  const result=run.result.then(value=>{notify({event:'finished',id:activityId,sessionId,status:value.stopReason==='completed'?'completed':'failed',output:(value.output??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n'),active,limit:s.max_parallel});return value;},error=>{notify({event:'finished',id:activityId,sessionId,status:'failed',output:error.message,active,limit:s.max_parallel});throw error;});
  let disposal;
  return {...run,result,dispose(){disposal??=(async()=>{await run.dispose();active--;notify({event:'disposed',id:activityId,sessionId,active,limit:s.max_parallel});})();return disposal;}};
 }};
 return provider;
}
