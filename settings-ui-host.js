import {homedir} from 'node:os';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {readSettings,saveSettings,validateSettings} from './settings.js';

export function modelCatalog(){
 const base=join(process.env.DSH_HOME??join(homedir(),'.dsh'),'plugins/subscriptions');
 const auth=JSON.parse(readFileSync(join(base,'auth.json'),'utf8'));
 const models=JSON.parse(readFileSync(join(base,'models.json'),'utf8'));
 return Object.fromEntries(['codex','claude'].filter(k=>Object.keys(auth[k]?.accounts??{}).length).map(k=>[k,(models[k]?.models??[]).map(m=>({id:m.id,name:m.name??m.id}))]));
}
export function validateUiPayload(payload){
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||!payload.parent||!payload.settings)throw Error('Invalid team settings');
 const parent=payload.parent;
 if(!['codex','claude'].includes(parent.provider)||typeof parent.model!=='string'||!parent.model.trim())throw Error('Select a parent model');
 if(parent.reasoningEffort!==undefined&&(typeof parent.reasoningEffort!=='string'||!parent.reasoningEffort))throw Error('Invalid parent reasoning effort');
 validateSettings(payload.settings);
 return payload;
}
export async function saveUiSettings(ctx,payload,signal,{read=readSettings,save=saveSettings}={}){
 validateUiPayload(payload);
 const priorParent=ctx.agentDefaultModel.currentSelection();
 const next={...read(),...payload.settings};
 await ctx.llm.resolveCallConfig(payload.parent,signal);
 await ctx.llm.resolveCallConfig({provider:next.worker_provider,model:next.worker_model},signal);
 await ctx.llm.resolveCallConfig({provider:'codex',model:next.nested_model},signal);
 signal?.throwIfAborted();
 await ctx.agentDefaultModel.saveSelection(payload.parent);
 try{save(payload.settings);}catch(error){
  try{await ctx.agentDefaultModel.saveSelection(priorParent);}catch(rollback){throw Error(`Child settings could not be saved and the parent default could not be restored: ${rollback.message}`);}
  throw error;
 }
 return {settings:read(),parent:ctx.agentDefaultModel.currentSelection()};
}
export function mountSettingsUi(ctx,provider){
 ctx.inject(['connection','agentDefaultModel'],scope=>{
  const connection=scope.get('connection');
  const snapshot=()=>({settings:readSettings(),parent:scope.agentDefaultModel.currentSelection(),models:modelCatalog(),active_workers:provider.active});
  let saves=Promise.resolve();
  for(const endpoint of ['read','save']){
   const method=`adaptive-team.${endpoint}`;
   scope.effect(()=>connection.fetch.register({path:`/api/${method}`,methods:['POST'],requestBody:'buffered',async fetch(request){
    if(request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json')return new Response('JSON required',{status:415});
    let envelope;try{envelope=await request.json();}catch{return new Response('Invalid JSON',{status:400});}
    if(envelope?.type!=='client-request'||typeof envelope.rpcId!=='string'||envelope.method!==method)return new Response('Invalid RPC request',{status:400});
    let result;
    try{
     if(endpoint==='save'){
      const operation=saves.then(()=>saveUiSettings(scope,envelope.payload,request.signal));
      saves=operation.catch(()=>{});await operation;
     }
     result={ok:true,value:snapshot()};
    }catch(error){result={ok:false,error:{message:error.message}};}
    return Response.json({type:'server-response',rpcId:envelope.rpcId,result});
   }}),`adaptive-team settings ${endpoint}`);
  }
 });
}
