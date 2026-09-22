import {NATIVE_TERMINAL_VIEW} from './native-terminal';
export interface DirectLaunch {
 executable:string;args:string[];cwd:string;environment?:Array<[string,string]>;
}
export interface DirectAction {
 id:string;taskId:string;instance:string;type:'launch'|'send'|'stop';
 provider?:'codex'|'claude';title?:string;launch?:DirectLaunch;text?:string;requestKey?:string;
}
export const directId=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const absolute=(value:unknown):value is string=>typeof value==='string'&&!/[\x00-\x1f\x7f]/.test(value)&&(/^[A-Za-z]:[\\/]/.test(value)||value.startsWith('/'));
function ticketProfile(profile:Record<string,any>){return absolute(profile.executable)&&/(?:^|[\\/])node(?:\.exe)?$/i.test(profile.executable)&&Array.isArray(profile.args)&&profile.args.length===3&&absolute(profile.args[0])&&/[\\/]native-launch\.mjs$/i.test(profile.args[0])&&profile.args[1]==='--ticket'&&absolute(profile.args[2])}
export function directTerminalMetadata(leaf:{getViewState():any}):{id:string;instance:string;provider:'codex'|'claude'}|null {
 try{
  const view=leaf.getViewState(),profile=view.state?.[NATIVE_TERMINAL_VIEW]?.profile;
  if(view.type!==NATIVE_TERMINAL_VIEW||profile?.type!=='integrated'||!Array.isArray(profile.environment)||!ticketProfile(profile))return null;
  const env=Object.fromEntries(profile.environment.filter((entry:unknown)=>Array.isArray(entry)&&entry.length===2));
  return env.AOS_V2_NATIVE_DIRECT==='1'&&directId(env.AOS_V2_TASK_ID)&&directId(env.AOS_V2_NATIVE_INSTANCE)&&['codex','claude'].includes(env.AOS_V2_TASK_PROVIDER)?{id:env.AOS_V2_TASK_ID,instance:env.AOS_V2_NATIVE_INSTANCE,provider:env.AOS_V2_TASK_PROVIDER}:null;
 }catch{return null}
}
export function directTerminalViewState(action:DirectAction,base:Record<string,unknown>={}) {
 const {launch}=action;
 if(!directId(action.id)||!directId(action.taskId)||!directId(action.instance)||!['codex','claude'].includes(action.provider||'')||!launch||!absolute(launch.executable)||!absolute(launch.cwd)||!Array.isArray(launch.args)||launch.args.some(arg=>typeof arg!=='string'||/[\x00-\x1f\x7f]/.test(arg)))throw new Error('The native terminal launch is invalid.');
 // Terminal 3.27.x builds a Windows batch file. Its argv encoder does not
 // support literal newlines; a one-use launch ticket carries full prompt text.
 if(!ticketProfile(launch))throw new Error('The native launch ticket is invalid.');
 if(launch.environment&&(!Array.isArray(launch.environment)||launch.environment.some(entry=>!Array.isArray(entry)||entry.length!==2||entry.some(value=>typeof value!=='string'||/[\x00\r\n]/.test(value)))))throw new Error('The native launch environment is invalid.');
 const platform=/^[A-Za-z]:[\\/]/.test(launch.executable)?'win32':typeof process!=='undefined'?process.platform:'darwin';
 const title=`${action.provider==='codex'?'Codex':'Claude'} · ${(action.title||'Conversation').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,70)}`;
 const environment=(launch.environment||[]).filter(([key])=>!['AOS_V2_NATIVE_DIRECT','AOS_V2_TASK_ID','AOS_V2_TASK_PROVIDER','AOS_V2_NATIVE_INSTANCE'].includes(key));
 environment.push(['AOS_V2_NATIVE_DIRECT','1'],['AOS_V2_TASK_ID',action.taskId],['AOS_V2_TASK_PROVIDER',action.provider!],['AOS_V2_NATIVE_INSTANCE',action.instance]);
 return {type:NATIVE_TERMINAL_VIEW,active:false,state:{[NATIVE_TERMINAL_VIEW]:{cwd:launch.cwd,focus:false,profileSourceId:null,serial:null,userTitle:title,profile:{
  type:'integrated',name:title,executable:launch.executable,args:[...launch.args],environment,platforms:{[platform]:true},
  pythonExecutable:typeof base.pythonExecutable==='string'?base.pythonExecutable:platform==='win32'?'python':'python3',
  useWin32Conhost:true,followTheme:typeof base.followTheme==='boolean'?base.followTheme:true,
  rightClickAction:base.rightClickAction||'copyPaste',terminalOptions:base.terminalOptions&&typeof base.terminalOptions==='object'?structuredClone(base.terminalOptions):{documentOverride:null},
  restoreHistory:false,successExitCodes:['0','SIGINT','SIGTERM'],
 }}}};
}
