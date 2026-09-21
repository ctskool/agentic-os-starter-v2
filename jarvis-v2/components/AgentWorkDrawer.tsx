"use client";
import {useEffect,useRef,useState} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {workRequest,setWorkKeep,fullAnswer,getWorkSelection,openWork,type WorkTask} from '@/lib/work';
import {voice} from '@/lib/voiceClient';
import {replayTerminal} from '../../obsidian-v2/shared/terminal-playback';
import {draftKey,readDraft,saveDraft} from '../../obsidian-v2/shared/drafts';
import {readRecoveredDraft,stageRecoveredDraft,stageExpiredTaskDraft,clearRecoveredDraft,updateRecoveryText,type RecoveredDraft,type SavedRequest} from '@/lib/work-recovery';
import {isOpenWork,taskStatus,shortConversationTitle} from '../../obsidian-v2/shared/work-presentation';
import {visibleTerminalTabs,rememberOpenTerminals,tabCloseAction} from '@/lib/terminal-tabs';
import {TerminalTabs} from './TerminalTabs';
import {dashboardStore} from '@/lib/dashboard-store';

function LiveTerminal({id,onError,readOnly=false}:{id:string;onError:(message:string)=>void;readOnly?:boolean}){
  const host=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!host.current)return;
    const term=new Terminal({fontFamily:'Consolas, monospace',fontSize:14,scrollback:2500,theme:{background:'#0b0e14',foreground:'#e5e9ef'},allowProposedApi:false,disableStdin:readOnly});
    const fit=new FitAddon();term.loadAddon(fit);term.open(host.current);
    let gone=false,busy=false,cursor=0,instance='';
    const resize=()=>{
      if(!host.current?.clientWidth||!host.current?.clientHeight)return;
      // An unfocused viewer must not repeatedly resize the shared CLI in Obsidian.
      if(host.current.contains(document.activeElement)){fit.fit();void workRequest('/resize',{id,cols:Math.max(20,Math.min(300,term.cols)),rows:Math.max(5,Math.min(120,term.rows))}).catch(()=>{});}
    };
    // Drain already-captured keystrokes to this task even if its view is closed. The queue belongs to the TERMINAL,
    // not to this mount: a remounted view appends to the same ordered queue, so nothing typed earlier can be
    // overtaken by later input, by a terminal report, or by a close request.
    const input=term.onData(data=>{pendingInput.set(id,(pendingInput.get(id)||Promise.resolve()).then(()=>workRequest('/input',{id,data})).then(()=>{},e=>{if(!gone)onError(String(e.message||e))}))});
    const poll=async()=>{
      if(gone||busy||document.visibilityState!=='visible')return;busy=true;
      try{const r=await workRequest(`/output?id=${id}&cursor=${cursor}&instance=${instance}`);if(gone)return;await replayTerminal(term,r,()=>gone);cursor=r.cursor;instance=r.instance}
      catch(e){if(!gone)onError(e instanceof Error?e.message:String(e))}finally{busy=false}
    };
    const observer=new ResizeObserver(resize);observer.observe(host.current);
    const element=host.current;element.addEventListener('focusin',resize);
    resize();void poll();const timer=setInterval(()=>void poll(),200);
    return()=>{gone=true;clearInterval(timer);observer.disconnect();element.removeEventListener('focusin',resize);input.dispose();term.dispose()};
  },[id,onError,readOnly]);
  return <div className="agent-terminal" ref={host} aria-label="Interactive agent terminal"/>;
}

// Keystrokes captured for a terminal and not yet delivered to the bridge. A close request waits for them, so the
// bridge judges "idle" with everything the user typed already applied.
const pendingInput=new Map<string,Promise<unknown>>();

interface Props {tasks:WorkTask[];tasksLoaded:boolean;target:string|null;voiceTarget:string|null;select:(id:string|null)=>Promise<void>;dismissView?:(id:string)=>void;open:boolean;setOpen:(value:boolean)=>void;connectionError:string;provider:'codex'|'claude';voiceMode:string;voiceMessage:string;vaultRoot:string}
export default function AgentWorkDrawer({tasks,tasksLoaded,target,voiceTarget,select,dismissView,open,setOpen,connectionError,provider,voiceMode,voiceMessage,vaultRoot}:Props){
  const [hidden,setHidden]=useState<string[]>([]),[drafts,setDrafts]=useState<Record<string,string>>({});
  const [opened,setOpened]=useState<string[]>([]),[historyOpen,setHistoryOpen]=useState(false);
  const [messageTarget,setMessageTarget]=useState<string|null>(null),[answerTarget,setAnswerTarget]=useState<string|null>(null);
  const [error,setError]=useState(''),[sending,setSending]=useState(false);
  const sendingRef=useRef(false);
  const begin=()=>{if(sendingRef.current)return false;sendingRef.current=true;setSending(true);setError('');return true};
  const end=()=>{sendingRef.current=false;setSending(false)};
  const [services,setServices]=useState<any>(null);
  const [recovered,setRecovered]=useState<RecoveredDraft|null>(null);
  const current=tasks.find(t=>t.id===target),key=target||'new',prompt=drafts[key]||'';
  const voiceTask=tasks.find(task=>task.id===voiceTarget&&task.provider===provider);
  const lastKnown=useRef<WorkTask|null>(null);
  useEffect(()=>{if(current)lastKnown.current=current},[current]);
  const former=lastKnown.current?.id===target?lastKnown.current:null;
  const unavailable=!!target&&!current&&tasksLoaded&&!connectionError;
  const terminalLive=!!current&&current.execution!=='script'&&isOpenWork(current);
  const scriptActive=!!current&&current.execution==='script'&&isOpenWork(current);
  const showComposer=!target||!current||messageTarget===target;
  const tabs=visibleTerminalTabs(tasks,opened,hidden,target);
  useEffect(()=>setOpened(value=>rememberOpenTerminals(value,tasks,target)),[tasks,target]);
  useEffect(()=>{
    const reveal=(event:Event)=>{const ids=(event as CustomEvent<{ids?:string[]}>).detail?.ids?.filter(id=>typeof id==='string')||[];if(ids.length){setOpened(value=>[...new Set([...value,...ids])]);setHidden(value=>value.filter(id=>!ids.includes(id)));setHistoryOpen(false)}};
    window.addEventListener('jarvis-open-work',reveal);return()=>window.removeEventListener('jarvis-open-work',reveal);
  },[]);
  const [readyCheck,setReadyCheck]=useState(false);
  useEffect(()=>setReadyCheck(false),[target,current?.state]);
  useEffect(()=>{setMessageTarget(null);setAnswerTarget(null)},[target]);
  const [answer,setAnswer]=useState('');
  const answerId=current?.turns.at(-1)?.id;
  useEffect(()=>{let gone=false;setAnswer('');if(open&&current&&answerTarget===current.id)void fullAnswer(current).then(text=>{if(!gone)setAnswer(text)}).catch(e=>{if(!gone)setError(String(e))});return()=>{gone=true}},[open,target,answerId,answerTarget]);
  const storageKey=draftKey('jarvis',vaultRoot,target);
  const newStorageKey=draftKey('jarvis',vaultRoot,null);
  useEffect(()=>{if(vaultRoot)setRecovered(readRecoveredDraft(localStorage,newStorageKey))},[vaultRoot,newStorageKey]);
  useEffect(()=>{if(vaultRoot)setDrafts(v=>({...v,[key]:readDraft(localStorage,storageKey)}))},[vaultRoot,key,storageKey]);
  const edit=(text:string)=>{setDrafts(v=>({...v,[key]:text}));try{if(!target)setRecovered(updateRecoveryText(localStorage,storageKey,recovered,text));else if(!saveDraft(localStorage,storageKey,text))throw new Error('Draft could not be saved locally. Copy it before reloading.')}catch(e){setError(e instanceof Error?e.message:String(e))}};
  const active=tasks.filter(isOpenWork).length;
  useEffect(()=>{if(open&&target)setHidden(v=>v.filter(id=>id!==target));setError('')},[target,open]);
  const action=async(name:string,data:Record<string,unknown>={})=>{if(!current||!begin())return;try{await workRequest('/'+name,{id:current.id,...data});setReadyCheck(false)}catch(e){setError(e instanceof Error?e.message:String(e))}finally{end()}};
  const toggleKeep=async()=>{if(!current||!begin())return;try{await setWorkKeep(current.id,!current.keep)}catch(e){setError(e instanceof Error?e.message:String(e))}finally{end()}};
  // × ends an idle terminal at once and asks once more for a busy one (the second press within four seconds stops it).
  const [armed,setArmed]=useState<string|null>(null);
  const armedTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>()=>{if(armedTimer.current)clearTimeout(armedTimer.current)},[]);
  // One stop request per terminal at a time: a second × is ignored only while the first request is in flight.
  // Afterwards the terminal's own state decides (stopping: wait; closed: gone; cleanup failed: × may retry).
  const stopRequested=useRef(new Set<string>());
  // A closed tab's view is dismissed once the bridge confirms the terminal is gone, not before: until then the
  // drawer stays open on it, so "Stopping" and any cleanup failure remain visible.
  useEffect(()=>{if(target&&hidden.includes(target)){const task=tasks.find(item=>item.id===target);if(task&&!isOpenWork(task)){dismissView?.(target);setOpen(false)}}},[tasks,target,hidden]);
  const closeTab=(id:string)=>{
    // Decided on the terminal's state NOW, so an armed tab whose work finished meanwhile is simply closed.
    const action=tabCloseAction(tasks.find(task=>task.id===id));
    if(action==='wait'||stopRequested.current.has(id))return;
    // A press on an armed tab is the user's confirmation, whatever this page's snapshot says by now.
    const confirmed=armed===id;
    if(action==='confirm-stop'&&armed!==id){setArmed(id);if(armedTimer.current)clearTimeout(armedTimer.current);armedTimer.current=setTimeout(()=>setArmed(value=>value===id?null:value),4000);return}
    setArmed(null);
    if(action==='remove'){
      // The view goes; the voice conversation, its drafts and its History entry stay. Without dismissing it the
      // drawer would bring the closed tab straight back the next time it opens.
      setHidden(value=>[...new Set([...value,id])]);setOpened(value=>value.filter(item=>item!==id));
      if(target===id){dismissView?.(id);setOpen(false)}
      return;
    }
    stopRequested.current.add(id);
    void (async()=>{
      try{
        // Wait until the queue is really empty: typing that was appended while we waited is delivered too, and the
        // stop request leaves in the same tick as the last check, so nothing captured can be overtaken by it.
        for(;;){const tail=pendingInput.get(id);await (tail||Promise.resolve()).catch(()=>{});if(pendingInput.get(id)===tail)break}
        // A one-click close is conditional: the bridge ends the terminal only if it is STILL idle when the request
        // arrives (this page's "ready" is a poll old). A confirmed close of a busy terminal is unconditional.
        await workRequest('/stop',action==='stop'&&!confirmed?{id,ifIdle:true}:{id});
        setHidden(value=>[...new Set([...value,id])]);setOpened(value=>value.filter(item=>item!==id));
      }catch(e){
        if((e as {code?:string})?.code==='TERMINAL_NOT_IDLE'){setArmed(id);if(armedTimer.current)clearTimeout(armedTimer.current);armedTimer.current=setTimeout(()=>setArmed(value=>value===id?null:value),6000)}
        setError(e instanceof Error?e.message:String(e));
      }finally{stopRequested.current.delete(id)}
    })();
  };
  const selectTab=(id:string)=>{setOpened(value=>value.includes(id)?value:[...value,id]);setHidden(value=>value.filter(item=>item!==id));void select(id)};
  const copyExpiredDraft=()=>{
    if(!former||!unavailable||!begin())return;
    try{const metadata=stageExpiredTaskDraft(localStorage,storageKey,newStorageKey,prompt,former);setRecovered(metadata);setDrafts(v=>({...v,new:metadata.prompt}));void select(null)}
    catch(e){setError(e instanceof Error?e.message:String(e))}finally{end()}
  };
  const recover=async()=>{
    if(!current||!begin())return;
    try{
      const request=await workRequest('/request?id='+encodeURIComponent(current.id)) as SavedRequest;
      const metadata=stageRecoveredDraft(localStorage,newStorageKey,request);
      setRecovered(metadata);setDrafts(v=>({...v,new:metadata.prompt}));await select(null);
    }catch(e){setError(e instanceof Error?e.message:String(e))}finally{end()}
  };
  const submit=async()=>{
    if(!prompt.trim()||!begin())return;
    try{
      if(target){if(!current)throw new Error('This conversation is no longer available. Your unsent draft is still saved.');await workRequest('/send',{id:target,text:prompt})}
      else{
        const recovery=readRecoveredDraft(localStorage,newStorageKey);
        if(recovered&&!recovery)throw new Error('This recovered request changed outside the composer. Recover it again before starting a task.');
        const chosen=recovery?.selection||await getWorkSelection(),selection={provider:chosen.provider,model:chosen.model};
        if(recovery?.skill){
          const run=await workRequest('/skill',{id:crypto.randomUUID(),selection,skill:recovery.skill,args:recovery.args||{}});
          window.dispatchEvent(new CustomEvent('jarvis-workflow-queued',{detail:{id:run.id,skill:recovery.skill}}));
          void dashboardStore.refresh();setOpen(false);
        }else{
          const task=await workRequest('/start',{id:crypto.randomUUID(),selection:recovery?selection:selection.provider==='codex'?{provider:'codex',model:'gpt-6-astra'}:selection,prompt});openWork([task.id]);
        }
        if(clearRecoveredDraft(localStorage,newStorageKey))setRecovered(null);
      }
      setDrafts(v=>({...v,[key]:''}));saveDraft(localStorage,storageKey,'');
    }catch(e){setError(e instanceof Error?e.message:String(e))}finally{end()}
  };
  const alert=connectionError||error||(current?.state!=='needs input'?current?.error:'');
  return <section className={`agent-drawer ${open?'is-open':''}`} aria-label="Terminals">
    <header className="agent-drawer-bar">
      <button className="agent-drawer-toggle" aria-expanded={open} aria-controls="agent-work-content" onClick={()=>setOpen(!open)}><span aria-hidden="true">⌘</span> Terminals <small>{connectionError?'Bridge offline':`${active} open`}</small><span aria-hidden="true">{open?'⌄':'⌃'}</span></button>
      <span className="agent-shared">Shared with Obsidian</span>
      <button onClick={()=>void voice.toggle()} title={voiceTask?`Conversation: ${shortConversationTitle(voiceTask)}`:voiceTarget?'Selected conversation unavailable':'New voice conversation'}>{voiceMode==='listening'?'Send recording':voiceMode==='working'?'Cancel voice':voiceMode==='speaking'?'Interrupt & talk':'Tap to talk'}</button>
      <button onClick={()=>{void select(null);setHistoryOpen(false);setOpen(true)}}>+ New terminal</button>
    </header>
    {voiceMessage&&<p className="agent-voice-status" role="status">{voiceMessage}</p>}
    {armed&&<p className="agent-voice-status" role="status">This terminal is still busy. Press “Stop?” again to end it. Text typed in the CLI but not sent will be lost; the conversation stays in History.</p>}
    {open&&<div id="agent-work-content" className="agent-work-content">
      <TerminalTabs tabs={tabs} history={tasks} target={target} historyOpen={historyOpen} loaded={tasksLoaded} onHistory={setHistoryOpen} onSelect={selectTab} onClose={closeTab} armed={armed}/>
      {current&&<div className="agent-work-meta">
        <span title={current.execution==='script'?'Direct source refresh; no model':current.model}>{current.execution==='script'?'Source refresh':current.provider==='codex'?'Codex':'Claude Code'} · {taskStatus(current)}</span>
        <div>
          {current.execution!=='script'&&<button aria-expanded={showComposer} aria-controls="terminal-message-box" disabled={sending} onClick={()=>setMessageTarget(showComposer?null:current.id)}>Message box{prompt.trim()?' · draft':''}</button>}
          {current.turns.length>0&&<button aria-expanded={answerTarget===current.id} aria-controls="terminal-saved-answer" onClick={()=>setAnswerTarget(answerTarget===current.id?null:current.id)}>Saved answer</button>}
          <button className="agent-keep" aria-pressed={!!current.keep} disabled={sending||!!connectionError} title={current.keep?'Allow this task to clear after 7 stopped days':'Keep this task in history'} onClick={()=>void toggleKeep()}>{current.keep?'✓ Kept':'Keep'}</button>
          {!terminalLive&&current.execution!=='script'&&current.sessionId&&<button disabled={sending} onClick={()=>void action('resume')}>Resume</button>}
          {!terminalLive&&current.recoveryAvailable&&current.execution!=='script'&&<button disabled={sending||!vaultRoot} onClick={()=>void recover()}>{current.workflow?'Review retry':'Recover request'}</button>}
          {(terminalLive||scriptActive)&&<button disabled={sending||current.state==='stopping'} onClick={()=>void action('stop')}>{current.state==='stopping'?'Stopping…':'Stop'}</button>}
        </div>
      </div>}
      {alert&&<p className="agent-error" role="alert">{alert}</p>}
      {current?.state==='needs input'&&<p className="agent-input-needed" role="status">Needs your input: {current.inputReason||current.error||'Review the prompt in the terminal below.'}</p>}
      {current?<>
        {terminalLive?<LiveTerminal id={current.id} onError={setError} readOnly={current.state==='stopping'}/>:<div className="agent-stopped" role="status">
          {current.execution==='script'?(scriptActive?'Running the source refresh…':current.error||current.state==='error'?'The source refresh needs attention.':'This source refresh is closed.'):
            current.sessionId?'This terminal is closed. Resume when you want to continue.':current.recoveryAvailable?'This terminal closed before its conversation was saved. Recover the request to review it.':'This terminal is closed.'}
        </div>}
        {answerTarget===current.id&&current.turns.length>0&&<section className="agent-answer" id="terminal-saved-answer" aria-label="Saved answer"><pre>{answer||current.turns.at(-1)?.text}</pre></section>}
      </>:<div className="agent-empty" role={unavailable?'status':undefined}>
        <strong>{unavailable?'This terminal is no longer saved.':target?'Opening terminal…':`New ${provider==='codex'?'Codex':'Claude Code'} terminal`}</strong>
        <p>{unavailable?'Your unsent draft stays here. Copy it into a new request to start again; the previous conversation will not carry over.':target?'Connecting to the shared terminal.':'Describe the work below. Each independent request opens its own terminal tab.'}</p>
        {unavailable&&former&&prompt.trim()&&<button type="button" disabled={sending||!vaultRoot} onClick={copyExpiredDraft}>Use draft in new terminal</button>}
      </div>}
      {!target&&recovered&&<p className="agent-recovered" role="status">Recovered: {recovered.title} · {recovered.selection.provider} / {recovered.selection.model}. Review before starting. <button type="button" disabled={sending} onClick={()=>edit('')}>Clear recovery</button></p>}
      {showComposer&&current?.execution!=='script'&&<div id="terminal-message-box" className="agent-message-box">
        {terminalLive&&!['ready','stopping'].includes(current!.state)&&<div className="agent-message-guard">
          <p>Use the CLI directly, or wait until it is idle with an empty input box. This does not answer approval prompts.</p>
          <button disabled={sending} onClick={()=>setReadyCheck(!readyCheck)}>I want to use the message box</button>
          {readyCheck&&<button disabled={sending} onClick={()=>void action('ready',{confirmedEmpty:true})}>I checked: CLI idle and input empty</button>}
        </div>}
        <form className="agent-compose" onSubmit={e=>{e.preventDefault();void submit()}}>
          <textarea readOnly={!target&&!!recovered?.skill} disabled={sending||!vaultRoot} aria-label={target?'Terminal follow-up':'New terminal request'} value={prompt} placeholder={target?'Continue this conversation…':'Describe a request…'} maxLength={12000} onChange={e=>edit(e.target.value)}/>
          <button disabled={sending||!prompt.trim()||!!connectionError||!!target&&current?.state!=='ready'}>{target?'Send':recovered?.skill?'Retry workflow':'Start terminal'}</button>
        </form>
      </div>}
      <footer><span title={voiceTask?.title}>Voice conversation: {voiceTask?shortConversationTitle(voiceTask):voiceTarget?'Unavailable':'New conversation'}</span><span>Closing a tab ends its terminal. The conversation stays in History and voice can continue it.</span></footer>
      <details className="agent-services" onToggle={e=>{if(e.currentTarget.open)void workRequest('/services').then(setServices).catch(e=>setError(String(e)))}}><summary>Connections & draft safety</summary><p>Message-box drafts are saved on this device. Unsent text inside the CLI itself can be lost when stopped. Stopped tasks clear after 7 days; Keep saves them.</p>{services&&<><p>Terminal bridge online · {services.bridge.memoryMiB} MiB · {active} open sessions. Speech: {services.speech.health?.ok?'online':'unavailable'}{services.speech.shared?' (shared with V1)':''}. Connectors use the selected CLI’s sign-in. To stop idle V2 services, run <code>scripts/services.ps1 -Action Stop</code> from Obsidian V2. Active tasks must be stopped first.</p>{Object.entries(services.providers||{}).map(([name,value])=>{const cli=value as {installed:boolean;version?:string;command?:string;source?:string;detail?:string};return <p key={name}><strong>{name==='codex'?'Codex':'Claude Code'}</strong> · {cli.installed?cli.version||'Version unavailable':'Not installed'}{cli.source?` · ${cli.source}`:''}{cli.command&&<code>{cli.command}</code>}{cli.detail&&<span>{cli.detail}</span>}</p>})}</>}</details>
    </div>}
  </section>;
}
