// Spoken stop, supersede and leading pleasantries. A bare "stop" during
// playback is cancelled by the client itself; these are the forms that reach
// the bridge.
const normalize=text=>String(text||'').normalize('NFKC').replace(/[’‘]/g,"'").replace(/[“”]/g,'"').replace(/\s+/g,' ').trim();
const LEAD="(?:(?:hey|ok|okay|jarvis|astra|please|wait|hold on|hang on|actually|no|oh|um|uh|er|hmm|so)[,\\s]+)*(?:(?:can|could|would|will) you(?: please)?\\s+)?";
const STOP=new RegExp(`^${LEAD}(?:stop|cancel|abort|halt|kill|scratch)(?:\\s+(?:that|it|this|everything|the (?:task|job|work|run)|that (?:task|job)|working(?: on (?:that|it|this))?|what you(?:'re| are) doing|the (?:current|running) (?:task|job|work|conversation)))?(?:\\s+(?:the )?(?<provider>codex|claude)(?: (?:task|job|worker|conversation))?)?(?:\\s+(?:right )?now)?(?:[,\\s]+(?:please|jarvis|astra|thanks))*[.!?\\s]*$`,'i');
// Returns {provider} (null when none was named) or null when this is not a stop.
export function stopIntent(text){const match=STOP.exec(normalize(text));return match?{provider:match.groups.provider?.toLowerCase()||null}:null}

// A running task is replaced only by a closed set of phrases at the start of
// the utterance, and only when what follows is punctuation, "and" or "then":
// "drop that adjective" and "stop that animation" are tweaks, "instead of
// stopping that" is an alternative to stopping, "use blue instead of red" is a
// change of colour. Anything unrecognised stays a follow-up, which at worst
// costs minutes; a wrong stop costs the work.
const DOING="(?:doing|explaining|making|creating|building|writing|drafting|researching|finishing|continuing|answering|summari[sz]ing|generating|designing|editing|running|reading|working on)";
const REFERENT=`(?:(?:${DOING} )?(?:that|this|it)|what you(?:'re| are) doing|(?:the|this|that) (?:current |whole |entire )?(?:task|job|work|approach|plan|idea|request|thing|one))`;
const SUPERSEDE=new RegExp(`^${LEAD}(?:instead(?: of ${REFERENT})?|scratch that|forget (?:that|it|about (?:that|it))|never ?mind (?:that|this|it)|change of plans|drop (?:that|it)|stop (?:that|it|what you(?:'re| are) doing|working on (?:that|it)))(?:\\s+(?:idea|plan|task|request|thing|one|approach))?(?:\\s+(?:entirely|completely|altogether|for now))?(?=\\s*(?:[,.!;:]|$)|\\s+(?:and|then)\\b)`,'i');
export function supersedeIntent(text){const t=normalize(text);return SUPERSEDE.test(t)&&!stopIntent(t)}

// A pleasantry before a request is not the request. Words that can also start
// content (Nice, Great, Cool) strip only before sentence punctuation; the
// rest may also end at a comma. A pleasantry alone stays small talk.
const SOFT="(?:hey|hi|hello|yo|ok|okay|alright|all right|got it|sounds good|thanks(?: a lot| so much)?|thank you(?: so much| very much)?|appreciate (?:it|that)|good (?:morning|afternoon|evening)|can you hear me|are you there|you there|mic check|testing(?: testing)?|loud and clear)";
const ADJECTIVE="(?:cool|nice|great|perfect|sweet|awesome)";
const PLEASANTRY=new RegExp(`^(?:(?:${SOFT}(?:\\s+(?:jarvis|astra|man))?(?:[,.!?;:]+\\s*|\\s+(?=(?:jarvis|astra)\\b))|${ADJECTIVE}(?:\\s+(?:jarvis|astra|man))?[.!?]+\\s*))+`,'i');
const DISCOURSE=/^(?:(?:jarvis|astra|okay|ok)(?:[,.!?;:\s]+|$))+/i;
export function stripPleasantry(text){
 const original=String(text||'').trim();
 if(!PLEASANTRY.test(original))return original;
 const rest=original.replace(PLEASANTRY,'').replace(DISCOURSE,'').trim();
 return rest&&rest!==original&&/[\p{L}\p{N}]/u.test(rest)?rest:original;
}
