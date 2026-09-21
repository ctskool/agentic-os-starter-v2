import fs from 'node:fs';
import path from 'node:path';
import {SKILLS,ROOT} from '../shared/contract.mjs';
import {writeJson} from './core.mjs';
import {saveWorkflowResult} from './terminal-workflows.mjs';

// A button is a bounded report job, not a resumable conversation. The normal
// authenticated CLI executes it with pipes; no PTY or native launch ticket exists.
export function startHeadlessWorkflow(manager,workflow,appScope){
 const {job}=workflow;
 manager.retention.assertNew(job.id);
 const created=manager.now(),record={id:job.id,vault:manager.root,provider:job.provider,model:job.model,prompt:workflow.prompt,title:SKILLS[job.skill].label,created,lastActivityAt:created,keep:false,state:'working',sessionId:null,pid:null,turns:[],error:null,execution:'headless',appScope,recoveryAvailable:false,workflow:{...workflow,startedAt:created}};
 fs.mkdirSync(path.join(manager.folder(job.id),'events'),{recursive:true});manager.records.set(job.id,record);
 const controller=new AbortController(),live={controller,proc:{kill:()=>controller.abort(),resize(){}},output:'',start:0,instance:job.id,sizes:[{at:0,cols:110,rows:30}]};
 try{
  writeJson(manager.root,`${ROOT}/runs/${job.id}.json`,{...job,ts_queued:job.ts,ts_started:new Date(created).toISOString(),ts_completed:null,status:'running',summary:`Running ${SKILLS[job.skill].label}`,execution:'headless',appScope,task_id:job.id,deliverable_path:null});
  manager.save(record);
 }catch(error){
  record.state='error';record.error='Could not save the workflow request. No worker was started.';
  try{saveWorkflowResult(manager.root,record,'BLOCKED: '+record.error);manager.save(record)}catch{}
  throw error;
 }
 manager.live.set(job.id,live);
 live.done=Promise.resolve().then(()=>{
  if(controller.signal.aborted)throw new Error('Workflow stopped.');
  return manager.execute(manager.root,{...job,execution:'headless'},workflow.prompt,{signal:controller.signal});
 }).then(result=>{
  if(manager.live.get(job.id)!==live)return;
  if(controller.signal.aborted)throw new Error('Workflow stopped. The report was not replaced.');
  const text=String(result?.text||'');
  if(!text.trim())throw new Error('The workflow returned no report.');
  if(result?.status==='blocked'){
   saveWorkflowResult(manager.root,record,`BLOCKED: ${String(result.summary||text).slice(0,1000)}\n\n${text}`);record.state='error';return;
  }
  saveWorkflowResult(manager.root,record,text);
  record.state=record.workflowStatus==='ok'?'stopped':'error';
 }).catch(error=>{
  if(manager.live.get(job.id)!==live)return;
  record.error=controller.signal.aborted&&!error.cleanupUnconfirmed?'Workflow stopped. The report was not replaced.':String(error.message||error);
  record.state=controller.signal.aborted&&!error.cleanupUnconfirmed?'stopped':'error';
  try{saveWorkflowResult(manager.root,record,'BLOCKED: '+record.error)}catch(saveError){record.state='error';record.error+=` Could not save the failed run: ${String(saveError.message||saveError)}`;record.workflowStatus='error'}
  if(error.cleanupUnconfirmed){
   // The report is failed, but its worker may still own the destination. Keep
   // the shutdown/source lock until the adapter observes actual process close.
   live.cleanupUnconfirmed=true;record.workflowCompleted=false;
   if(error.closed&&typeof error.closed.then==='function')error.closed.then(()=>{
    if(manager.live.get(job.id)!==live)return;
    manager.live.delete(job.id);record.workflowCompleted=true;record.state='error';manager.touch(record);manager.save(record);
   }).catch(()=>{});
  }
 }).finally(()=>{
  if(manager.live.get(job.id)===live){if(!live.cleanupUnconfirmed)manager.live.delete(job.id);record.pid=null;manager.touch(record);manager.save(record)}
 });
 // Saving to a failing disk may reject the completion promise. Preserve that
 // rejection for an explicit waiter without making it an unhandled process error.
 live.done.catch(()=>{});
 return record;
}
