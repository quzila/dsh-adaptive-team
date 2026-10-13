import {mountSettingsUi,modelCatalog} from './settings-ui-host.js';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {appendFileSync,readFileSync,mkdirSync} from 'node:fs';
import {readSettings,saveSettings,nativeOverrides,makeAdaptiveProvider} from './settings.js';
import {readBoard,saveBoard,validateBoard,runBoard} from './board.js';
import {readSessionPlanGraph,saveSessionPlanGraph,validatePlanGraph} from './plan-graph.js';
import {beginActivity,finishActivity,attachActivityChild,updateActivityStream} from './activity.js';
import {appendTranscriptEvent,codexNotificationEvent} from './native-transcript.js';
export const name='adaptive-agent-team';
export const inject=['subagents','subprocess','tools','llm'];
const requireProfile=createRequire(join(process.env.DSH_HOME??join(homedir(),'.dsh'),'profiles/desktop/package.json'));
export async function apply(ctx){
 const official=await import(requireProfile.resolve('@deepseek-ai/dsh-subagent-codex'));
 const provider=makeAdaptiveProvider({
  getHarness:()=>ctx.subagents.getProvider('spawn'),
  onState(event){if(event.boardStage)return;if(event.event==='started')beginActivity(event.sessionId,{id:event.id,kind:'worker',label:event.label??`${event.provider} worker`,provider:event.provider,model:event.model,fast:event.fast,prompt:event.prompt});else if(event.event==='finished')finishActivity(event.sessionId,event.id,event.status,event.output);},
  onChild:(sessionId,activityId,childId)=>attachActivityChild(sessionId,activityId,childId),
  async createNative({model,reasoningEffort,fast,readOnly,settings,sessionId,activityId}){
   let captured;
   official.apply({logger:ctx.logger,subagents:{registerProvider:p=>{captured=p;}},subprocess:{spawn(spec){
    const handle=ctx.subprocess.spawn({...spec,argv:[...spec.argv,...nativeOverrides(settings,reasoningEffort,fast,readOnly)]});
    // Keep only collaboration event metadata, never prompts or credentials.
    let partial='';handle.stdout?.on('data',chunk=>{
     partial+=chunk.toString();const lines=partial.split('\n');partial=lines.pop();
     for(const line of lines){try{const e=JSON.parse(line);const item=e.params?.item;if(e.method==='item/agentMessage/delta')updateActivityStream(sessionId,activityId,e.params?.delta);if(e.method==='item/completed'&&item?.type==='agentMessage')updateActivityStream(sessionId,activityId,null,true);const event=codexNotificationEvent(e);if(event)appendTranscriptEvent(sessionId,activityId,event);if(item?.type==='collabAgentToolCall'||item?.type==='subAgentActivity'){mkdirSync(join(process.env.DSH_HOME??join(homedir(),'.dsh'),'local-plugins/claude-codex-team'),{recursive:true,mode:0o700});appendFileSync(join(process.env.DSH_HOME??join(homedir(),'.dsh'),'local-plugins/claude-codex-team/native-subtasks.jsonl'),JSON.stringify({at:new Date().toISOString(),method:e.method,type:item.type,tool:item.tool,status:item.status,receiverThreadIds:item.receiverThreadIds,model:item.model,reasoningEffort:item.reasoningEffort,kind:item.kind,agentThreadId:item.agentThreadId})+'\n',{mode:0o600});}}catch{}}
    });
    return handle;
   }}},{providerName:'adaptive-native',model,permissionMode:'never',env:{CODEX_HOME:join(homedir(),'.codex')},disposeGraceMs:3000});
   return captured;
  },
 });
 ctx.subagents.registerProvider(provider);
 mountSettingsUi(ctx,provider);
 const properties={worker_provider:{type:'string',enum:['codex','claude','grok','antigravity']},worker_model:{type:'string'},worker_fast:{type:'boolean'},max_parallel:{type:'integer',minimum:1},parallelism_mode:{type:'string',enum:['auto','manual']},nested_model:{type:'string'},nested_parallel:{type:'integer',minimum:1},max_depth:{type:'integer',minimum:1}};
 ctx.tools.register({
  name:'team_settings',description:'Read team defaults, active workers and available model IDs. Pass fields to change saved defaults only when the human asks for those setting changes. In auto mode choose task parallelism autonomously within max_parallel; do not change the saved ceiling to admit more jobs. Parent model is selected independently in the DSH model menu. Native worker subtasks use nested_model and nested_parallel.',
  parameters:{type:'object',properties,additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v,null,2)}]},isConcurrencySafe:()=>false,
  async execute(args,exec){
   const current=readSettings();
   if(Object.keys(args).length){
    const next={...current,...args};
    await ctx.llm.resolveCallConfig({provider:next.worker_provider,model:next.worker_model},exec.signal);
    await ctx.llm.resolveCallConfig({provider:'codex',model:next.nested_model},exec.signal);
   }
   const settings=Object.keys(args).length?saveSettings(args):current;
   let catalog={};try{const d=JSON.parse(readFileSync(join(process.env.DSH_HOME??join(homedir(),'.dsh'),'plugins/subscriptions/models.json'),'utf8'));catalog=Object.fromEntries(['codex','claude','grok','antigravity'].map(k=>[k,(d[k]?.models??[]).map(m=>({id:m.id,name:m.name}))]));}catch{}
   return {settings,active_workers:provider.active,available_models:catalog,native_nested_limit:'Per native worker; separate from the outer worker cap. DSH child workers share the outer cap.'};
  },
 });
 ctx.tools.register({name:'team_board',description:'Read or run the saved ordered role board. Pass task to run every stage in order, handing each result to the next. Default is read-only; set writable:true only when the human expressly asks this board to change files. An empty task reads the board.',parameters:{type:'object',properties:{task:{type:'string'},writable:{type:'boolean'}},additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v,null,2)}]},isConcurrencySafe:()=>false,async execute(args,exec){const board=readBoard();const sessionId=exec.agent?.session?.header?.id;return args.task?await runBoard({board,task:args.task,writable:args.writable??false,parent:exec.agent,signal:exec.signal,subagents:ctx.subagents,llm:ctx.llm,onStage:event=>{if(event.event==='started')beginActivity(sessionId,{id:event.id,kind:'board-stage',label:event.role,provider:event.provider,model:event.model,fast:event.fast,prompt:event.prompt});else finishActivity(sessionId,event.id,event.status,event.output);}}):{board};}});
 ctx.tools.register({name:'team_board_edit',description:'Create or replace the saved role board when the human asks you to build or edit its cards in chat. First call team_board without a task to inspect the current board; preserve cards the human did not ask to change. Supply the complete ordered stages array, 0 to 8 cards. Changes are saved locally and immediately appear in Settings → Agent team. This tool only edits the board definition; it does not run tasks.',parameters:{type:'object',properties:{stages:{type:'array',maxItems:8,items:{type:'object',properties:{role:{type:'string'},instruction:{type:'string'},provider:{type:'string',enum:['codex','claude','grok','antigravity']},model:{type:'string'},fast:{type:'boolean'}},required:['role','instruction','provider','model','fast'],additionalProperties:false}}},required:['stages'],additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v,null,2)}]},isConcurrencySafe:()=>false,async execute(args,exec){const board=validateBoard(args);const models=modelCatalog();for(const stage of board.stages){await ctx.llm.resolveCallConfig({provider:stage.provider,model:stage.model},exec.signal);if(stage.fast&&!models.codex?.some(m=>m.id===stage.model&&m.fastTier))throw Error(`${stage.model} does not advertise Fast mode`);}exec.signal.throwIfAborted();const saved=saveBoard(board);return {board:saved,map:saved.stages.map(s=>s.role).join(' → ')};}});
 ctx.tools.register({name:'team_graph_plan',description:'Read or save this conversation’s planned command graph before any worker runs. Call with no fields to read it. To create or edit it, supply the complete nodes and edges arrays; parent is the reserved root ID, and connections may fan out and join. This edits only the local graph definition, never starts agents or changes workspace files. In DSH plan mode this graph definition is allowed as a planning artifact; remain in plan mode and present the written plan for approval separately.',parameters:{type:'object',properties:{nodes:{type:'array',maxItems:12,items:{type:'object',properties:{id:{type:'string'},role:{type:'string'},instruction:{type:'string'},provider:{type:'string',enum:['codex','claude','grok','antigravity']},model:{type:'string'}},required:['id','role','instruction','provider','model'],additionalProperties:false}},edges:{type:'array',maxItems:24,items:{type:'object',properties:{from:{type:'string'},to:{type:'string'}},required:['from','to'],additionalProperties:false}}},additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v,null,2)}]},isConcurrencySafe:()=>false,async execute(args,exec){const sessionId=exec.agent?.session?.header?.id;if(!Object.keys(args).length)return {graph:readSessionPlanGraph(sessionId)};const graph=validatePlanGraph(args);for(const node of graph.nodes)await ctx.llm.resolveCallConfig({provider:node.provider,model:node.model},exec.signal);exec.signal.throwIfAborted();return {graph:saveSessionPlanGraph(sessionId,graph)};}});
}
