import {useEffect,useRef,useState} from 'react';
import {chooseWork,workFeed,workTarget,workProvider,workSelectionError,type WorkTask} from './work';
import {voice} from './voiceClient';

export function useAgentWork(){
  const [tasks,setTasks]=useState<WorkTask[]>([]);
  const [target,setTarget]=useState<string|null>(null);
  const [viewTarget,setViewTarget]=useState<string|null>(null);
  const [selectionError,setSelectionError]=useState('');
  const selecting=useRef(0);
  const [open,setOpen]=useState(false);
  const [error,setError]=useState('');
  const [loaded,setLoaded]=useState(false);
  useEffect(()=>{
    let active=true;
    const off=workFeed.subscribe((r:{tasks:WorkTask[];vault:string;error:string})=>{
      if(!active)return;
      const next=r.tasks.filter(task=>task.execution!=='headless'&&!task.background);setTasks(next);setError(r.error);
      if(r.vault)setLoaded(true);
    });
    const update=()=>workFeed.refresh();
    let lastProvider:string|undefined,lastTarget:string|null|undefined;
    const changed=()=>{
      const next=workTarget(),provider=workProvider();
      // Clearing voice context leaves an already inspected terminal in place.
      // Provider changes still restore that provider's selected conversation.
      if(provider!==lastProvider||next!==lastTarget&&next!==null)setViewTarget(next);
      lastTarget=next;lastProvider=provider;setTarget(next);setSelectionError(workSelectionError());
    };
    const opened=(e:Event)=>{
      const id=(e as CustomEvent<{ids?:string[]}>).detail?.ids?.[0];if(id)setViewTarget(id);
      setOpen(true);void update();
    };
    changed();
    window.addEventListener('jarvis-work-target',changed);
    window.addEventListener('jarvis-open-work',opened);
    return()=>{active=false;off();window.removeEventListener('jarvis-work-target',changed);window.removeEventListener('jarvis-open-work',opened)};
  },[]);
  const select=async(id:string|null)=>{
    const request=++selecting.current;voice.stop();setSelectionError('');
    const task=tasks.find(task=>task.id===id),provider=task?.provider||workProvider();
    // Script receipts can be inspected, but are never voice conversation targets.
    if(task?.execution==='script'){setViewTarget(id);setOpen(true);return}
    try{
      if(request!==selecting.current)return;
      setViewTarget(id);await chooseWork(id,provider);
    }catch(e){if(request===selecting.current)setSelectionError(e instanceof Error?e.message:String(e))}
  };
  const selectVoice=async(id:string|null)=>{
    const request=++selecting.current;voice.cancelArtifact();setSelectionError('');
    try{await chooseWork(id,workProvider())}
    catch(e){if(request===selecting.current)setSelectionError(e instanceof Error?e.message:String(e))}
  };
  // Closing a tab dismisses the VIEW of that conversation only. The voice conversation stays selected.
  const dismissView=(id:string)=>setViewTarget(value=>value===id?null:value);
  return {tasks,target,viewTarget,select,selectVoice,dismissView,selectionError,open,setOpen,error:error||selectionError,loaded};
}
