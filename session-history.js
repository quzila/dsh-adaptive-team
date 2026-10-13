import {spawnSync} from 'node:child_process';
import {existsSync,readdirSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const cache=new Map();
const textOf=message=>(message?.content??[]).filter(block=>block?.type==='text').map(block=>block.text??'').join('\n');

export function extractJobHistory(events){
 const calls=new Map(),results=new Map(),history={};
 for(const event of events){
  if(event?.type==='tool/call'&&['worker','job_output','job_kill'].includes(event.data?.name)){
   try{calls.set(event.data.callId,{name:event.data.name,args:JSON.parse(event.data.arguments),startedAt:event.time});}catch{}
  }
  if(event?.type==='tool/result'&&event.data?.message?.toolCallId)results.set(event.data.message.toolCallId,textOf(event.data.message));
 }
 for(const [id,call] of calls){
  if(call.name!=='worker')continue;
  const jobId=results.get(id)?.match(/\bsubagent-\d+\b/)?.[0];
  if(jobId&&typeof call.args.prompt==='string')history[jobId]={prompt:call.args.prompt,provider:call.args.provider,model:call.args.model,description:call.args.description,startedAt:call.startedAt,status:'recorded'};
 }
 for(const [id,call] of calls){
  if(call.name!=='job_output'||typeof call.args.job_id!=='string')continue;
  const output=results.get(id);
  if(output){const row=history[call.args.job_id]??{};const status=output.match(/\[status:\s*(\w+)\]/)?.[1];if(status)row.status=status;if(!/^\(no new output\)/.test(output))row.output=output.slice(0,40000);history[call.args.job_id]=row;}
 }
 for(const [id,call] of calls){
  if(call.name!=='job_kill'||typeof call.args.job_id!=='string')continue;
  if(results.get(id)?.includes('requested cancellation')){const row=history[call.args.job_id]??{};row.status='killed';history[call.args.job_id]=row;}
 }
 for(const row of Object.values(history))if(row.status==='running')row.status='recorded';
 return history;
}

function transcriptPath(sessionId){
 if(typeof sessionId!=='string'||!/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId))return null;
 const root=join(process.env.DSH_HOME??join(homedir(),'.dsh'),'sessions');
 for(const project of readdirSync(root,{withFileTypes:true})){
  if(!project.isDirectory())continue;
  const file=join(root,project.name,sessionId,'session.v4.jsonl.zstd');
  if(existsSync(file))return file;
 }
 return null;
}

export function readJobHistory(sessionId){
 let file;try{file=transcriptPath(sessionId);}catch{return {};}
 if(!file)return {};
 const info=statSync(file),saved=cache.get(sessionId);
 if(saved?.file===file&&saved.mtime===info.mtimeMs&&saved.size===info.size)return saved.history;
 const candidates=['/opt/homebrew/bin/zstd','/usr/local/bin/zstd','zstd'];
 let decoded;
 for(const command of candidates){const result=spawnSync(command,['-dc',file],{encoding:'utf8',maxBuffer:64*1024*1024,timeout:5000});if(!result.error&&result.status===0){decoded=result.stdout;break;}}
 if(decoded===undefined)return {};
 const events=[];for(const line of decoded.split('\n')){if(!line)continue;try{events.push(JSON.parse(line));}catch{}}
 const history=extractJobHistory(events);cache.set(sessionId,{file,mtime:info.mtimeMs,size:info.size,history});
 if(cache.size>30)cache.delete(cache.keys().next().value);
 return history;
}

export function readChildMessages(sessionId){
 let file;try{file=transcriptPath(sessionId);}catch{return [];}
 if(!file)return [];
 let decoded;
 for(const command of ['/opt/homebrew/bin/zstd','/usr/local/bin/zstd','zstd']){const result=spawnSync(command,['-dc',file],{encoding:'utf8',maxBuffer:64*1024*1024,timeout:5000});if(!result.error&&result.status===0){decoded=result.stdout;break;}}
 if(decoded===undefined)return [];
 const messages=[];
 for(const line of decoded.split('\n')){
  if(!line)continue;let event;try{event=JSON.parse(line);}catch{continue;}
  const at=Date.parse(event.time)||0;
  if(event.type==='user/message'){const content=event.data?.content;const text=Array.isArray(content)?content.filter(item=>item?.type==='text').map(item=>item.text).join('\n'):String(content??'');if(text)messages.push({at,kind:'user',title:'指示',text:text.slice(0,20000)});}
  else if(event.type==='assistant/message'){const text=textOf(event.data?.message);if(text)messages.push({at,kind:'assistant',title:'担当',text:text.slice(0,20000)});}
  else if(event.type==='tool/call')messages.push({at,kind:'tool',title:event.data?.name??'ツール',text:String(event.data?.arguments??'').slice(0,10000)});
  else if(event.type==='tool/result'){const text=textOf(event.data?.message);messages.push({at,kind:'tool-result',title:'実行結果',text:text.slice(0,10000)});}
 }
 return messages.slice(-200);
}
