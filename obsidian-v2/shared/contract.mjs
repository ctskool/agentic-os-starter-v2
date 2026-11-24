export const MARKER = '.agentic-os-v2-test-vault';
export const ROOT = 'system/v2';
// Model families, never pinned releases: Claude Code resolves these names to the newest release itself, and
// runner/codex-models.mjs picks the newest listed Codex model of a family at call time.
export const MODELS = {codex:['astra','luna'],claude:['opus','sonnet','haiku','fable']};
/** @type {Readonly<Record<string,string>>} */
export const MODEL_LABELS = Object.freeze({astra:'Astra',luna:'Luna',opus:'Opus',sonnet:'Sonnet',haiku:'Haiku',fable:'Fable'});
export const VOICE_MODELS = Object.freeze({codex:'luna',claude:'haiku'});
// Older saved selections and task records pinned a release (gpt-6-astra, claude-fable-5-1); read them as their family.
export function modelFamily(provider,model){
 if(typeof model!=='string')return model;
 if(provider==='codex'){const hit=/^gpt-\d+(?:\.\d+)*-(astra|luna)$/.exec(model);if(hit)return hit[1]}
 if(provider==='claude'&&/^claude-fable-\d/.test(model))return 'fable';
 return model;
}
/** @type {Record<string,{label:string,instruction:string,arg?:string,direct?:boolean}>} */
export const SKILLS = {
  "vault-summary": {
    "label": "Summarize Vault",
    "about": "Reads your vault and reports what is documented, what is unfinished, and what to do next.",
    "needs": [],
    "instruction": "Summarize documented facts, unfinished work and suggested next steps."
  },
  "plan-today": {
    "label": "Plan Today",
    "about": "Writes today's daily note: your top three priorities, your schedule, and what carried over from recent days.",
    "needs": ["Google Calendar connected in your coding tool"],
    "instruction": "Complete the Plan Today workflow."
  },
  "plan-tomorrow": {
    "label": "Plan Tomorrow",
    "about": "Writes tomorrow's daily note tonight from unfinished work, due projects and tomorrow's calendar. An existing note is left alone.",
    "needs": ["Google Calendar connected in your coding tool"],
    "instruction": "Complete the Plan Tomorrow workflow."
  },
  "refresh-schedule": {
    "label": "Refresh Schedule",
    "about": "Re-reads your calendar and updates the Schedule section of today's note. Nothing else in the note changes.",
    "needs": ["Google Calendar connected in your coding tool","today's daily note"],
    "instruction": "Complete the Refresh Schedule workflow."
  },
  "morning-intel": {
    "label": "Intel Brief",
    "about": "A daily AI intelligence brief from the news, Hacker News and GitHub, ending in content ideas.",
    "needs": [],
    "better": ["Gmail connected in your coding tool (adds inbox triage)","a YouTube API key (YOUTUBE_API_KEY in ~/.claude/.env) (adds YouTube and small-channel sections)"],
    "instruction": "Complete the Intel Brief workflow."
  },
  "inbox-brief": {
    "label": "Inbox Brief",
    "about": "Triages the last 24 hours of your email: what matters, what can wait, and suggested replies. It sends nothing.",
    "needs": ["Gmail connected in your coding tool"],
    "instruction": "Complete the Inbox Brief workflow."
  },
  "deep-research-chase": {
    "label": "Deep Research",
    "about": "Researches any topic you give it across the web, X and GitHub and returns a cited synthesis with sources and disagreements.",
    "needs": [],
    "better": ["a YouTube API key (YOUTUBE_API_KEY in ~/.claude/.env) (adds video sources)"],
    "instruction": "Complete the Deep Research workflow.",
    "arg": "topic"
  },
  "content-cascade": {
    "label": "Content Cascade",
    "about": "Turns one YouTube video into a blog draft, an X post and a LinkedIn post, written from its transcript. Drafts only: nothing is posted.",
    "needs": ["a YouTube video link","yt-dlp installed, to read video transcripts"],
    "instruction": "Complete the Content Cascade workflow.",
    "arg": "url"
  },
  "yt-pipeline": {
    "label": "YT Pipeline",
    "about": "Finds the strongest YouTube videos on a topic and turns their transcripts into a research report.",
    "needs": ["a YouTube API key (YOUTUBE_API_KEY in ~/.claude/.env)", "yt-dlp installed, to read video transcripts"],
    "instruction": "Complete the YT Pipeline workflow.",
    "arg": "topic"
  },
  "weekly-review": {
    "label": "Weekly Review",
    "about": "Reviews your last seven daily notes: effort, focus, what shipped, and themes worth acting on.",
    "needs": ["a few days of daily notes"],
    "better": ["a YouTube API key (YOUTUBE_API_KEY in ~/.claude/.env) and your channel (adds a channel review)"],
    "instruction": "Complete the Weekly Review workflow."
  },
  "vault-cleanup": {
    "label": "Vault Cleanup",
    "about": "Lists stale files it would archive, with a reason for each. Preview only: nothing is moved or deleted.",
    "needs": [],
    "instruction": "Complete the Vault Cleanup workflow."
  },
  "metrics-pull": {
    "label": "Pull Metrics",
    "about": "Refreshes the numbers on your dashboard cards: YouTube, Instagram, TikTok and GitHub.",
    "needs": ["your handles and a YouTube API key (YOUTUBE_API_KEY in ~/.claude/.env)"],
    "instruction": "Complete the Pull Metrics workflow.",
    "direct": true
  },
  "github-trending": {
    "label": "GitHub Trending",
    "about": "Fetches the fastest-growing GitHub repositories of the week and the month into a report.",
    "needs": ["Python 3"],
    "instruction": "Complete the GitHub Trending workflow.",
    "direct": true
  },
  "yt-week-review": {
    "label": "YouTube Review",
    "about": "Reviews your YouTube channel's last seven days of uploads against your recent videos.",
    "needs": ["your YouTube channel and a YouTube API key (YOUTUBE_API_KEY in ~/.claude/.env)"],
    "instruction": "Complete the YouTube Review workflow."
  },
  "outlier-radar": {
    "label": "Outlier Radar",
    "about": "Finds recent videos from small AI channels that far outperformed their channel's usual numbers.",
    "needs": ["a YouTube API key (YOUTUBE_API_KEY in ~/.claude/.env)"],
    "instruction": "Complete the Outlier Radar workflow."
  },
  "lead-research": {
    "label": "Lead Research",
    "about": "Researches new leads from your own leads database before a sales call.",
    "needs": ["a leads database connected in your coding tool"],
    "instruction": "Complete the Lead Research workflow."
  },
  "morning": {
    "label": "Morning Brief",
    "about": "One briefing that combines the AI morning report with your inbox triage.",
    "needs": ["Gmail connected in your coding tool"],
    "instruction": "Complete the Morning Brief workflow."
  },
  "morning-report": {
    "label": "Morning Report",
    "about": "The last 24 hours in AI and agent building: releases, news, and what they mean.",
    "needs": [],
    "better": ["a YouTube API key (YOUTUBE_API_KEY in ~/.claude/.env) (adds YouTube coverage)"],
    "instruction": "Complete the Morning Report workflow."
  },
  "ai-trend-scan": {
    "label": "AI Trend Scan",
    "about": "Scans for AI topics that are gaining speed and ranks them as ideas to cover.",
    "needs": [],
    "better": ["a YouTube API key (YOUTUBE_API_KEY in ~/.claude/.env) (adds real view counts)"],
    "instruction": "Complete the AI Trend Scan workflow."
  },
  "angle-brainstorm": {
    "label": "Brainstorm Angles",
    "about": "Gives 8 to 12 distinct video angles for a topic you name, each tied to what the audience wants.",
    "needs": [],
    "better": ["a YouTube API key (YOUTUBE_API_KEY in ~/.claude/.env) (adds evidence from real videos)"],
    "instruction": "Complete the Brainstorm Angles workflow.",
    "arg": "topic"
  },
  "outline-build": {
    "label": "Build Outline",
    "about": "Turns one chosen angle into a full video outline: hook, beats, re-hooks, payoff and call to action.",
    "needs": [],
    "instruction": "Complete the Build Outline workflow.",
    "arg": "topic"
  },
  "voice-ask": {
    "label": "Ask Astra",
    "instruction": "Complete the Ask Astra workflow.",
    "arg": "prompt"
  }
};
export const DEFAULT_SELECTION={provider:'codex',model:'astra'};
export function validateSelection(value){
 const model=value&&Object.hasOwn(MODELS,value.provider)?modelFamily(value.provider,value.model):null;
 if(!model || !MODELS[value.provider].includes(model)) throw new Error('Unsupported provider/model pair');
 return {provider:value.provider,model};
}
export function validateIntent(value){
 validateSelection(value);
 if(value.version!==2 || typeof value.id!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id)) throw new Error('Invalid V2 job ID');
 if(!Object.hasOwn(SKILLS,value.skill)) throw new Error('Unknown workflow');
 if(!Number.isFinite(Date.parse(value.ts)) || value.from!=='plugin') throw new Error('Invalid job metadata');
 if(!value.args || typeof value.args!=='object' || Array.isArray(value.args)) throw new Error('Invalid workflow arguments');
 const required=SKILLS[value.skill].arg;
 const allowed=required?[required,...(value.skill==='voice-ask'?['context']:[])]:[];
 for(const [key,text] of Object.entries(value.args))if(!allowed.includes(key)||typeof text!=='string'||!text.trim()||text.length>(key==='context'?12000:4000))throw new Error('Invalid workflow argument: '+key);
 if(required && !value.args[required]?.trim())throw new Error('This workflow needs '+required);
 if(required==='url'){let url;try{url=new URL(value.args.url)}catch{throw new Error('Enter a valid source URL')}if(!['https:','http:'].includes(url.protocol))throw new Error('Source URL must use HTTP or HTTPS');}
 return value;
}
