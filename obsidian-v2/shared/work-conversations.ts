export type ConversationProvider='codex'|'claude';
export interface CurrentConversations {codex:string|null;claude:string|null}
export interface ConversationTask {id:string;provider:ConversationProvider;model:string;execution?:string}
export interface ConversationSnapshot {tasks:ConversationTask[];current?:CurrentConversations;currentRevision?:number;error?:string;[key:string]:unknown}
export interface ConversationChoice {provider:ConversationProvider;model:string}
interface Options {
 initialProvider?:ConversationProvider;
 getSnapshot:()=>ConversationSnapshot;
 readFresh:()=>Promise<ConversationSnapshot>;
 startSession?:()=>Promise<CurrentConversations&{revision:number}>;
 persist:(provider:ConversationProvider,id:string|null)=>Promise<CurrentConversations&{revision:number}>;
 publish?:(snapshot:ConversationSnapshot)=>void;
 onChange?:()=>void;
}
const providers:ConversationProvider[]=['codex','claude'];
function validProvider(value:unknown):value is ConversationProvider{return value==='codex'||value==='claude'}
function validMap(value:unknown):value is CurrentConversations{return !!value&&typeof value==='object'&&providers.every(provider=>{const id=(value as CurrentConversations)[provider];return id===null||typeof id==='string'&&id.length>0&&id.length<=160})}
const validRevision=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;

// Existing view subscriptions feed sync(); this controller starts no polling.
// A current conversation is explicit vault state, never inferred from history.
export function createWorkConversations(options:Options){
 let provider=options.initialProvider||'codex',revision=-1,initialized=false,queue=Promise.resolve();
 let sessionStarted=!options.startSession,sessionPending:Promise<void>|null=null,sessionCurrent:CurrentConversations|null=null;
 let current:CurrentConversations={codex:null,claude:null},confirmed:CurrentConversations={...current};
 const dirty={codex:0,claude:0},versions={codex:0,claude:0},errors:{codex:string|null;claude:string|null}={codex:null,claude:null};
 const pending:{codex:Promise<void>|null;claude:Promise<void>|null}={codex:null,claude:null};
 const notify=()=>options.onChange?.();
 const accept=(map:CurrentConversations,nextRevision:number)=>{
  if(nextRevision<revision)return;
  const previous=JSON.stringify(current);revision=nextRevision;initialized=true;
  for(const p of providers){confirmed[p]=map[p];if(!dirty[p])current[p]=map[p]}
  if(JSON.stringify(current)!==previous)notify();
 };
 const sync=(snapshot:ConversationSnapshot)=>{if(!sessionStarted||!validMap(snapshot.current)||!validRevision(snapshot.currentRevision)||snapshot.currentRevision<revision)return false;accept(snapshot.current,snapshot.currentRevision);return true};
 const publish=()=>options.publish?.({...options.getSnapshot(),current:{...confirmed},currentRevision:revision});
 // The frontend owns one session for its entire runtime, including all views
 // and provider swaps. A failed handshake is retried using that same session.
 const startSession=():Promise<void>=>{
  if(sessionStarted)return Promise.resolve();
  if(sessionPending)return sessionPending;
  const attempt=Promise.resolve().then(async()=>{
   const result=await options.startSession!();
   if(!validMap(result)||!validRevision(result.revision))throw new Error('Conversation state is unavailable. Refresh the dashboard and try again.');
   sessionCurrent={codex:result.codex,claude:result.claude};sessionStarted=true;accept(result,result.revision);
  });
  sessionPending=attempt;
  void attempt.finally(()=>{if(sessionPending===attempt)sessionPending=null}).catch(()=>{});
  return attempt;
 };
 const choose=(id:string|null,p:ConversationProvider=provider):Promise<void>=>{
  if(!validProvider(p)||!(id===null||typeof id==='string'&&id.length>0&&id.length<=160))return Promise.reject(new Error('Invalid conversation selection.'));
  sync(options.getSnapshot());
  const task=options.getSnapshot().tasks.find(task=>task.id===id);
  if(task&&(task.provider!==p||['script','headless'].includes(task.execution||'')))return Promise.reject(new Error('Choose a CLI conversation for the selected provider.'));
  const version=++versions[p];dirty[p]++;current[p]=id;errors[p]=null;notify();
  // Serialize writes, including different providers: each response is one shared map.
  const write=queue.then(async()=>{
   try{
    await startSession();
    const result=await options.persist(p,id);
    if(!validMap(result)||!validRevision(result.revision)||result[p]!==id)throw new Error('The conversation selection was not confirmed. Try again.');
    dirty[p]--;if(result.revision<revision){if(!dirty[p])current[p]=confirmed[p]}else accept(result,result.revision);if(versions[p]===version)errors[p]=null;publish();notify();
   }catch(error){
    dirty[p]=Math.max(0,dirty[p]-1);
    if(versions[p]===version){current[p]=confirmed[p];errors[p]=error instanceof Error?error.message:String(error);publish();notify()}
    throw error;
   }
  });
  pending[p]=write;queue=write.catch(()=>{});
  // UI callers still receive rejection; the retained queue never causes an unhandled rejection.
  void write.finally(()=>{if(pending[p]===write)pending[p]=null}).catch(()=>{});
  return write;
 };
 return {
  sync,choose,startSession,
  setProvider(next:ConversationProvider){if(!validProvider(next))throw new Error('Invalid provider.');if(next!==provider){provider=next;notify()}},
  provider:()=>provider,
  target:(p:ConversationProvider=provider)=>current[p],
  error:(p:ConversationProvider=provider)=>errors[p],
  current:()=>({...current}),
  async getSelection(chosen:ConversationChoice){
   if(!validProvider(chosen.provider))throw new Error('Invalid provider.');
   sync(options.getSnapshot());
   const captured={...chosen},p=chosen.provider,id=current[p],known=initialized||versions[p]>0,wait=pending[p],error=errors[p],capturedVersion=versions[p],capturedRevision=revision,startedAtCapture=sessionStarted;
   if(error)throw new Error(error);if(wait)await wait;
   await startSession();
   const fresh=await options.readFresh();if(fresh.error)throw new Error(fresh.error);
   if(!Array.isArray(fresh.tasks)||!validMap(fresh.current)||!validRevision(fresh.currentRevision))throw new Error('Conversation state is unavailable. Refresh the dashboard and try again.');
   sync(fresh);
   // Expiry can clear the target in the fresh read. Respect that clear unless
   // the user changed their selection after capture. Never replace a captured
   // target with a different remote conversation during a spoken request.
   const expired=known&&id!==null&&fresh.current[p]===null&&fresh.currentRevision>capturedRevision&&versions[p]===capturedVersion;
   const initialTarget=versions[p]===capturedVersion?fresh.current[p]:!startedAtCapture?sessionCurrent?.[p]??null:null;
   const targetId=expired?null:known?id:initialTarget,task=fresh.tasks.find(task=>task.id===targetId);
   if(task&&(task.provider!==p||['script','headless'].includes(task.execution||'')))throw new Error('The remembered conversation does not belong to this provider. Choose New conversation or another conversation.');
   // Missing/closed/busy targets remain explicit. The router must hear requests
   // such as "start a new task" before deciding whether continuation is valid.
   return {...captured,provider:p,model:task?.model||captured.model,terminalMode:true,targetId};
  },
 };
}
