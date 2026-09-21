import {App,Modal,Notice} from 'obsidian';
import {SKILLS} from '../../shared/contract.mjs';
import {writeIntent} from '../lib/queue';
import {askForArg} from './IntentArgModal';

export function openWorkflowPicker(app:App){new WorkflowModal(app).open()}
class WorkflowModal extends Modal {
 private choosing=false;
 onOpen(){
  this.contentEl.addClass('aos-v2-cc-modal');
  this.contentEl.createEl('h2',{text:'Run a workflow'});
  const search=this.contentEl.createEl('input');search.type='search';search.placeholder='Find a workflow';search.setAttribute('aria-label','Find a workflow');search.style.width='100%';
  const list=this.contentEl.createDiv();Object.assign(list.style,{display:'grid',gap:'6px',maxHeight:'50vh',overflowY:'auto',marginTop:'12px'});
  const show=()=>{
   list.empty();
   const entries=Object.entries(SKILLS).filter(([id,spec])=>id!=='voice-ask'&&`${id} ${spec.label}`.toLowerCase().includes(search.value.toLowerCase()));
   for(const [id,spec] of entries){
    const button=list.createEl('button',{text:spec.label+(spec.direct?' · Refresh':'')});button.type='button';button.onclick=()=>void this.choose(id);
   }
   if(!entries.length)list.createEl('p',{text:'No matching workflow.'});
  };
  search.addEventListener('input',show);show();search.focus();
 }
 private async choose(id:string){
  if(this.choosing)return;this.choosing=true;this.close();
  try{
   const spec=SKILLS[id],args:Record<string,string>={};if(!spec)throw new Error('Unknown workflow');
   if(spec.arg){const value=await askForArg(this.app,spec.label,spec.arg==='url'?'https://…':'What should this focus on?');if(!value)return;args[spec.arg]=value}
   await writeIntent(this.app,id,args);
  }catch(e){new Notice(`Could not start workflow: ${e instanceof Error?e.message:String(e)}`)}
 }
 onClose(){this.contentEl.empty()}
}
