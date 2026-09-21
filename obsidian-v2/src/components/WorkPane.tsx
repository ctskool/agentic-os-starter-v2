import {h} from 'preact';
import {useEffect,useId,useRef,useState} from 'preact/hooks';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import terminalCss from '@xterm/xterm/css/xterm.css';
import {workRequest,workFeed,fullAnswer,chooseWork,workTarget,publishWorkTask,isLiveTerminal,scriptStatus,checkedRecovery,readRecovery,preserveRecovery,type RecoveredWorkRequest,type WorkTask} from '../lib/work';
import type {VoiceSelection} from '../../shared/voice-session';
import {replayTerminal} from '../../shared/terminal-playback';
import {draftKey,readDraft,saveDraft,copyDraftToNewTask} from '../../shared/drafts';
import {isOpenWork,isHistoryWork,taskStatus,shortTaskTitle} from '../../shared/work-presentation';
import type {App} from 'obsidian';
import {writeIntent} from '../lib/queue';

function LiveTerminal({task,onError}:{task:WorkTask;onError:(message:string)=>void}){
 const host=useRef<HTMLDivElement>(null);
 const readOnly=task.state==='stopping';
 useEffect(()=>{
  if(!host.current)return;
  const term=new Terminal({fontFamily:'"IBM Plex Mono", Consolas, monospace',fontSize:13,convertEol:false,scrollback:2500,theme:{background:'#080c12',foreground:'#e5e9ef'},allowProposedApi:false,disableStdin:readOnly});
  const fit=new FitAddon();term.loadAddon(fit);term.open(host.current);
  const css=document.createElement('style');css.textContent=terminalCss;host.current.appendChild(css);
  let gone=false,busy=false,cursor=0,instance='',chain=Promise.resolve();
  // Ordered keyboard writes prevent fast typing from arriving out of order.
  const input=term.onData(data=>{chain=chain.then(()=>workRequest('/input',{id:task.id,data})).then(()=>{}).catch(e=>{if(!gone)onError(String(e.message||e))})});
  const poll=async()=>{if(gone||busy||document.hidden||!host.current?.getClientRects().length)return;busy=true;try{const r=await workRequest(`/output?id=${task.id}&cursor=${cursor}&instance=${instance}`);if(gone)return;await replayTerminal(term,r,()=>gone);cursor=r.cursor;instance=r.instance}catch(e){if(!gone)onError(String(e))}finally{busy=false}};
  const resize=()=>{if(!host.current?.clientWidth||!host.current?.clientHeight)return;fit.fit();if(host.current.contains(document.activeElement))void workRequest('/resize',{id:task.id,cols:Math.max(20,Math.min(300,term.cols)),rows:Math.max(5,Math.min(120,term.rows))}).catch(()=>{})};
  const element=host.current;element.addEventListener('focusin',resize);
  const observer=new ResizeObserver(resize);observer.observe(host.current);resize();void poll();
  const timer=window.setInterval(()=>void poll(),150);
  return()=>{gone=true;clearInterval(timer);observer.disconnect();element.removeEventListener('focusin',resize);input.dispose();term.dispose();css.remove()};
 },[task.id,readOnly]);
 return <div className="aos-work-terminal" ref={host} aria-label="Interactive terminal"/>;
}
export function WorkPane({app,getSelection,taskId,onOpenTask}:{app?:App;getSelection:()=>Promise<VoiceSelection>;taskId?:string|null;onOpenTask?:(id:string|null)=>void}){
 const [tasks,setTasks]=useState<WorkTask[]>([]),[localSelected,setSelected]=useState<string|null>(workTarget()),[hidden,setHidden]=useState<string[]>([]);
 const selected=onOpenTask?taskId??null:localSelected;
 const historyId=useId();
 const [opened,setOpened]=useState<string[]>([]),[history,setHistory]=useState(false),[messageBox,setMessageBox]=useState(false);
 const [prompt,setPrompt]=useState(''),[error,setError]=useState(''),[sending,setSending]=useState(false);
 const [vault,setVault]=useState('');
 const [services,setServices]=useState<any>(null);
 const storageKey=draftKey('obsidian',vault,selected);
 const view=useRef({storageKey,vault,selected});view.current={storageKey,vault,selected};
 const operation=useRef(false);
 useEffect(()=>{if(vault)setPrompt(readDraft(localStorage,storageKey))},[vault,storageKey]);
 const [recovery,setRecovery]=useState<RecoveredWorkRequest|null>(null),[recoveryError,setRecoveryError]=useState('');
 useEffect(()=>{if(!vault||selected)return;try{setRecovery(readRecovery(localStorage,draftKey('obsidian',vault,null)));setRecoveryError('')}catch(e){setRecovery(null);setRecoveryError(String(e))}},[vault,selected]);
 const recover=async()=>{if(!current||operation.current||!vault)return;operation.current=true;setSending(true);setError('');const captured=view.current;try{
  const saved=checkedRecovery(await workRequest('/request?id='+encodeURIComponent(current.id)));
  if(view.current.storageKey!==captured.storageKey)throw new Error('The selected task changed. Select the request again to recover it.');
  const key=draftKey('obsidian',captured.vault,null);if(readDraft(localStorage,key).trim())throw new Error('Your new-task draft is already occupied. Save or submit it before recovering this request.');
  preserveRecovery(localStorage,key,saved);setRecovery(saved);setRecoveryError('');select(null);setPrompt(saved.prompt);
 }catch(e){setError(String(e))}finally{operation.current=false;setSending(false)}};
 const edit=(text:string)=>{setPrompt(text);try{
  if(!selected&&recovery&&text.trim())setRecovery(preserveRecovery(localStorage,storageKey,{...recovery,prompt:text}));
  else{if(!saveDraft(localStorage,storageKey,text))throw new Error('Draft could not be saved locally. Copy it before reloading.');if(!selected&&!text.trim()){localStorage.removeItem(storageKey+':selection');setRecovery(null);setRecoveryError('')}}
 }catch(e){setError(String(e))}};
 const discardRecovery=()=>{if(operation.current||selected)return;try{if(!saveDraft(localStorage,storageKey,''))throw new Error('Could not clear the recovered draft.');localStorage.removeItem(storageKey+':selection');setRecovery(null);setRecoveryError('');setPrompt('')}catch(e){setError(String(e))}};
 const refresh=()=>workFeed.refresh();
 const select=(id:string|null)=>{setHistory(false);if(id){setOpened(v=>v.includes(id)?v:[...v,id]);setHidden(v=>v.filter(x=>x!==id))}if(onOpenTask)onOpenTask(id);else{setSelected(id);chooseWork(id)}};
 useEffect(()=>{
  const off=workFeed.subscribe((r:{tasks:WorkTask[];vault:string;error:string})=>{setTasks(r.tasks);setVault(r.vault);if(r.error)setError(r.error)});
  const opened=(e:Event)=>{const ids=(e as CustomEvent<string[]>).detail;if(ids.length){setHidden(v=>v.filter(id=>!ids.includes(id)));setOpened(v=>[...new Set([...v,...ids])]);setSelected(ids[0]!);setHistory(false)}void refresh()};
  if(!onOpenTask)window.addEventListener('aos-open-work',opened);return()=>{off();if(!onOpenTask)window.removeEventListener('aos-open-work',opened)};
 },[]);
 const current=tasks.find(t=>t.id===selected);
 const missing=!!selected&&!!vault&&!current;
 const useExpiredDraft=()=>{if(operation.current||!missing)return;try{copyDraftToNewTask(localStorage,'obsidian',vault,prompt);setError('');select(null)}catch(e){setError(String(e))}};
 const [readyCheck,setReadyCheck]=useState(false);
 useEffect(()=>setReadyCheck(false),[selected,current?.state]);
 useEffect(()=>setMessageBox(false),[selected]);
 const [answer,setAnswer]=useState('');
 const answerId=current?.turns.at(-1)?.id;
 useEffect(()=>{let gone=false;setAnswer('');if(current)void fullAnswer(current).then(text=>{if(!gone)setAnswer(text)}).catch(e=>{if(!gone)setError(String(e))});return()=>{gone=true}},[selected,answerId]);
 const action=async(name:string,data:Record<string,unknown>={})=>{if(!current||operation.current)return;operation.current=true;setSending(true);try{
  setError('');const updated=await workRequest('/'+name,{id:current.id,...data});
  if(name==='keep'){const snapshot=workFeed.getSnapshot();workFeed.publish({...snapshot,tasks:snapshot.tasks.map((task:WorkTask)=>task.id===updated.id?{...task,keep:updated.keep,lastActivityAt:updated.lastActivityAt,expiresAt:updated.expiresAt}:task)})}
  setReadyCheck(false);await refresh();
 }catch(e){setError(String(e))}finally{operation.current=false;setSending(false)}};
 const submit=async()=>{if(!prompt.trim()||operation.current||!vault)return;const capturedKey=storageKey,capturedPrompt=prompt,capturedView=view.current;operation.current=true;setSending(true);setError('');try{
  if(selected&&!current)throw new Error('This conversation is unavailable. Your draft has not been sent.');
  let opened:string|null=null;
  if(current){if(current.execution==='script'||!isLiveTerminal(current)||current.state!=='ready')throw new Error('Wait for this task to be ready, or respond directly in its terminal.');await workRequest('/send',{id:current.id,text:capturedPrompt})}
  else{
   if(recoveryError)throw new Error(recoveryError);
   const saved=recovery?checkedRecovery({...recovery,prompt:capturedPrompt}):null,chosen=saved?.selection||await getSelection();
   if(saved?.skill){
    if(!app)throw new Error('Open this workflow from the dashboard to retry it.');
    await writeIntent(app,saved.skill,saved.args,saved.selection);
   }else{
    const r=await workRequest('/start',{id:crypto.randomUUID(),selection:saved?.selection||(chosen.provider==='codex'?{provider:'codex',model:'gpt-6-astra'}:chosen),prompt:capturedPrompt});
    publishWorkTask(r);opened=r.id;
   }
  }
  if(readDraft(localStorage,capturedKey)===capturedPrompt){
   if(saveDraft(localStorage,capturedKey,'')){if(!capturedView.selected){try{localStorage.removeItem(capturedKey+':selection')}catch{setError('The request was sent, but its old recovery settings could not be cleared locally.')}}}
   else setError('The request was sent. Its local draft could not be cleared; avoid submitting that saved draft again.');
  }
  if(view.current.storageKey===capturedKey){setPrompt(readDraft(localStorage,capturedKey));if(!capturedView.selected){setRecovery(null);setRecoveryError('')}if(opened)select(opened)}
  await refresh();
 }catch(e){setError(String(e))}finally{operation.current=false;setSending(false)}};
 const terminalLive=current?isLiveTerminal(current):false;
 const scriptActive=current?.execution==='script'&&['starting','working','stopping'].includes(current.state);
 return <div className="aos-work-pane" data-provider={current?.provider||recovery?.selection.provider||'codex'}>
  <header className="aos-work-header"><strong>{current?current.execution==='script'?'Source refresh':current.provider==='codex'?'Codex':'Claude Code':'Terminals'}</strong>{current&&<span className="aos-terminal-status" data-state={current.state}>{taskStatus(current)}</span>}<button onClick={()=>select(null)}>+ New terminal</button><button aria-expanded={history} aria-controls={historyId} onClick={()=>setHistory(!history)}>History</button></header>
  {history&&<section id={historyId} className="aos-terminal-history" aria-label="Conversation history">
   <p>Closed conversations clear after 7 days. Keep saves them.</p>
   {tasks.filter(isHistoryWork).length?tasks.filter(isHistoryWork).map(t=><button key={t.id} onClick={()=>select(t.id)} title={t.title}><span>{shortTaskTitle(t,90)}</span><small>{t.provider==='codex'?'Codex':'Claude Code'} · {taskStatus(t)}{t.keep?' · Kept':''}</small></button>):<p>No saved conversations yet.</p>}
  </section>}
  {!onOpenTask&&<nav className="aos-work-tabs" aria-label="Terminal tabs">{tasks.filter(t=>!hidden.includes(t.id)&&(isOpenWork(t)||opened.includes(t.id)||selected===t.id)).map(t=><div key={t.id} className={selected===t.id?'is-active':''}>
   <button className="aos-work-tab-select" aria-pressed={selected===t.id} title={t.title} onClick={()=>select(t.id)}><span>{shortTaskTitle(t,42)}</span><small>{taskStatus(t)}</small></button>
   <button className="aos-work-tab-close" aria-label={`Hide ${t.title}`} title="Hide tab; keep terminal running" onClick={()=>{setHidden(v=>[...v,t.id]);if(selected===t.id)select(null)}}>×</button>
  </div>)}</nav>}
  <div className="aos-work-body">
   {current?<>
    <div className="aos-work-meta"><span title={current.title}>{shortTaskTitle(current,100)}</span><div className="aos-work-task-actions">
     {terminalLive&&<button aria-expanded={messageBox} onClick={()=>setMessageBox(!messageBox)}>Message{prompt.trim()?' •':''}</button>}
     {!terminalLive&&current.execution!=='script'&&current.sessionId&&<button disabled={sending} onClick={()=>void action('resume')}>Resume</button>}
     <details className="aos-terminal-options"><summary>Options</summary><div><button disabled={sending} aria-pressed={!!current.keep} title={current.keep?'Allow automatic cleanup after seven days of inactivity':'Keep this conversation from automatic cleanup'} onClick={()=>void action('keep',{keep:!current.keep})}>{current.keep?'Kept':'Keep'}</button>{current.recoveryAvailable&&<button disabled={sending} onClick={()=>void recover()}>{current.workflow?'Recover workflow':'Recover request'}</button>}<small>{current.model}</small></div></details>
     {(terminalLive||scriptActive)&&<button disabled={sending||current.state==='stopping'} onClick={()=>void action('stop')}>Stop</button>}
    </div></div>
    {current.state==='needs input'&&<p className="aos-work-error" role="status">{current.inputReason||'Respond to the prompt in the terminal.'}</p>}
    {current.execution==='script'?<p className="aos-work-stopped" role="status">{scriptStatus(current)}</p>:terminalLive?<LiveTerminal task={current} onError={setError}/>:<p className="aos-work-stopped">{current.sessionId?'This task is stopped. Resume to continue the same conversation.':'This request stopped before a session was saved. Recover it to review and start a new task.'}</p>}
    {current.turns.length>0&&<details className="aos-work-answer" open={!terminalLive}><summary>Saved answer</summary><pre>{answer||current.turns.at(-1)?.text}</pre></details>}
   </>:<div className="aos-work-empty"><strong>{missing?'Conversation no longer saved':selected?'Loading terminal…':'Ready when you are'}</strong><p>{missing?'Any unsent draft is still below.':'Ask by voice or describe a job below. Longer requests open their own terminal tab.'}</p>{missing&&prompt.trim()&&<button disabled={sending} onClick={useExpiredDraft}>Use draft in new task</button>}
    {!selected&&tasks.some(isOpenWork)&&<div className="aos-open-terminals" aria-label="Open terminals">{tasks.filter(isOpenWork).map(t=><button key={t.id} onClick={()=>select(t.id)}>{shortTaskTitle(t,48)} <small>{taskStatus(t)}</small></button>)}</div>}
   </div>}
  </div>
  {(error||current?.error)&&<p className="aos-work-error" role="alert">{error||current?.error}</p>}
  {!selected&&(recovery||recoveryError)&&<div><small>{recovery?`Recovered ${recovery.skill?'workflow':'request'} · ${recovery.selection.provider} · ${recovery.selection.model}`:recoveryError}</small><button disabled={sending} onClick={discardRecovery}>Discard recovery</button>{recovery?.skill&&<details><summary>Workflow settings: {recovery.skill}</summary><pre>{JSON.stringify(recovery.args,null,2)}</pre></details>}</div>}
  {messageBox&&terminalLive&&!['ready','stopping'].includes(current!.state)&&<div className="aos-message-guard"><button disabled={sending} onClick={()=>setReadyCheck(!readyCheck)}>Enable message box</button>{readyCheck&&<p role="status">Wait for the CLI to finish and clear any text in its input. Answer approvals in the terminal. <button disabled={sending} onClick={()=>void action('ready',{confirmedEmpty:true})}>CLI is idle and input is empty</button></p>}</div>}
  {(!selected||missing||messageBox||!terminalLive&&!!prompt.trim())&&current?.execution!=='script'&&<form className="aos-work-compose" onSubmit={e=>{e.preventDefault();void submit()}}><textarea disabled={sending||!vault} readOnly={!selected&&!!recovery?.skill} aria-label={selected?'Follow up on task':recovery?.skill?'Recovered workflow request':'New task request'} value={prompt} placeholder={current?'Continue this conversation…':'What would you like to work on?'} onInput={e=>edit(e.currentTarget.value)} maxLength={12000}/><button disabled={sending||!vault||!prompt.trim()||!!recoveryError&&!selected||!!selected&&(!terminalLive||current?.state!=='ready')}>{selected?'Send follow-up':recovery?.skill?'Retry workflow':'Open terminal'}</button></form>}
  <footer className="aos-work-footer"><small>{terminalLive?'Type directly in the terminal. Closing its tab keeps it running.':selected?'Saved conversation':'Quick voice answers stay in voice.'}</small>
   <details onToggle={e=>{if(e.currentTarget.open)void workRequest('/services').then(setServices).catch(e=>setError(String(e)))}}><summary>Services & connections</summary>{services&&<p>Bridge online · {services.bridge.memoryMiB} MiB. Speech: {services.speech.health?.ok?'online':'unavailable'}{services.speech.shared?' (shared)':''}. Each CLI uses its own sign-in. Stop ends a task process and can lose unsent text inside the CLI.</p>}{services?.providers&&Object.entries(services.providers).map(([provider,value])=>{const cli=value as {version?:string;command?:string;detail?:string};return <p key={provider}><strong>{provider}: {cli.version||'unavailable'}</strong><br/><small>{cli.command||cli.detail}</small></p>})}</details>
  </footer>
 </div>;
}
