import {createJiti} from 'jiti';
import {selectCompletionAnswer,selectSpokenAnswer} from './spoken-answer.mjs';
const {completionSpeech}=createJiti(import.meta.url)('../shared/speech-text.ts');
const viewerLocation='(?:in|on|inside)\\s+(?:(?:your|the|a|an|this|another|new|current)\\s+)*(?:screen|dashboard|tab|window|viewer|Obsidian)\\b(?:\\s+now)?';
const presentationObject=/^\s+(?:(?:the|your|this|that|a|an|new|updated|final)\s+)*(?:image|graphic|file|document|report|result|preview|explainer|diagram|figure|illustration|chart|it|them|files|images)\b/i;
function qualifiedPresentation(input,offset){
 // Polarity belongs to the current clause. A caveat about source accuracy
 // must not authorize a separate affirmative claim about the viewer.
 const clause=input.slice(0,offset).split(/[.!?;,\n]|\b(?:but|and|however|although)\b/i).at(-1)||'';
 return /\b(?:not|never|cannot|can't|couldn't|isn't|aren't|wasn't|weren't|hasn't|haven't|if|unless|whether)\b/i.test(clause);
}

// A CLI can know it created a file, but only the viewer knows whether it opened.
// Normalize that narrow claim without deleting the result, uncertainty, or a
// reported inability to show it. This acts on speech only; written output stays
// intact. Descriptions such as "the chart shows the mechanism" are not actions.
export function pendingArtifactPresentation(text){
 return String(text||'')
  // Match a presentation state plus a viewer location, rather than particular
  // sentences. The location is removed too: preparing a file is not evidence
  // that a dashboard, screen, or tab has displayed it. Preserve negative and
  // conditional clauses, which report a limitation rather than successful UI.
  .replace(/\b(?:(?:now|already|currently|successfully)\s+)?(?:open(?:ed)?|displayed|shown|showing|visible|up|rendered)\s+(?:in|on|inside)\s+(?:(?:your|the|a|an|this|another|new|current)\s+)*(?:screen|dashboard|tab|window|viewer|Obsidian)\b(?:\s+now)?/gi,(match,offset,input)=>{
   return qualifiedPresentation(input,offset)?match:'ready to view';
  })
  .replace(/\b(created|made|prepared|generated|saved|finished|updated|built)\s+(?:and|&)\s+(?:opened|displayed|shown|pulled\s+up)\b/gi,'$1')
  .replace(/\b(I|we)(?:['’](?:ve|m|re)|\s+(?:have|had|am|are))?\s+(?:(?:now|already|successfully|currently)\s+)?(?:open(?:ed|ing)?|display(?:ed|ing)?|show(?:n|ed|ing)?|pull(?:ed|ing)?\s+up)\b(?=\s+(?!(?:how|why|what|that)\b))([^.!?;\n]*)/gi,(match,subject,object,offset,input)=>{
   // "We show a reduction" describes a finding, not a presentation action.
   if(qualifiedPresentation(input,offset)||!presentationObject.test(object)&&!new RegExp(viewerLocation,'i').test(object))return match;
   return `${subject} prepared${object.replace(new RegExp('\\s+'+viewerLocation,'gi'),'')}`;
  })
  .replace(/\b((?:I|we)(?:['’]ve|\s+have)?\s+)(?:put|placed)\s+(it|them|the\s+(?:image|graphic|file|document|report|result|preview|explainer))\s+on\s+your\s+screen\b/gi,'$1prepared $2 for viewing')
  .replace(/\b((?:(?:the|your|this|that)\s+)?(?:image|graphic|file|document|report|result|preview|explainer|diagram|figure|illustration|chart|it|they|files|images))\s+(?:is|are|has\s+been|have\s+been)(?:\s+(?:now|already|successfully))?\s+(?:open(?:ed)?|displayed|shown|visible)\b/gi,(match,subject,offset,input)=>qualifiedPresentation(input,offset)?match:`${subject} ${/(?:^|\s)(?:they|files|images)$/i.test(subject)?'are':'is'} ready to view`)
  .replace(/(^|[.!?]\s+)(Opened|Displayed|Shown)(?=\s+(?:above|below|inline|here)\b)/g,'$1Ready to view')
  .replace(/\b(?:and|then)\s+(?:I\s+)?(?:opened|displayed|showed|pulled\s+up)\s+(it|them)\b/gi,'and prepared $1 for viewing');
}

export function artifactOutcomeSpeech(record,turn){
 const artifacts=(turn?.artifacts||[]).filter(item=>item?.isFinal!==false),errors=turn?.artifactErrors||[];
 const selected=selectCompletionAnswer(record,turn);
 let outcome=pendingArtifactPresentation(selected);
 if(artifacts.length&&outcome==='The detailed result is in the written reply.')outcome=artifacts.length>1?'Your files are ready.':'Your file is ready.';
 if(errors.length)outcome+=' '+(artifacts.length?"Some files couldn't be made available here. Check the written result for those files.":"I couldn't make the output available here. Check the written result.");
 // Run the established qualification-preserving selector again after adding an
 // authoritative import failure, so brevity cannot erase that failure.
 return completionSpeech(record?.title||'',selectSpokenAnswer(outcome));
}
