import {open} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';

// A Claude Code /login login has a fixed lifetime. The CLI warns about it only when it starts in a terminal, which an
// owner who works elsewhere never sees; once it runs out, every background Claude request fails until /login. This
// reads only that deadline so the usage meters can say so a day ahead. The credentials are parsed in memory to find
// the deadline; the token text is never kept, returned, logged or sent from here.
export const LOGIN_NOTICE_MS=24*60*60*1000;
const MAX_BYTES=64*1024;
const HOW='Open a terminal, run claude, then type /login.';

// Resolved on every call, as claudeUsage.mjs does, so a changed CLAUDE_CONFIG_DIR is honoured without a restart.
export const credentialsFile=(env=process.env)=>path.join(env.CLAUDE_CONFIG_DIR?path.resolve(env.CLAUDE_CONFIG_DIR):path.join(homedir(),'.claude'),'.credentials.json');

// The renewal deadline in ms, or null when there is no usable login or no deadline to report.
export async function readLoginDeadline(file){
 let handle;
 try{
  handle=await open(file,'r');
  const buffer=Buffer.alloc(MAX_BYTES+1);
  let size=0;
  for(;;){
   const {bytesRead}=await handle.read(buffer,size,buffer.length-size,size);
   if(!bytesRead)break;
   size+=bytesRead;
   if(size>MAX_BYTES)return null;
  }
  const auth=JSON.parse(buffer.toString('utf8',0,size))?.claudeAiOauth;
  if(typeof auth?.accessToken!=='string'||!auth.accessToken)return null;
  const deadline=auth.refreshTokenExpiresAt;
  return typeof deadline==='number'&&Number.isFinite(deadline)&&deadline>0?deadline:null;
 }
 catch{return null}
 finally{await handle?.close().catch(()=>{})}
}

// undefined, or {level:'soon'|'expired', text} once the login is within a day of its deadline.
export async function claudeLoginNotice({env=process.env,now=Date.now,read=readLoginDeadline,timeoutMs=1000}={}){
 let timer;
 const timedOut=new Promise(resolve=>{timer=setTimeout(()=>resolve(null),timeoutMs)});
 const deadline=await Promise.race([Promise.resolve().then(()=>read(credentialsFile(env))).catch(()=>null),timedOut]);
 clearTimeout(timer);
 if(typeof deadline!=='number')return undefined;
 const left=deadline-now();
 if(left>LOGIN_NOTICE_MS)return undefined;
 if(left<=0)return {level:'expired',text:`Claude Code login has expired. ${HOW}`};
 const hours=Math.ceil(left/3600000);
 return {level:'soon',text:`Claude Code login expires ${hours<=1?'within the hour':`in ${hours} hours`}. ${HOW}`};
}

// The Claude reading for /usage. The notice is looked up after the reading, so a /login made meanwhile counts, and
// it is added whatever the reading's status: an unavailable meter is exactly when it matters.
export async function claudeUsageReading({signal,getUsage,notice=claudeLoginNotice}={}){
 const reading=await getUsage({signal});
 const found=await notice();
 return found?{...reading,notice:found}:reading;
}
