import {readAboutMe} from './about.mjs';

// Spoken once when a call the user started is connected and has audio, so they hear it is live
// before they say anything. Several variations, never the same one twice in a row.
const ANY = [
 name => `Hey${name}, what do you want to work on today?`,
 name => `Hi${name}, what are we tackling?`,
 name => `Hey${name}, what's on your mind?`,
 name => `Hey${name}, I'm here. What do you need?`,
 name => `Hi${name}, ready when you are. What's up?`
];
const MORNING = [name => `Morning${name}. What's first today?`, name => `Good morning${name}. What do you want to get done?`];
const AFTERNOON = [name => `Good afternoon${name}. What can I help with?`];
const EVENING = [name => `Evening${name}. What are we working on?`, name => `Hey${name}, still at it? What do you need?`];

// The name the user gave in About me ("I'm Chase.", "My name is Chase", "Name: Chase").
export function userName(text) {
 const hit = /(?:^|[\s.!])(?:I['’]m|I am|my name is|name:)\s+([\p{Lu}][\p{L}'’-]{0,30})/iu.exec(String(text ?? ''));
 return hit && !/^(?:a|an|the|not|here|in|on|at|from|working|building|running)$/i.test(hit[1]) ? hit[1] : null;
}

export function greetingOptions(now = new Date()) {
 const hour = now.getHours();
 return [...ANY, ...(hour >= 5 && hour < 12 ? MORNING : hour >= 12 && hour < 17 ? AFTERNOON : hour >= 17 || hour < 2 ? EVENING : [])];
}

let last = null;
export function pickGreeting({name = null, now = new Date(), random = Math.random, previous = last} = {}) {
 const options = greetingOptions(now), suffix = name ? `, ${name}` : '';
 const lines = options.map(make => make(suffix));
 const fresh = lines.filter(line => line !== previous);
 const line = fresh[Math.min(fresh.length - 1, Math.floor(random() * fresh.length))];
 last = line;
 return line;
}

// What the bridge sends into the call. GPT-Live never speaks first on its own, and a bare line
// pushed in with no delegation made it invent a user question and answer it ("So, how does
// photosynthesis work?…", the Riemann monologues, 2026-11-22). Worded as a cue, it says the line
// and then waits: 3 of 3 silent test calls, against 2 of 2 invented turns for the bare line.
export function greetingCue(line) {
 return `The call just connected and the user has not spoken yet. Greet them by saying exactly "${line}" Then stop talking and wait for them. Do not ask or answer anything else.`;
}

export function liveGreeting(root, options = {}) {
 let name = null;
 try {name = userName(readAboutMe(root)?.text)} catch {}
 return pickGreeting({...options, name});
}
