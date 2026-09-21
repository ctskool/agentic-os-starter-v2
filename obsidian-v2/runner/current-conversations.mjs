import fs from 'node:fs';
import {ROOT} from '../shared/contract.mjs';
import {vaultPath,writeJson} from './core.mjs';

const relative=`${ROOT}/current-conversations.json`;
const providers=['codex','claude'];
const scopes=['web','native'];
const validId=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
export const CONVERSATION_IDLE_MS=30*60*1000;
const activeStates=new Set(['starting','working','needs input','stopping','editing']);
const validTime=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const emptyState=()=>({current:{codex:null,claude:null},revision:0,contextEpochs:{codex:0,claude:0}});
function checkedScope(scope){if(!scopes.includes(scope))throw new Error('Choose a valid conversation app.');return scope}
function checkedNow(now){if(!validTime(now))throw new Error('Invalid conversation activity time.');return now}
export function taskInScope(task,scope='web'){checkedScope(scope);if(task?.execution==='headless'||task?.background)return task.appScope===scope;return !!task&&(task.execution==='script'||(task.execution==='native')===(scope==='native'))}
function checkedState(saved){
 if(!Number.isSafeInteger(saved?.revision)||saved.revision<0||!saved.current||providers.some(provider=>saved.current[provider]!==null&&!validId(saved.current[provider])))throw new Error('Saved voice conversation settings are invalid.');
 const contextEpochs=saved.contextEpochs??{codex:0,claude:0};
 if(providers.some(provider=>!Number.isSafeInteger(contextEpochs[provider])||contextEpochs[provider]<0))throw new Error('Saved voice conversation settings are invalid.');
 const state={current:{codex:saved.current.codex,claude:saved.current.claude},revision:saved.revision,contextEpochs:{codex:contextEpochs.codex,claude:contextEpochs.claude}};
 if(saved.selectionActivity!==undefined){
  if(!saved.selectionActivity||providers.some(p=>saved.selectionActivity[p]!==null&&!validTime(saved.selectionActivity[p])))throw new Error('Saved voice conversation activity is invalid.');
  state.selectionActivity={codex:saved.selectionActivity.codex,claude:saved.selectionActivity.claude};
 }
 if(saved.sessionIds!==undefined){
  if(!Array.isArray(saved.sessionIds)||saved.sessionIds.length>16||saved.sessionIds.some(id=>!validId(id))||new Set(saved.sessionIds).size!==saved.sessionIds.length)throw new Error('Saved voice conversation sessions are invalid.');
  state.sessionIds=[...saved.sessionIds];
 }
 if(saved.contextResets!==undefined){
  if(!saved.contextResets||providers.some(p=>{const r=saved.contextResets[p];return r!==null&&(!r||!['expired','session','unavailable'].includes(r.reason)||!validTime(r.at)||(r.previousId!==null&&!validId(r.previousId)))}))throw new Error('Saved voice conversation reset is invalid.');
  state.contextResets=Object.fromEntries(providers.map(p=>[p,saved.contextResets[p]===null?null:{...saved.contextResets[p]}]));
 }
 return state;
}
// Reading never resumes a process. Reconciliation only clears the automatic
// destination; saved tasks and their processes remain owned by the task manager.
function readSettings(root){
 let saved;
 try{saved=JSON.parse(fs.readFileSync(vaultPath(root,relative),'utf8'))}
 catch(error){if(error.code==='ENOENT')return {web:emptyState(),native:emptyState()};throw new Error('Saved voice conversations could not be read. Restore current-conversations.json before continuing.')}
 // Legacy IDs belong to bridge-owned web terminals. A native session must be
 // explicitly created/selected; reading or upgrading never adopts those IDs.
 if(saved?.version===1)return {web:checkedState(saved),native:emptyState()};
 if(saved?.version!==2||!saved.scopes)throw new Error('Saved voice conversation settings are invalid.');
 return Object.fromEntries(scopes.map(scope=>[scope,checkedState(saved.scopes[scope])]));
}
export function readCurrentState(root,scope='web'){const {current,revision}=readSettings(root)[checkedScope(scope)];return {codex:current.codex,claude:current.claude,revision}}
export function readConversationEpoch(root,provider,scope='web'){return readSettings(root)[checkedScope(scope)].contextEpochs[provider]}
export function readConversationReset(root,provider,scope='web'){return readSettings(root)[checkedScope(scope)].contextResets?.[provider]??null}
export function readCurrent(root,scope='web'){const {codex,claude}=readCurrentState(root,scope);return {codex,claude}}
function taskActivityAt(task){
 // Presence, polling, file mtimes and terminal output are not user interaction.
 // A dedicated timestamp also survives retention bookkeeping on bridge restart.
 if(validTime(task?.conversationActivityAt))return task.conversationActivityAt;
 return Math.max(-Infinity,...[task?.lastActivityAt,task?.created,...(task?.turns||[]).map(turn=>turn.ts)].filter(validTime));
}
function eligibleTask(terminals,id,provider,scope){
 let task;try{task=terminals.records instanceof Map?terminals.records.get(id):terminals.get(id)}catch{return null}
 return task?.provider===provider&&!['script','headless'].includes(task.execution)&&!task.background&&taskInScope(task,scope)?task:null;
}
function staleTask(task,now,selectionActivity=-Infinity){return !activeStates.has(task.state)&&now-Math.max(taskActivityAt(task),selectionActivity??-Infinity)>=CONVERSATION_IDLE_MS}
function saveState(root,settings,scope,state){
 if(!Number.isSafeInteger(state.revision)||providers.some(p=>!Number.isSafeInteger(state.contextEpochs[p])))throw new Error('Voice conversation revision is out of range.');
 writeJson(root,relative,{version:2,scopes:{...settings,[scope]:state}});
}
export function reconcileCurrent(root,terminals,{scope='web',now=Date.now(),sessionId,sessionMode='fresh'}={}){
 checkedScope(scope);checkedNow(now);
 if(sessionId!==undefined&&!validId(sessionId))throw new Error('Choose a valid app session.');
 if(!['fresh','adopt'].includes(sessionMode)||scope!=='web'&&sessionMode==='adopt')throw new Error('Choose a valid app session mode.');
 const settings=readSettings(root),state=settings[scope];
 const newSession=sessionId!==undefined&&!(state.sessionIds||[]).includes(sessionId);
 let boundaryChanged=false;
 for(const provider of providers){
  const id=state.current[provider],task=id===null?null:eligibleTask(terminals,id,provider,scope);
  let reason=null;
  if(id!==null&&!task)reason='unavailable';
  else if(!task||!activeStates.has(task.state)){
   if(newSession&&sessionMode==='fresh')reason='session';
   else if(task&&staleTask(task,now,state.selectionActivity?.[provider]))reason='expired';
  }
  if(reason){
   state.current[provider]=null;state.contextEpochs[provider]++;
   state.selectionActivity={codex:null,claude:null,...state.selectionActivity,[provider]:null};
   state.contextResets={codex:null,claude:null,...state.contextResets,[provider]:{reason,at:now,previousId:id}};
   boundaryChanged=true;
  }
 }
 if(boundaryChanged)state.revision++;
 if(newSession)state.sessionIds=[...(state.sessionIds||[]),sessionId].slice(-16);
 if(boundaryChanged||newSession)saveState(root,settings,scope,state);
 return {...state.current,revision:state.revision};
}
// A request may have captured its target before a /work refresh cleared the
// selection. Drop that obsolete attachment without adopting a different task.
// Unknown or foreign IDs still reach the existing actual-work ownership guard.
export function resolveVoiceTarget(root,terminals,{scope='web',provider,id,now=Date.now()}={}){
 checkedScope(scope);checkedNow(now);
 if(!providers.includes(provider))throw new Error('Choose a valid provider and conversation.');
 if(!validId(id))return id;
 const state=readSettings(root)[scope];
 if(state.current[provider]===id)return id;
 if(state.contextResets?.[provider]?.previousId===id)return null;
 const task=eligibleTask(terminals,id,provider,scope);
 return task&&staleTask(task,now)?null:id;
}
// Only the accepted user request path calls this. Unlike choosing a conversation,
// a late completion cannot switch the destination or cross a context boundary.
export function renewConversation(root,{provider,id,scope='web',now=Date.now()}={}){
 checkedScope(scope);checkedNow(now);
 if(!providers.includes(provider))throw new Error('Choose a valid provider and conversation.');
 if(!validId(id))return false;
 const settings=readSettings(root),state=settings[scope];
 if(state.current[provider]!==id)return false;
 const previous=state.selectionActivity?.[provider];
 if(validTime(previous)&&previous>=now)return true;
 const selectionActivity={codex:null,claude:null,...state.selectionActivity,[provider]:now};
 saveState(root,settings,scope,{...state,selectionActivity});return true;
}
export function setCurrent(root,terminals,{provider,id,resetContext=false,scope='web',now=Date.now()}={}){
 checkedScope(scope);checkedNow(now);
 if(!providers.includes(provider)||id!==null&&!validId(id))throw new Error('Choose a valid provider and conversation.');
 if(id!==null){
  const task=terminals.get(id);
  if(task.provider!==provider)throw new Error('This conversation belongs to a different provider.');
  if(task.execution==='script')throw new Error('A source refresh is not a voice conversation.');
  if(task.execution==='headless'||task.background)throw new Error('A background workflow is not a voice conversation.');
  if(!taskInScope(task,scope))throw new Error('This conversation belongs to a different app.');
 }
 const settings=readSettings(root),state=settings[scope];
 const selectionActivity={codex:null,claude:null,...state.selectionActivity,[provider]:id===null?null:now};
 const contextResets=state.contextResets?{...state.contextResets,[provider]:null}:undefined;
 if(id!==null&&!resetContext&&state.current[provider]===id){
  saveState(root,settings,scope,{...state,selectionActivity,...(contextResets?{contextResets}:{})});
  return {...state.current,revision:state.revision};
 }
 const current={...state.current,[provider]:id},revision=state.revision+1;
 // A fresh start also clears quick-answer context when no terminal exists.
 // Keep the durable receipts and saved CLI sessions; only move this provider's
 // context boundary, so a late reply cannot become the next conversation.
 const contextEpochs={...state.contextEpochs};if(id===null||resetContext)contextEpochs[provider]++;
 saveState(root,settings,scope,{...state,revision,current,contextEpochs,selectionActivity,...(contextResets?{contextResets}:{})});
 return {...current,revision};
}
