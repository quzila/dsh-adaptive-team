import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {join} from 'node:path';
const requireProfile=createRequire(join(process.env.DSH_HOME??join(homedir(),'.dsh'),'profiles/desktop/package.json'));
export const name='adaptive-headless-tools';
export const inject=['agents','subagents','tools','systemPrompt','sessionProjections','subagentModelSelection'];
export async function apply(ctx){
 const tool=await import(requireProfile.resolve('@deepseek-ai/dsh-tool-subagent'));
 ctx.on('agent/created',({agent})=>{
  agent.ctx.inject([...tool.inject,'subagentModelSelection'],scope=>tool.apply(scope,{provider:'adaptive-worker',toolName:'worker',modelSelectionSettings:true,enableRunInBackground:true,backgroundMode:'one-shot',maxDepth:'provider-managed'},agent.session));
 });
}
