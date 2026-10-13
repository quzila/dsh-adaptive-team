import {randomUUID} from 'node:crypto';

// Runtime-only details. Prompts and results never enter the public repository or a log file.
const sessions=new Map();
export function beginActivity(sessionId,details){
 if(typeof sessionId!=='string'||!sessionId)return null;
 if(!sessions.has(sessionId)&&sessions.size>=100)sessions.delete(sessions.keys().next().value);
 const rows=sessions.get(sessionId)??[];
 const row={id:randomUUID(),status:'running',startedAt:Date.now(),...details};
 rows.push(row);
 if(rows.length>100)rows.splice(0,rows.length-100);
 sessions.set(sessionId,rows);
 return row.id;
}
export function finishActivity(sessionId,id,status,output=''){
 const row=sessions.get(sessionId)?.find(r=>r.id===id);
 if(!row)return;
 row.status=status;row.finishedAt=Date.now();row.output=String(output).slice(0,40000);
}
export function listActivities(sessionId){
 if(typeof sessionId!=='string'||!sessionId)return [];
 return (sessions.get(sessionId)??[]).map(r=>({...r}));
}
