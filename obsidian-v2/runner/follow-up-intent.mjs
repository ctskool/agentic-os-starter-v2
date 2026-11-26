// On a call, Live is the orchestrator (Chase, 2026-11-26: "when I tell it to look at my calendar, then I tell it
// I wanted a one-pager on 5.6, shouldn't it start two tasks in the background and bring them back to me?").
// While the task in front of the caller is busy, a request that points back at it joins it and waits its turn;
// anything else is new work and starts beside it.
//
// Pointing back: an editing verb on "it", "that", "them" or on a part of the work ("the page", "the intro"),
// "its …", or a bare "continue" / "keep going". "Give me a one-pager on this Opus 5.6 stuff" names its own subject.
const VERB='give|add|append|include|change|update|edit|fix|revise|adjust|tweak|make|turn|put|remove|drop|cut|trim|shorten|expand|lengthen|rewrite|redo|rework|tighten|polish|finish|extend|translate|convert|format|rename|send|share|save|export|attach|move|swap|replace|simplify|split|merge|recolor|resize|brighten|darken|bold|highlight|number|sort|reorder|check|proofread|double[- ]check|clean up';
const PART='page|one[- ]pager|report|file|doc|document|draft|graphic|image|picture|diagram|chart|explainer|summary|list|note|section|deck|slides?|post|email|script|table|result|output|version|answer|research|intro|introduction|title|heading|header|opening|ending|conclusion|outro|colou?rs?|font|layout|style|tone|wording|design|copy|text|sources|links|first (?:part|section|paragraph)|last (?:part|section|paragraph)|bullet points?|paragraphs?|outline|hooks?|bullets?|thumbnail|caption|top|bottom|end|beginning|start|middle|(?:first|second|last|other|top|bottom) (?:half|part|section|paragraph|line)';
const ON_IT=new RegExp(`\\b(?:${VERB})\\s+(?:it|that|this|them|those|these)\\b`,'i');
const VERB_ANY=new RegExp(`\\b(?:${VERB})\\b`,'i');
const PART_OF=new RegExp(`\\b(?:its|it's|the same|(?:the|that|this) (?:${PART}))\\b`,'i');
const CONTINUE=/^(?:(?:and|also|oh|ok(?:ay)?|so|actually|um|uh|then|please)[,\s]+)*(?:continue|keep going|go on|carry on|try again|do that again|finish (?:it|that|up))\b/i;
// "Research what creators are posting and put it in my inbox": a request that opens by making something has its
// own subject, and its "it" is the thing it makes. Only "a summary of it" / "based on that" points back.
const NEW_WORK=/^(?:(?:and|also|oh|so|ok(?:ay)?|hey|um|uh|please|can you|could you|would you|will you|go ahead and|i want you to|i'd like you to)[,\s]+)*(?:research|find|look up|look into|search|write|create|build|draft|generate|give me|get me|make me|compile|put together|pull together|summarize|explain|design|plan|prepare|come up with)\b/i;
const FROM_IT=/\b(?:of|about|from|on|for|using|based on|out of)\s+(?:it|that|this|them|those|these)\b(?!\s+(?:week|month|year|morning|afternoon|evening|stuff|topic|story|news|rumou?r|thing))/i;

// A short edit with no subject of its own ("tighten it up", "shorten that, five bullets") can only mean the work in front.
const SHORT_EDIT=/^(?:(?:and|also|ok(?:ay)?|now|then|nice|great|cool|perfect|please|can you|could you)[,.!\s]+)*(?:shorten|tighten|expand|lengthen|simplify|trim|polish|rewrite|redo|rework|reformat|translate|proofread|punch up|clean up|make (?:it |that )?(?:shorter|longer|punchier|simpler|tighter|clearer))\b/i;

export function refersBack(text){
 const said=String(text||'').replace(/[’]/g,"'").replace(/\s+/g,' ').trim();
 if(!said)return false;
 if(CONTINUE.test(said))return true;
 if(SHORT_EDIT.test(said)&&said.split(' ').length<=12)return true;
 if(NEW_WORK.test(said))return FROM_IT.test(said);
 if(ON_IT.test(said))return true;
 return VERB_ANY.test(said)&&PART_OF.test(said);
}
