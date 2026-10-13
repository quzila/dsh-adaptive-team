import {mountSettingsUi} from './settings-ui-host.js';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {appendFileSync,readFileSync,mkdirSync} from 'node:fs';
import {readSettings,saveSettings,nativeOverrides,makeAdaptiveProvider} from './settings.js';
export const name='adaptive-agent-team';
export const inject=['subagents','subprocess','tools','llm'];
const requireProfile=createRequire(join(process.env.DSH_HOME??join(homedir(),'.dsh'),'profiles/desktop/package.json'));
export async function apply(ctx){
 const official=await import(requireProfile.resolve('@deepseek-ai/dsh-subagent-codex'));
 const provider=makeAdaptiveProvider({
  getHarness:()=>ctx.subagents.getProvider('spawn'),
  async createNative({model,reasoningEffort,settings}){
   let captured;
   official.apply({logger:ctx.logger,subagents:{registerProvider:p=>{captured=p;}},subprocess:{spawn(spec){
    const handle=ctx.subprocess.spawn({...spec,argv:[...spec.argv,...nativeOverrides(settings,reasoningEffort)]});
    // Keep only collaboration event metadata, never prompts or credentials.
    let partial='';handle.stdout?.on('data',chunk=>{
     partial+=chunk.toString();const lines=partial.split('\n');partial=lines.pop();
     for(const line of lines){try{const e=JSON.parse(line);const i=e.params?.item;if(i?.type==='collabAgentToolCall'||i?.type==='subAgentActivity'){mkdirSync(join(process.env.DSH_HOME??join(homedir(),'.dsh'),'local-plugins/claude-codex-team'),{recursive:true,mode:0o700});appendFileSync(join(process.env.DSH_HOME??join(homedir(),'.dsh'),'local-plugins/claude-codex-team/native-subtasks.jsonl'),JSON.stringify({at:new Date().toISOString(),method:e.method,type:i.type,tool:i.tool,status:i.status,receiverThreadIds:i.receiverThreadIds,model:i.model,reasoningEffort:i.reasoningEffort,kind:i.kind,agentThreadId:i.agentThreadId})+'\n',{mode:0o600});}}catch{}}
    });
    return handle;
   }}},{providerName:'adaptive-native',model,permissionMode:'never',env:{CODEX_HOME:join(homedir(),'.codex')},disposeGraceMs:3000});
   return captured;
  },
 });
 ctx.subagents.registerProvider(provider);
 mountSettingsUi(ctx,provider);
 const properties={worker_provider:{type:'string',enum:['codex','claude']},worker_model:{type:'string'},max_parallel:{type:'integer',minimum:1},parallelism_mode:{type:'string',enum:['auto','manual']},nested_model:{type:'string'},nested_parallel:{type:'integer',minimum:1},max_depth:{type:'integer',minimum:1}};
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
   let catalog={};try{const d=JSON.parse(readFileSync(join(process.env.DSH_HOME??join(homedir(),'.dsh'),'plugins/subscriptions/models.json'),'utf8'));catalog=Object.fromEntries(['codex','claude'].map(k=>[k,(d[k]?.models??[]).map(m=>({id:m.id,name:m.name}))]));}catch{}
   return {settings,active_workers:provider.active,available_models:catalog,native_nested_limit:'Per native worker; separate from the outer worker cap. DSH child workers share the outer cap.'};
  },
 });
}
