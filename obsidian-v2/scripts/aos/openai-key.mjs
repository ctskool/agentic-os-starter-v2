import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {openUrl} from './platform.mjs';
import {CONSENT_VERSION,LIVE_KEY_SHAPE,liveKeyFile} from '../../runner/live/key.mjs';
import {writePrivate} from '../../runner/live/private-store.mjs';
import {checkLiveKey,LIVE_MODEL} from '../../runner/live/transport.mjs';

const KEYS_URL='https://platform.openai.com/api-keys';
const link=(url,text)=>`<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
const page=content=>`<!doctype html><meta charset="utf-8"><title>Agentic OS — Live voice</title><main>${content}</main>`;
const form=note=>page(`<h1>Set up Live voice</h1><p>Live voice sends your microphone audio, a vault snapshot (your About me, today's plan and Daily Drivers, today's and tomorrow's calendar events, task titles and status, inbox counts, metrics, news and radar, and any notes you add with live-context), delegated answers, and report excerpts to OpenAI. You can turn off Share task titles in the Live settings. Share morning brief is off unless you turn it on; it also sends your whole morning brief, including its email section. The bridge requests store: false. OpenAI bills your API account for the call.</p><p>Your API key is saved on this computer. Saving it here records your consent for these data flows.</p>
<h2>Need a key?</h2><ol><li>Sign in at ${link('https://platform.openai.com','platform.openai.com')}. This is OpenAI's API account, separate from ChatGPT.</li><li>Add credit under Billing. On ChatGPT Pro or Business, claim the monthly API credits your plan includes there instead. Calls stop working when the credit runs out.</li><li>Create a key on the ${link(KEYS_URL,'API keys page')}, copy it whole, and paste it below.</li></ol>
<form method="post" autocomplete="off"><label>OpenAI API key <input name="key" type="password" required></label><p><label><input name="consent" value="yes" type="checkbox" required> I consent to sending this data to OpenAI during Live calls.</label></p><button>Save key and consent</button></form>${note?'<p role="alert"><strong>'+note+'</strong></p>':''}`);
const NEXT='<p>Next: open the <strong>···</strong> menu on the HUD Voice card or beside the Obsidian orb, choose <strong>Live</strong>, start a call and allow the microphone. Your first call also needs credit on the OpenAI API account.</p><p>You can close this tab.</p>';
const DONE={
 accepted:'<h1>Saved</h1><p>OpenAI accepted the key.</p>'+NEXT,
 'no-model':`<h1>Saved, with a warning</h1><p>OpenAI accepted the key but did not show it the Live model (${LIVE_MODEL}), so a call may be refused. Check the key's project and permissions on the ${link(KEYS_URL,'API keys page')}, then start a call to find out.</p>`+NEXT,
 unconfirmed:'<h1>Saved</h1><p>The key could not be checked with OpenAI just now, so your first call is the test. If the call is refused, the message on screen says why.</p>'+NEXT,
};
// What is wrong with what was typed, before anything is sent anywhere.
function typed(key,consent){
 if(/^sk-or-/.test(key))return 'That is an OpenRouter key, which is for Jev. Live voice needs an OpenAI API key from platform.openai.com/api-keys.';
 if(!LIVE_KEY_SHAPE.test(key))return 'That does not look like an OpenAI API key. It starts with sk- and has to be copied whole from platform.openai.com/api-keys.';
 if(consent!=='yes')return 'Select the consent checkbox to continue.';
 return '';
}

// check exists for the tests; members never pass it. It asks OpenAI whether the key works before it is saved.
export function collectOpenAIKey({runtimeDir,timeoutMs=300000,open=openUrl,announce=()=>{},check=checkLiveKey}){
 const token=randomBytes(24).toString('hex'),wanted=Buffer.from('/'+token);
 return new Promise((resolve,reject)=>{
  let timer,finished=false,saved=false,checking=false;
  const finish=result=>{if(finished)return;finished=true;clearTimeout(timer);server.close();server.closeAllConnections?.();resolve(result)};
  const server=http.createServer((req,res)=>{
   const host='127.0.0.1:'+server.address().port,origin='http://'+host,supplied=Buffer.from(String(req.url||''));
   const reply=(status,html)=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'"});res.end(html)};
   if(req.headers.host!==host||supplied.length!==wanted.length||!timingSafeEqual(supplied,wanted))return reply(404,page('<h1>Not found</h1>'));
   if(req.method==='GET'&&!saved)return reply(200,form());
   if(req.method!=='POST'||req.headers.origin!==origin||!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type']||''))return reply(403,page('<h1>Refused</h1>'));
   let size=0;const chunks=[];
   req.on('data',chunk=>{size+=chunk.length;if(size>4096)req.destroy();else chunks.push(chunk)});
   req.on('end',async()=>{
    if(finished||saved)return reply(409,page('<h1>This page has already been used</h1>'));
    if(checking)return reply(409,form('The key is still being checked. Wait a moment.'));
    const data=new URLSearchParams(Buffer.concat(chunks).toString('utf8')),key=(data.get('key')||'').trim();
    const problem=typed(key,data.get('consent'));
    if(problem)return reply(400,form(problem));
    // A key OpenAI refuses is never saved: the page stays open for another try.
    let kind='unconfirmed';
    checking=true;
    try{const result=await check(key);if(['accepted','refused','no-model'].includes(result?.kind))kind=result.kind}catch{}
    finally{checking=false}
    if(finished)return reply(409,page('<h1>This page timed out</h1><p>Run the command again.</p>'));
    if(kind==='refused')return reply(400,form('OpenAI did not accept that key. Copy it again from platform.openai.com/api-keys, or create a new one there, and try once more.'));
    try{writePrivate(liveKeyFile(runtimeDir),JSON.stringify({key,consentAt:new Date().toISOString(),consentVersion:CONSENT_VERSION}))}
    catch{return reply(500,form('The key could not be saved. Check the installation folder and try again.'))}
    saved=true;res.once('finish',()=>finish({saved:true,check:kind}));reply(200,page(DONE[kind]));
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

// The line the command prints after the page closes, for the member and for the agent helping them.
export function openAIKeyOutcome(result){
 if(!result?.saved)return 'No key was saved: the page was not completed within five minutes. Run the command again when you are ready.';
 if(result.check==='accepted')return 'Saved. OpenAI accepted the key. Choose Live in the voice menu and start a call.';
 if(result.check==='no-model')return `Saved, but OpenAI did not show this key the Live model (${LIVE_MODEL}). A call may be refused until the key's project is allowed to use it.`;
 return 'Saved. OpenAI could not be reached to check the key, so the first call is the test.';
}
