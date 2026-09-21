// Destination commands only. This does not classify work or bypass the voice
// router: the meaningful payload still goes through the existing three tiers.
const courtesy=/^(?:(?:hey(?: jarvis)?|jarvis|please|okay|ok|so)[,\s]+)*(?:(?:(?:can|could|would) you(?: please)?|are you able to|i(?: would|'d) like you to|i want you to)\s+)?/i;
const prefix=/^(?:(?:start|open|create|begin)(?: me)?\s+(?:(?:(?:a|one)\s+)?(?:new|separate)\s+(?:task|conversation|terminal)|another\s+(?:task|conversation|terminal)|(?:(?:two|three|four|\d+|multiple|several)\s+)?(?:new|separate)\s+(?:tasks|conversations|terminals))|(?:new|separate)\s+(?:task|conversation|terminal))\b/i;
const work=/^(?:research|investigate|build|draft|write|create|make|generate|analy[sz]e|compare|run|refresh|review|edit|put together|look into)\b/i;
const correction=/(?:[,;.!?]\s*|\s+(?:but|and)\s+)(?:actually\s+)?(?:never mind\b|not yet\b|no(?:[,!.\s]|$)|(?:do not|don't)\s+(?:start|open|create|begin)\b|keep (?:this|the current|the existing) (?:task|conversation|terminal)\b)/i;

export function newTaskIntent(value){
 if(typeof value!=='string')return null;
 const original=value.trim(),text=original.replace(courtesy,'');
 if(!text||correction.test(text))return null;
 const command=prefix.exec(text);
 if(command){
  let tail=text.slice(command[0].length).trim();
  const multiple=/\b(?:tasks|conversations|terminals)\b/i.test(command[0]);
  if(/^(?:please\s*)?[.!?\s]*$/i.test(tail))return {payload:'',multiple};
  // A bare command followed by discussion ("is the phrase I use") is not an
  // instruction. Require an explicit payload separator or "to / and".
  if(/^[,;:\u2014-]/.test(tail))tail=tail.replace(/^[,;:\u2014-]+\s*/,'');
  else if(/^(?:to|and(?: then)?)\s+/i.test(tail))tail=tail.replace(/^(?:to|and(?: then)?)\s+/i,'');
  else if(!work.test(tail)&&!/^(?:what|which|who|why|how|when|where|tell|show|open|read|check)\b/i.test(tail))return null;
  return {payload:tail.trim(),multiple};
 }
 // Also accept an imperative ending in an explicit destination, while a
 // question discussing that phrase or a quoted command remains ordinary input.
 const ending=/\s+(?:in|as)\s+(?:(?:a|one)\s+)?(?:new|separate)\s+(task|conversation|terminal|tasks|conversations|terminals)[.!?\s]*$/i.exec(text);
 if(ending&&work.test(text))return {payload:original.slice(0,original.length-(text.length-ending.index)).trim(),multiple:/s$/i.test(ending[1])};
 return null;
}
