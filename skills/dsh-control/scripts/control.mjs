import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const home=os.homedir(),dsh=process.env.DSH_HOME??path.join(home,'.dsh'),root=path.join(dsh,'control'),runs=path.join(root,'runs');
const cli='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const self=fileURLToPath(import.meta.url);
const env=Object.fromEntries(['HOME','USER','LOGNAME','PATH','TMPDIR','LANG','LC_ALL','DSH_HOME'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
env.PATH='/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
fs.mkdirSync(runs,{recursive:true,mode:0o700});
const write=(p,v)=>{const t=p+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(t,JSON.stringify(v,null,2)+'\n',{mode:0o600});fs.renameSync(t,p);};
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<2)return false;try{process.kill(pid,0);return true;}catch{return false;}};
const dir=id=>{if(!/^run-[0-9a-f-]{36}$/.test(id??''))throw Error('Invalid run ID');return path.join(runs,id);};
const meta=id=>read(path.join(dir(id),'run.json'));
const output=v=>console.log(JSON.stringify(v,null,2));
const command=(argv,cwd)=>{const r=spawnSync(argv[0],argv.slice(1),{cwd,env,encoding:'utf8',timeout:5000,maxBuffer:200000});return r.status===0?r.stdout?.trim():null;};
function parentSelection(){
 const text=fs.readFileSync(path.join(dsh,'profiles/desktop/cordis.patch.yml'),'utf8');
 const block=text.match(/- id: agent-default-model\n([\s\S]*?)(?=\n- id:|$)/)?.[1];
 if(!block)throw Error('Cannot read desktop parent selection');
 const val=k=>block.match(new RegExp('^\\s+'+k+':\\s*([^\\n]+)','m'))?.[1].trim().replace(/^['"]|['"]$/g,'');
 const p={provider:val('provider'),model:val('model')};if(val('reasoningEffort'))p.reasoningEffort=val('reasoningEffort');
 if(!p.provider||!p.model)throw Error('Incomplete desktop parent selection');return p;
}
function status(id){
 const m=meta(id),d=dir(id);
 const owns=(pid,needle)=>alive(pid)&&(command(['ps','-p',String(pid),'-o','command='],home)??'').includes(needle);
 const supervisorAlive=owns(m.supervisorPid,`${self} _run ${m.id}`),childAlive=owns(m.childPid,path.join(d,`overlay-${m.attempt}.json`));
 const startingGrace=m.status==='starting'&&Date.now()-Date.parse(m.startedAt)<15000;
 if(['starting','running','stopping'].includes(m.status)&&!supervisorAlive&&!startingGrace)m.status=childAlive?'orphaned':'interrupted';
 let events=[];try{const p=path.join(d,`events-${m.attempt}.jsonl`),fd=fs.openSync(p,'r'),size=fs.fstatSync(fd).size,b=Buffer.alloc(Math.min(size,65536));fs.readSync(fd,b,0,b.length,Math.max(0,size-b.length));fs.closeSync(fd);events=b.toString().split('\n').flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}});}catch{}
 const recent=events.filter(e=>['tool_call','status','error'].includes(e.type)).slice(-6).map(e=>({type:e.type,tool:e.tool,phase:e.phase,message:e.message,reason:e.reason}));
 return {...m,supervisorAlive,childAlive,recent,log:path.join(d,`events-${m.attempt}.jsonl`)};
}
function locked(cwd,id){const lock=path.join(root,'workspace-'+crypto.createHash('sha256').update(cwd).digest('hex')+'.lock');
 try{fs.mkdirSync(lock,{mode:0o700});fs.writeFileSync(path.join(lock,'owner'),id,{mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;let old;try{old=fs.readFileSync(path.join(lock,'owner'),'utf8');}catch{throw Error('Workspace lock is being initialized; retry shortly');}const prior=status(old);if(prior.supervisorAlive||prior.childAlive||prior.status==='starting')throw Error(`Workspace already has an active run: ${old}`);fs.rmSync(lock,{recursive:true});return locked(cwd,id);}return lock;
}
function launch(m,prompt){
 const d=dir(m.id);m.lock=locked(m.cwd,m.id);
 try{
  m.attempt=(m.attempt??0)+1;m.status='starting';m.parent=parentSelection();const teamPath=path.join(dsh,'local-plugins/claude-codex-team/settings.json');m.team=fs.existsSync(teamPath)?read(teamPath):{worker_provider:'codex',worker_model:'gpt-6.1-sol',max_parallel:4,parallelism_mode:'auto',nested_model:'gpt-6-luna',nested_parallel:2,max_depth:2};m.startedAt=new Date().toISOString();delete m.endedAt;delete m.exitCode;delete m.signal;delete m.error;delete m.childPid;delete m.supervisorPid;
  fs.rmSync(path.join(d,'stop'),{force:true});fs.writeFileSync(path.join(d,`prompt-${m.attempt}.txt`),prompt,{mode:0o600});
  write(path.join(d,`overlay-${m.attempt}.json`),[{id:'agent-default-model',config:m.parent}]);write(path.join(d,'run.json'),m);
  const log=fs.openSync(path.join(d,`supervisor-${m.attempt}.log`),'a',0o600);
  const child=spawn(process.execPath,[self,'_run',m.id],{detached:true,env,stdio:['ignore',log,log]});child.unref();fs.closeSync(log);
  return {id:m.id,status:'starting',cwd:m.cwd,parent:m.parent,team:m.team};
 }catch(e){fs.rmSync(m.lock,{recursive:true,force:true});throw e;}
}
async function supervise(id){
 const d=dir(id),m=meta(id);m.supervisorPid=process.pid;write(path.join(d,'run.json'),m);
 const out=fs.openSync(path.join(d,`events-${m.attempt}.jsonl`),'a',0o600),err=fs.openSync(path.join(d,`stderr-${m.attempt}.log`),'a',0o600);
 const args=['--profile','dots-control','--patch',path.join(d,`overlay-${m.attempt}.json`),'--json',...(m.sessionId?['--session-id',m.sessionId]:[]),'-'];
 const child=spawn(cli,args,{cwd:m.cwd,env,detached:true,stdio:['pipe','pipe',err]});m.childPid=child.pid;m.status='running';write(path.join(d,'run.json'),m);
 let partial='',stopping=false,forceTimer,closing=false;
 const kill=sig=>{if(child.pid&&alive(child.pid))try{process.kill(-child.pid,sig);}catch{}};
 const stop=()=>{if(stopping)return;stopping=true;m.status='stopping';write(path.join(d,'run.json'),m);kill('SIGINT');forceTimer=setTimeout(()=>kill('SIGKILL'),10000);};
 const timer=setInterval(()=>{if(fs.existsSync(path.join(d,'stop')))stop();},250);
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 child.stdout.on('data',chunk=>{fs.writeSync(out,chunk);partial+=chunk.toString();let i;while((i=partial.indexOf('\n'))>=0){const l=partial.slice(0,i);partial=partial.slice(i+1);try{const e=JSON.parse(l);if(e.type==='session'){m.sessionId=e.sessionId;write(path.join(d,'run.json'),m);}if(e.type==='final')fs.writeFileSync(path.join(d,`result-${m.attempt}.txt`),e.text,{mode:0o600});if(e.type==='error')m.error=e.message;}catch{}}});
 const done=(code,signal,error)=>{if(closing)return;closing=true;clearInterval(timer);clearTimeout(forceTimer);m.exitCode=code;m.signal=signal;m.status=stopping?'stopped':code===0?'completed':'failed';if(error)m.error=error.message;m.endedAt=new Date().toISOString();write(path.join(d,'run.json'),m);fs.closeSync(out);fs.closeSync(err);fs.rmSync(m.lock,{recursive:true,force:true});};
 child.on('error',e=>done(null,null,e));child.on('close',(c,s)=>done(c,s));child.stdin.on('error',()=>{});child.stdin.end(fs.readFileSync(path.join(d,`prompt-${m.attempt}.txt`)));
}
try{
 const [action,...args]=process.argv.slice(2);
 if(action==='_run')await supervise(args[0]);
 else if(action==='start'){
  const [workspace,promptFile]=args;if(!workspace||!promptFile)throw Error('start <absolute workspace> <prompt file>');
  if(!path.isAbsolute(workspace))throw Error('Workspace must be an absolute path');const cwd=fs.realpathSync(workspace);if(!fs.statSync(cwd).isDirectory())throw Error('Workspace is not a directory');
  const prompt=fs.readFileSync(promptFile,'utf8');if(!prompt.trim())throw Error('Empty task');
  const id='run-'+crypto.randomUUID();fs.mkdirSync(dir(id),{mode:0o700});output(launch({id,cwd,gitBefore:command(['git','status','--short'],cwd)??null},prompt));
 }else if(action==='list')output(fs.readdirSync(runs).filter(n=>n.startsWith('run-')).flatMap(id=>{try{const s=status(id);return [{id,status:s.status,cwd:s.cwd,startedAt:s.startedAt,sessionId:s.sessionId}];}catch{return [];}}));
 else if(action==='status')output(status(args[0]));
 else if(action==='stop'){
  const s=status(args[0]);if(!s.supervisorAlive&&s.status!=='starting'){if(s.childAlive)throw Error('Supervisor is unavailable; inspect this owned run before stopping its process group');output(s);}else{fs.writeFileSync(path.join(dir(s.id),'stop'),'requested\n',{mode:0o600});output({id:s.id,status:'stop_requested'});}
 }else if(action==='resume'){
  const s=status(args[0]);if(s.supervisorAlive||s.childAlive||s.status==='starting')throw Error('Run is still active');if(!s.sessionId)throw Error('No persisted session was created; start a new run');
  const prompt=args[1]?fs.readFileSync(args[1],'utf8'):'中断前の履歴と現在のファイルを確認して、未完了の依頼を続けてください。';if(!prompt.trim())throw Error('Empty continuation');output(launch(meta(s.id),prompt));
 }else if(action==='result'){
  const s=status(args[0]);let text=null;try{text=fs.readFileSync(path.join(dir(s.id),`result-${s.attempt}.txt`),'utf8');}catch{}
  output({...s,result:text,gitBefore:s.gitBefore,gitNow:command(['git','status','--short'],s.cwd)??null,diffStatNow:command(['git','diff','--stat'],s.cwd)??null,note:'Git output covers the current workspace, including pre-existing edits. Test evidence is in the run events; a model answer alone does not prove tests passed.'});
 }else output({usage:['start <absolute workspace> <prompt file>','list','status <run ID>','stop <run ID>','resume <run ID> [continuation file]','result <run ID>'],profile:'dots-control'});
}catch(e){console.error(JSON.stringify({error:e.message}));process.exitCode=1;}
