import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

// Private local session records. They are never written to the public repository.
const sessions=new Map();
const root=()=>join(process.env.DSH_HOME??join(homedir(),'.dsh'),'local-plugins/claude-codex-team/activities');
const validSession=id=>typeof id==='string'&&/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
function persist(sessionId,row){
 if(!validSession(sessionId))return;
 const dir=join(root(),sessionId);mkdirSync(dir,{recursive:true,mode:0o700});
 const file=join(dir,`${row.id}.json`),temp=`${file}.${process.pid}.tmp`;
 writeFileSync(temp,JSON.stringify(row),{mode:0o600});renameSync(temp,file);
}
export function beginActivity(sessionId,details){
 if(typeof sessionId!=='string'||!sessionId)return null;
 if(!sessions.has(sessionId)&&sessions.size>=100)sessions.delete(sessions.keys().next().value);
 const rows=sessions.get(sessionId)??[];
 const row={id:randomUUID(),status:'running',startedAt:Date.now(),...details};
 rows.push(row);
 if(rows.length>100)rows.splice(0,rows.length-100);
 sessions.set(sessionId,rows);
 persist(sessionId,row);
 return row.id;
}
export function finishActivity(sessionId,id,status,output=''){
 const row=sessions.get(sessionId)?.find(r=>r.id===id);
 if(!row)return;
 row.status=status;row.finishedAt=Date.now();row.output=String(output).slice(0,40000);
 persist(sessionId,row);
}
export function attachActivityChild(sessionId,id,childSessionId){
 const row=sessions.get(sessionId)?.find(r=>r.id===id);if(!row)return;
 row.childSessionId=childSessionId;persist(sessionId,row);
}
export function updateActivityStream(sessionId,id,delta,completed=false){
 const row=sessions.get(sessionId)?.find(r=>r.id===id);if(!row)return;
 if(completed){delete row.stream;return;}
 if(typeof delta==='string')row.stream=String(row.stream??'').concat(delta).slice(-20000);
}
export function listActivities(sessionId){
 if(typeof sessionId!=='string'||!sessionId)return [];
 const merged=new Map();
 if(validSession(sessionId)){const dir=join(root(),sessionId);if(existsSync(dir))for(const name of readdirSync(dir).filter(name=>/^[0-9a-f-]{36}\.json$/.test(name)).slice(-100)){try{const row=JSON.parse(readFileSync(join(dir,name),'utf8'));if(row.id)merged.set(row.id,row.status==='running'?{...row,status:'recorded'}:row);}catch{}}}
 for(const row of sessions.get(sessionId)??[])merged.set(row.id,row);
 return [...merged.values()].sort((a,b)=>a.startedAt-b.startedAt).slice(-100).map(r=>({...r}));
}
