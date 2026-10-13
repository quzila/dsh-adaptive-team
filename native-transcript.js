import {appendFileSync,existsSync,mkdirSync,readFileSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const root=()=>join(process.env.DSH_HOME??join(homedir(),'.dsh'),'local-plugins/claude-codex-team/transcripts');
const sessionPattern=/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const clipped=value=>String(value??'').slice(0,20000);
function pathFor(sessionId,activityId){if(!sessionPattern.test(sessionId)||!idPattern.test(activityId))return null;return join(root(),sessionId,`${activityId}.jsonl`);}

export function codexNotificationEvent(message){
 const method=message?.method,params=message?.params,item=params?.item;
 if(!item||typeof item!=='object')return null;
 if(method==='item/started'){
  if(item.type==='commandExecution')return {kind:'tool-start',title:'コマンド実行中',text:clipped(item.command)};
  if(item.type==='collabAgentToolCall')return {kind:'tool-start',title:'サブタスク実行中',text:clipped(item.tool??item.prompt)};
  return null;
 }
 if(method!=='item/completed')return null;
 if(item.type==='agentMessage'&&typeof item.text==='string'&&item.text.trim())return {kind:'assistant',title:item.phase==='final_answer'?'最終回答':'Codex',text:clipped(item.text)};
 if(item.type==='commandExecution')return {kind:'tool',title:'コマンド',text:clipped(item.command),output:clipped(item.aggregatedOutput??item.output),status:item.status};
 if(item.type==='fileChange')return {kind:'tool',title:'ファイル変更',text:clipped(JSON.stringify(item.changes??[])),status:item.status};
 if(item.type==='collabAgentToolCall'||item.type==='subAgentActivity')return {kind:'tool',title:'サブタスク',text:clipped(item.tool??item.prompt??item.kind),status:item.status};
 return null;
}

export function appendTranscriptEvent(sessionId,activityId,event){
 const file=pathFor(sessionId,activityId);if(!file||!event)return;
 mkdirSync(join(root(),sessionId),{recursive:true,mode:0o700});
 if(existsSync(file)&&statSync(file).size>2*1024*1024)return;
 appendFileSync(file,JSON.stringify({at:Date.now(),...event})+'\n',{mode:0o600});
}
export function readTranscriptEvents(sessionId,activityId){
 const file=pathFor(sessionId,activityId);if(!file||!existsSync(file))return [];
 const lines=readFileSync(file,'utf8').split('\n').filter(Boolean).slice(-200);
 return lines.flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
}
