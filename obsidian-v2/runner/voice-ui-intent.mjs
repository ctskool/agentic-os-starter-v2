// A closed-vocabulary parser for workspace commands, consulted only after Jev
// has said the whole utterance is a UI action. Jev's label never acts: the
// parser must account for every spoken word, the result still passes the same
// validators as model output, and the validated action must equal what was
// parsed here. Anything else returns a refusal and the model decides as before.
const PREAMBLE=/^(?:(?:hey|hi|hello|ok|okay|all right|alright|so|well|um|uh|jarvis|astra|please|just|now)[,\s]+)+/;
const REQUEST=/^(?:(?:can|could|would|will) you(?: please| just)?|would you mind|go ahead and|please|just|quickly|real quick)[,\s]+/;
const TRAILING=/(?:[,\s]+(?:for me|please|thanks|thank you|jarvis|astra|real quick|really quick|quickly|right now|now))+$/;
// Negation, conditions, questions and second clauses never describe one plain
// command. The row patterns below are anchored to the whole utterance, so this
// list is a second line of defence, not the only one.
const REFUSED=/\b(?:don't|do not|never|not|no|without|unless|instead|only|after|once|until|before|when|if|later|tomorrow|tonight|how|why|what|where|which|who|whose|whether|explain|tell|describe|and|or|then|but|also)\b|[;:"\n]|https?:\/\//;
const DET='(?:(?:my|the|a|our|up)\\s+)*';
const SHOW='(?:open(?: up)?|show(?: me| us)?|display|bring up|pull up|put up|go to|switch to)';
// Spoken placement: a side, or a split. No "tab" or "window": the validator
// drops those, and a default placement would then replace what was asked.
const PLACE='(?:\\s+(?:(?:on|to|in|over on|over to)\\s+(?:the\\s+|my\\s+)?(right|left)(?:\\s+hand)?(?:\\s+(?:side ?bar|side|panel|pane))?|(?:in|as)\\s+a\\s+split(?:\\s+(?:view|pane|screen))?|in\\s+split\\s+(?:view|screen)|side\\s+by\\s+side))?';
const placed=(surface)=>[new RegExp(`^${SHOW}\\s+${DET}(?:${surface})(${PLACE})$`),new RegExp(`^(?:pull|bring|put)\\s+${DET}(?:${surface})\\s+up(${PLACE})$`)];
// Surfaces whose words could also name what the selected conversation made
// ("display the graph view" after a graph-view mockup) abstain while a
// conversation is selected; no resolver is added to tell them apart.
const ROWS=[
 {surface:'gmail',patterns:placed('gmail|google mail'),action:{op:'web',target:'gmail'},placement:true},
 {surface:'youtube-studio',patterns:placed('(?:you ?tube|yt) studio'),action:{op:'web',target:'youtube-studio'},placement:true},
 {surface:'calendar',patterns:placed('(?:google\\s+)?calendar'),action:{op:'web',target:'calendar'},placement:true,contentLike:true,defaultWhere:'right-sidebar'},
 {surface:'daily-note',patterns:placed("(?:today'?s\\s+)?daily(?:\\s+note)?"),action:{op:'daily-note'},placement:true,contentLike:true},
 // Only an explicit toggle: "hide" or "collapse" would do the opposite when
 // the sidebar is already in that state.
 {surface:'left-sidebar',patterns:[new RegExp(`^toggle\\s+${DET}left\\s+side ?bar$`)],action:{op:'command',id:'app:toggle-left-sidebar'}},
 {surface:'right-sidebar',patterns:[new RegExp(`^toggle\\s+${DET}right\\s+side ?bar$`)],action:{op:'command',id:'app:toggle-right-sidebar'}},
 {surface:'graph',patterns:[new RegExp(`^${SHOW}\\s+${DET}(?:graph view|(?:vault|obsidian) graph(?: view)?)$`)],action:{op:'command',id:'graph:open'},contentLike:true},
 {surface:'terminal',patterns:[new RegExp(`^(?:open(?: up)?|show(?: me)?|bring up|pull up|launch|start(?: up)?)\\s+${DET}terminal$`)],action:{op:'command',id:'terminal:open-terminal.default.root'},contentLike:true},
 {surface:'tab',patterns:[/^close\s+(?:this|the|my|current|the current)\s+tab$/],action:{op:'command',id:'workspace:close'}},
 {surface:'back',patterns:[/^go back$/],action:{op:'command',id:'app:go-back'}},
 {surface:'forward',patterns:[/^go forward$/],action:{op:'command',id:'app:go-forward'}},
 {surface:'split-right',patterns:[/^split\s+(?:the\s+)?(?:(?:screen|pane|window)\s+)?(?:right|vertically)$/],action:{op:'command',id:'workspace:split-vertical'}},
 {surface:'split-down',patterns:[/^split\s+(?:the\s+)?(?:(?:screen|pane|window)\s+)?(?:down|horizontally)$/],action:{op:'command',id:'workspace:split-horizontal'}},
];
function whereOf(text){
 if(!text)return undefined;
 if(/\bright\b/.test(text))return 'right-sidebar';
 if(/\bleft\b/.test(text))return 'left-sidebar';
 return 'split';
}
/** Returns {candidate, expect, surface} or {refused}. `candidate` has the
 * model's output shape; `expect` is the action in the validator's OUTPUT shape,
 * built from the same allowlist tables the validator uses. */
export function parseUiIntent(transcript,{conversationSelected=false,tables={}}={}){
 if(typeof transcript!=='string')return {refused:'no-transcript'};
 const whole=transcript.normalize('NFKC').replace(/[’‘]/g,"'").replace(/[“”]/g,'"').toLowerCase().replace(/\s+/g,' ').trim();
 if(!whole||whole.length>160)return {refused:'length'};
 if(whole.split(/[.!?]+/).map(part=>part.trim()).filter(Boolean).length>1)return {refused:'multi-sentence'};
 let text=whole.replace(/[.!?]+$/,'').replace(/,/g,' ').replace(/\s+/g,' ').trim();
 for(let i=0;i<4;i++){const next=text.replace(PREAMBLE,'').replace(REQUEST,'').replace(TRAILING,'').trim();if(next===text)break;text=next}
 if(REFUSED.test(text))return {refused:'refused-word'};
 for(const row of ROWS){
  for(const pattern of row.patterns){
   const match=pattern.exec(text);
   if(!match)continue;
   if(row.contentLike&&conversationSelected)return {refused:'conversation-selected',surface:row.surface};
   const spoken=row.placement?whereOf(placementText(match)):undefined;
   const obsidian={...row.action,...(spoken?{where:spoken}:{})};
   let expect;
   if(row.action.op==='web'){const target=tables.WEB_TARGETS?.[row.action.target];if(!target)return {refused:'unknown-target'};expect={op:'web',...target,where:spoken||row.defaultWhere}}
   else if(row.action.op==='command'){const label=tables.COMMAND_ALLOW?.[row.action.id];if(!label)return {refused:'unknown-command'};expect={op:'command',id:row.action.id,label}}
   else expect={op:'daily-note',where:spoken};
   return {surface:row.surface,candidate:{tier:2,reply:'',obsidian},expect:JSON.parse(JSON.stringify(expect))};
  }
 }
 return {refused:'no-row'};
}
// The placement group is the first capture of a placed() pattern; it is empty
// when no placement was spoken.
function placementText(match){return typeof match[1]==='string'?match[1].trim():''}
/** True when a validated action is exactly what the parser expected: the
 * validator may reject, but it may never change or drop what was asked. */
export function sameUiAction(validated,expect){
 if(!validated||!expect)return false;
 const plain=value=>JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(value))).sort(([a],[b])=>a.localeCompare(b))));
 return plain(validated)===plain(expect);
}
