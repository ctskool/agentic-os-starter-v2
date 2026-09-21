import {executeCli} from './adapters.mjs';

// Voice uses the selected provider's installed CLI and existing sign-in.
// An unrelated API key must never opt the dashboard into another transport.
// One deliberate, owner-approved exception (2026-09-20): the Jev tier classifier
// in jev.mjs. It is off unless .runtime/jev.json or AOS_JEV_KEY explicitly turns
// it on, it receives only the transcript and a minimal conversation state (never
// the dashboard snapshot, notes, metrics or report contents), and it never
// generates replies, arguments or work. Answers and work stay on the CLI.
export function fastVoiceStatus(){return {claude:'cli',codex:'cli'}}
export async function executeFastVoice(root,job,prompt,options={},deps={}){
 if(options.signal?.aborted)throw new Error('Voice request cancelled');
 return (deps.cli||executeCli)(root,job,prompt,options);
}
