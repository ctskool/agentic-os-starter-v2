export const MARKER = '.agentic-os-v2-test-vault';
export const ROOT = 'system/v2';
export const MODELS = {codex:['gpt-6-astra','gpt-5.6-luna'],claude:['opus','sonnet','haiku','claude-fable-5-1']};
export const VOICE_MODELS = Object.freeze({codex:'gpt-5.6-luna',claude:'haiku'});
/** @type {Record<string,{label:string,instruction:string,arg?:string,direct?:boolean}>} */
export const SKILLS = {
  "vault-summary": {
    "label": "Summarize Vault",
    "instruction": "Summarize documented facts, unfinished work and suggested next steps."
  },
  "plan-today": {
    "label": "Plan Today",
    "instruction": "Complete the Plan Today workflow."
  },
  "plan-tomorrow": {
    "label": "Plan Tomorrow",
    "instruction": "Complete the Plan Tomorrow workflow."
  },
  "refresh-schedule": {
    "label": "Refresh Schedule",
    "instruction": "Complete the Refresh Schedule workflow."
  },
  "morning-intel": {
    "label": "Intel Brief",
    "instruction": "Complete the Intel Brief workflow."
  },
  "inbox-brief": {
    "label": "Inbox Brief",
    "instruction": "Complete the Inbox Brief workflow."
  },
  "deep-research-chase": {
    "label": "Deep Research",
    "instruction": "Complete the Deep Research workflow.",
    "arg": "topic"
  },
  "content-cascade": {
    "label": "Content Cascade",
    "instruction": "Complete the Content Cascade workflow.",
    "arg": "url"
  },
  "yt-pipeline": {
    "label": "YT Pipeline",
    "instruction": "Complete the YT Pipeline workflow.",
    "arg": "topic"
  },
  "weekly-review": {
    "label": "Weekly Review",
    "instruction": "Complete the Weekly Review workflow."
  },
  "vault-cleanup": {
    "label": "Vault Cleanup",
    "instruction": "Complete the Vault Cleanup workflow."
  },
  "metrics-pull": {
    "label": "Pull Metrics",
    "instruction": "Complete the Pull Metrics workflow.",
    "direct": true
  },
  "github-trending": {
    "label": "GitHub Trending",
    "instruction": "Complete the GitHub Trending workflow.",
    "direct": true
  },
  "yt-week-review": {
    "label": "YouTube Review",
    "instruction": "Complete the YouTube Review workflow."
  },
  "outlier-radar": {
    "label": "Outlier Radar",
    "instruction": "Complete the Outlier Radar workflow."
  },
  "lead-research": {
    "label": "Lead Research",
    "instruction": "Complete the Lead Research workflow."
  },
  "morning": {
    "label": "Morning Brief",
    "instruction": "Complete the Morning Brief workflow."
  },
  "morning-report": {
    "label": "Morning Report",
    "instruction": "Complete the Morning Report workflow."
  },
  "ai-trend-scan": {
    "label": "AI Trend Scan",
    "instruction": "Complete the AI Trend Scan workflow."
  },
  "angle-brainstorm": {
    "label": "Brainstorm Angles",
    "instruction": "Complete the Brainstorm Angles workflow.",
    "arg": "topic"
  },
  "outline-build": {
    "label": "Build Outline",
    "instruction": "Complete the Build Outline workflow.",
    "arg": "topic"
  },
  "voice-ask": {
    "label": "Ask Astra",
    "instruction": "Complete the Ask Astra workflow.",
    "arg": "prompt"
  }
};
export const DEFAULT_SELECTION={provider:'codex',model:'gpt-6-astra'};
export function validateSelection(value){
 if(!value || !Object.hasOwn(MODELS,value.provider) || !MODELS[value.provider].includes(value.model)) throw new Error('Unsupported provider/model pair');
 return {provider:value.provider,model:value.model};
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
