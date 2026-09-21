// Only for crediting traps in the strict-rules qualification; never part of the
// routing policy. Was the sentence an ATTEMPT at this kind of command? A word
// that merely occurs somewhere ("what do you SEE as the main risk"), or half a
// phrase ("can I HAVE a sandwich"), earns nothing: once greetings, courtesy,
// "can you" and a negation are stripped, the sentence must START with a complete
// command phrase of that kind, and a workspace command must also name a
// workspace surface.
const LEAD_STRIP=/^(?:(?:hey|hi|hello|ok|okay|all right|alright|so|well|um|uh|jarvis|astra|please|just|now|also|actually|and|then|yeah|yes|no)[,\s]+)*(?:(?:(?:can|could|would|will) you(?: please| just)?|would you mind|go ahead and|please|just|do not|don't|never)[,\s]+)*/i;
const LOOK='(?:see|view|look at|peek at|(?:take|have|get) a (?:quick |closer |brief )?(?:look|peek) at)';
const ATTEMPT={
 open:new RegExp(`^(?:open(?: up)?|reopen|re-open|show(?: me| us)?|display|pull (?:up|back up)|bring (?:up|back up)|put up|pop (?:open|up)|(?:pull|bring|put|pop) .+ up$|go to|navigate to|jump to|switch to|take me to|look at|(?:have|take) a (?:quick |closer |brief )?look at|check out|review|(?:can|could|may) (?:i|we)(?: please| just)? ${LOOK}|(?:let me|lemme|let's|lets|i wanna|i want to|i need to|i would like to|i'd like to) ${LOOK})\\b`,'i'),
 ui:/^(?:close|toggle|toggling|hide|show|collapse|expand|split|go back|go forward|switch to|open|launch|start|move|put|pull|bring|display)\b/i};
const SURFACE=/\b(?:tabs?|side ?bars?|graph|terminal|gmail|google mail|calendar|daily(?: note)?|you ?tube studio|split|back|forward|panes?|window|screen)\b/i;
export function attempted(kind,transcript){
 const text=String(transcript||'').normalize('NFKC').replace(/[‘’]/g,"'").replace(/[.!?]+$/,'').trim().replace(LEAD_STRIP,'');
 return Boolean(ATTEMPT[kind]?.test(text)&&(kind!=='ui'||SURFACE.test(text)));
}
