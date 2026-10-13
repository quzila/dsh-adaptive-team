import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {providers} from './settings.js';

export const planGraphPath=join(process.env.DSH_HOME??join(homedir(),'.dsh'),'local-plugins/claude-codex-team/plan-graph.json');
export function sessionPlanPath(sessionId){if(typeof sessionId!=='string'||!/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId))throw Error('Invalid session ID');return join(process.env.DSH_HOME??join(homedir(),'.dsh'),'local-plugins/claude-codex-team/plan-graphs',`${sessionId}.json`);}
export function validatePlanGraph(graph){
 if(!graph||typeof graph!=='object'||Array.isArray(graph)||!Array.isArray(graph.nodes)||!Array.isArray(graph.edges)||graph.nodes.length>12||graph.edges.length>24)throw Error('Plan graph needs at most 12 nodes and 24 connections');
 const ids=new Set();
 for(const node of graph.nodes){
  if(!node||typeof node!=='object'||Array.isArray(node)||Object.keys(node).some(k=>!['id','role','instruction','provider','model'].includes(k)))throw Error('Invalid plan node');
  if(typeof node.id!=='string'||!/^[-a-zA-Z0-9_]{1,40}$/.test(node.id)||node.id==='parent'||ids.has(node.id))throw Error('Plan node IDs must be unique');ids.add(node.id);
  if(typeof node.role!=='string'||!node.role.trim()||node.role.length>80||typeof node.instruction!=='string'||!node.instruction.trim()||node.instruction.length>4000)throw Error('Plan node role and instruction are required');
  if(!providers.includes(node.provider)||typeof node.model!=='string'||!node.model.trim()||node.model.length>160)throw Error('Invalid plan node model');
 }
 const links=new Set(),incoming=new Map([...ids].map(id=>[id,0])),adj=new Map(['parent',...ids].map(id=>[id,[]]));
 for(const edge of graph.edges){
  if(!edge||typeof edge!=='object'||Array.isArray(edge)||Object.keys(edge).some(k=>!['from','to'].includes(k))||typeof edge.from!=='string'||typeof edge.to!=='string')throw Error('Invalid plan connection');
  if(!adj.has(edge.from)||!ids.has(edge.to)||edge.from===edge.to)throw Error('Plan connection references an unknown or identical node');
  const key=`${edge.from}\0${edge.to}`;if(links.has(key))throw Error('Duplicate plan connection');links.add(key);adj.get(edge.from).push(edge.to);incoming.set(edge.to,incoming.get(edge.to)+1);
 }
 const pending=['parent'],seen=new Set();while(pending.length){const id=pending.shift();if(seen.has(id))continue;seen.add(id);pending.push(...adj.get(id));}
 if(seen.size!==ids.size+1)throw Error('Every plan node needs a path from the parent');
 const queue=['parent',...[...incoming].filter(([,count])=>count===0).map(([id])=>id)];let visited=0;while(queue.length){const id=queue.shift();visited++;for(const to of adj.get(id)){incoming.set(to,incoming.get(to)-1);if(incoming.get(to)===0)queue.push(to);}}
 if(visited!==ids.size+1)throw Error('Plan graph connections must not form a cycle');
 return {nodes:graph.nodes.map(node=>({...node})),edges:graph.edges.map(edge=>({...edge}))};
}
export function readPlanGraph(path=planGraphPath){try{return validatePlanGraph(JSON.parse(readFileSync(path,'utf8')));}catch(error){if(error.code==='ENOENT')return {nodes:[],edges:[]};throw error;}}
export function savePlanGraph(graph,path=planGraphPath){const value=validatePlanGraph(graph);mkdirSync(join(path,'..'),{recursive:true,mode:0o700});const temp=`${path}.${process.pid}.${randomUUID()}.tmp`;writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(temp,path);return value;}
export const readSessionPlanGraph=sessionId=>readPlanGraph(sessionPlanPath(sessionId));
export const saveSessionPlanGraph=(sessionId,graph)=>savePlanGraph(graph,sessionPlanPath(sessionId));
