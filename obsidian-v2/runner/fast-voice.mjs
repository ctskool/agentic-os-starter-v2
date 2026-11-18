import crypto from 'node:crypto';
import {executeCli,prestartCli} from './adapters.mjs';
import {VOICE_MODELS} from '../shared/contract.mjs';
import {trackOwnedWork,classifierProcesses} from './jev.mjs';
import {voiceSpeed} from './voice-speed.mjs';

// Voice uses the selected provider's installed CLI and existing sign-in.
// An unrelated API key must never opt the dashboard into another transport.
// One deliberate, owner-approved exception (2026-09-20): the Jev tier classifier
// in jev.mjs. It is off unless .runtime/jev.json or AOS_JEV_KEY explicitly turns
// it on, it receives only the transcript and a minimal conversation state (never
// the dashboard snapshot, notes, metrics or report contents), and it never
// generates replies, arguments or work. Answers and work stay on the CLI.
// A waiting Claude program is only worth using for about the first two and a half seconds: after three
// seconds without its question it takes longer to get going than a fresh one (measured: 0.15 s to ready
// when asked within two seconds, 0.41 s for a fresh program, 0.55 to 0.6 s after four seconds or more).
const EARLY_LIMIT=4,PRESTART_UNUSED_MS=20000,PRESTART_FRESH_MS=2500,streamUnsupported=new Set();
// Starts the small model's program while the member's words are still being turned into text, so its
// start-up is not waited for afterwards. Off unless the member switches it on (voice-speed.mjs). Claude only:
// about a quarter of a second saved on a fast desktop when the words are ready within two seconds, and
// no gain was measured for Codex. Returns null when it should not or cannot be
// done; nothing depends on it. Whoever gets a handle must call discard() when the request is over: a program
// that was never asked anything is simply stopped, and has cost nothing with the provider.
export function prepareFastVoice(root,selection,deps={}){
 try{
  const speed=(deps.speed||voiceSpeed)();
  if(selection?.provider!=='claude'||!speed.prestart||!speed.earlyAnswer||(deps.unsupported||streamUnsupported).has('claude'))return null;
  if((deps.processes||classifierProcesses)().total>=EARLY_LIMIT)return null;
  const model=VOICE_MODELS.claude;
  const handle=(deps.prestart||prestartCli)(root,{id:crypto.randomUUID(),provider:'claude',model});
  // Counted as this bridge's own from its start until it has really closed, whoever is using it by then;
  // shutdown can ask it to stop at any point.
  (deps.track||trackOwnedWork)(handle.closed,{abort:()=>handle.stop()});
  let used=false;
  // Measured on a clock that never jumps (a wall clock can, and the limit is only two and a half seconds).
  const now=deps.now||(()=>performance.now()),began=now();
  const timer=setTimeout(()=>handle.discard(),PRESTART_UNUSED_MS);timer.unref?.();
  return {
   // The first classifier call of the request that is the same program takes it; anything else starts its own.
   // One that has waited too long is stopped and a fresh program is started instead, exactly as without this.
   take(job){
    if(used||handle.taken||handle.gone||job.provider!=='claude'||job.model!==model||(job.skill&&!job.restricted))return null;
    used=true;clearTimeout(timer);
    if(now()-began>PRESTART_FRESH_MS){handle.discard();return null}
    return handle;
   },
   discard(){clearTimeout(timer);handle.discard()}
  };
 }catch{return null}
}
export function fastVoiceStatus(){return {claude:'cli',codex:'cli'}}
export async function executeFastVoice(root,job,prompt,options={},deps={}){
 if(options.signal?.aborted)throw new Error('Voice request cancelled');
 const run=deps.cli||executeCli;
 // Take the answer the moment the turn has ended (voice-speed.mjs). The program that produced it is stopped
 // and stays counted as this bridge's own until the system confirms it has closed. Not while several
 // stopped programs are still closing, and not with a CLI that has already refused the streaming output.
 const crowded=(deps.processes||classifierProcesses)().total>=EARLY_LIMIT;
 if(!(deps.speed||voiceSpeed)().earlyAnswer||crowded||(deps.unsupported||streamUnsupported).has(job.provider))return run(root,job,prompt,options);
 const early={...options,early:true,onDetached:(closed,controller)=>(deps.track||trackOwnedWork)(closed,controller)};
 const prestarted=deps.prepared?.take(job)||null;
 if(prestarted){
  // The program started ahead of time is used. If there is positive evidence that the request never reached
  // it (it had died and its input could not be written, or it refused its arguments), the request is asked
  // once more with a fresh program, exactly as if nothing had been started early. Any other failure, silence
  // included, is reported and never retried: the request may have been taken.
  try{return await run(root,job,prompt,{...early,prestarted})}
  catch(error){if(options.signal?.aborted||!error?.notSubmitted)throw error;if(error.streamUnsupported)(deps.unsupported||streamUnsupported).add(job.provider)}
  if((deps.unsupported||streamUnsupported).has(job.provider))return run(root,job,prompt,options);
 }
 try{return await run(root,job,prompt,early)}
 catch(error){
  // An older CLI refused the streaming arguments before any model ran: ask once more the old way, and
  // do not try streaming again for as long as this bridge runs.
  if(!error?.streamUnsupported||options.signal?.aborted)throw error;
  (deps.unsupported||streamUnsupported).add(job.provider);
  return run(root,job,prompt,options);
 }
}
