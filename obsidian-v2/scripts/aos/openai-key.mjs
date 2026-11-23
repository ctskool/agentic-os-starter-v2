import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {openUrl} from './platform.mjs';
import {CONSENT_VERSION,LIVE_KEY_SHAPE,liveKeyFile} from '../../runner/live/key.mjs';
import {writePrivate} from '../../runner/live/private-store.mjs';

const page=content=>`<!doctype html><meta charset="utf-8"><title>Agentic OS — Live voice</title><main>${content}</main>`;
const form=note=>page(`<h1>Set up Live voice</h1><p>Live voice sends your microphone audio, a vault snapshot (your About me, today's plan and Daily Drivers, task titles and status, inbox counts, metrics, news and radar), delegated answers, and report excerpts to OpenAI. You can turn off Share task titles in the Live settings. Share morning brief is off unless you turn it on; it also sends your whole morning brief, including its email section. The bridge requests store: false. OpenAI bills your API account for the call.</p><p>Your API key is saved on this computer. Saving it here records your consent for these data flows.</p>
<form method="post" autocomplete="off"><label>OpenAI API key <input name="key" type="password" required></label><p><label><input name="consent" value="yes" type="checkbox" required> I consent to sending this data to OpenAI during Live calls.</label></p><button>Save key and consent</button></form>${note?'<p>'+note+'</p>':''}`);

export function collectOpenAIKey({runtimeDir,timeoutMs=300000,open=openUrl,announce=()=>{}}){
 const token=randomBytes(24).toString('hex'),wanted=Buffer.from('/'+token);
 return new Promise((resolve,reject)=>{
  let timer,finished=false,saved=false;
  const finish=result=>{if(finished)return;finished=true;clearTimeout(timer);server.close();server.closeAllConnections?.();resolve(result)};
  const server=http.createServer((req,res)=>{
   const host='127.0.0.1:'+server.address().port,origin='http://'+host,supplied=Buffer.from(String(req.url||''));
   const reply=(status,html)=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'"});res.end(html)};
   if(req.headers.host!==host||supplied.length!==wanted.length||!timingSafeEqual(supplied,wanted))return reply(404,page('<h1>Not found</h1>'));
   if(req.method==='GET'&&!saved)return reply(200,form());
   if(req.method!=='POST'||req.headers.origin!==origin||!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type']||''))return reply(403,page('<h1>Refused</h1>'));
   let size=0;const chunks=[];
   req.on('data',chunk=>{size+=chunk.length;if(size>4096)req.destroy();else chunks.push(chunk)});
   req.on('end',()=>{
    if(finished||saved)return reply(409,page('<h1>This page has already been used</h1>'));
    const data=new URLSearchParams(Buffer.concat(chunks).toString('utf8')),key=(data.get('key')||'').trim();
    if(data.get('consent')!=='yes'||!LIVE_KEY_SHAPE.test(key))return reply(400,form('Enter a valid OpenAI API key and select the consent checkbox.'));
    try{writePrivate(liveKeyFile(runtimeDir),JSON.stringify({key,consentAt:new Date().toISOString(),consentVersion:CONSENT_VERSION}))}
    catch{return reply(500,form('The key could not be saved. Check the installation folder and try again.'))}
    saved=true;res.once('finish',()=>finish({saved:true}));reply(200,page('<h1>Saved</h1><p>You can close this tab.</p>'));
   });
  });
  server.once('error',reject);
  server.listen({host:'127.0.0.1',port:0,exclusive:true},()=>{
   const url='http://127.0.0.1:'+server.address().port+'/'+token;
   timer=setTimeout(()=>finish({saved,reason:'timeout'}),timeoutMs);
   announce(url);try{open(url)}catch{}
  });
 });
}
