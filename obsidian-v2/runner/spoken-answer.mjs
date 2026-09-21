// Prefer speech composed by the model already doing the work. These small
// presentation helpers never call a model or change the written deliverable.
import {createJiti} from 'jiti';
// Loaded once with this module. Measure the real number/Markdown formatter,
// which can expand a short written sentence beyond the spoken-text budget.
const {formatSpeech, isSpeechQualification, completionSpeech} = createJiti(import.meta.url)('../shared/speech-text.ts');
export const SPOKEN_REPLY_STYLE = 'Write the spoken reply as one to three natural conversational sentences. Answer the actual question with the available facts and preserve important uncertainty, missing information, and qualifications. Lead with the answer, use natural contractions and short sentences, and explain sequences with ordinary transitions. For follow-ups, continue the subject without repeating the question or introducing yourself again. Use a calm, direct tone; avoid canned praise, repeated acknowledgments, theatrical enthusiasm and unnecessary sign-offs. Give exact values when precision matters; do not round prices, identifiers, or requested exact figures. Use plain language, not headings, Markdown, tables, raw file paths, or a repeated request. Do not invent facts or imply unfinished work is complete.';
export const WORKER_SPOKEN_STYLE = 'When your output format permits it, lead your final answer with a brief conversational answer or outcome that can be spoken aloud, including important uncertainty, partial completion, or anything still blocked. Put all material limitations and failures in that opening, even if they are also explained later. Use short sentences, natural contractions, and ordinary transitions for sequences. Give enough subject context to identify the result without repeating the dictated request. For follow-ups, continue naturally; skip canned praise, needless introductions and sign-offs. Put a blank line before the full written details, sources, or artifact links. Describe the actual result, not the original request or terminal mechanics. Exact-output requests and existing workflow deliverable formats take precedence: never add a preface to a required document, schema, code-only answer, or other exact format. Do not add hidden markers, separate metadata, or another tool or model call for speech.';
export {ARTIFACT_HANDOFF_INSTRUCTIONS,artifactHandoffInstructions} from './artifact-instructions.mjs';

const WRITTEN_RESULT = 'The detailed result is in the written reply.';
const QUALIFIED_RESULT = 'There are important limitations in the result. Please read the full written reply.';
const CLIPPED_SUFFIX = ' The full answer is in the written reply.';
const segmenter = new Intl.Segmenter('en', {granularity: 'sentence'});
const sentences = text => [...segmenter.segment(text)].map(part => part.segment.trim()).filter(Boolean);
const terminate = text => /[.!?][”"')\]]*$/.test(text) ? text : text + '.';

function readable(text) {
 return text.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
  .replace(/\[\^[^\]]+\]/g, '')
  .replace(/\bhttps?:\/\/[^\s<>]+/g, 'the linked page')
  .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|var|mnt)\/)[^\s<>"`]+/g, 'the output file')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_match, bold, underline) => bold || underline)
  .replace(/\s+/g, ' ').trim();
}

// Read Markdown as blocks instead of flattening a table or code sample into
// an accidental sentence. Prose and list facts retain their original wording.
function spokenBlocks(input) {
 const candidate = input.trim();
 if (/^[{\[]/.test(candidate) && /[}\]]$/.test(candidate)) {
  try {if (typeof JSON.parse(candidate) === 'object') return [];} catch {}
 }
 const text = input.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
  .replace(/<!--[\s\S]*?(?:-->|$)/g, '');
 const lines = text.split(/\r?\n/), blocks = [];
 let paragraph = [], fence = null;
 const flush = () => {const value = readable(paragraph.join(' ')); if (value) blocks.push({kind: 'prose', text: value}); paragraph = [];};
 const separator = line => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
 let table = false;
 for (let index = 0; index < lines.length; index++) {
  let line = lines[index];
  const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
  if (marker) {flush(); if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null; continue;}
  if (fence) continue;
  if (!line.trim()) {flush(); table = false; continue;}
  if (separator(lines[index + 1] || '') || separator(line) || /^\s*\|.*\|\s*$/.test(line)) {flush(); table = true; continue;}
  if (table && line.includes('|')) continue;
  table = false;
  if (/^\s{0,3}#{1,6}\s|^\s*(?:[-*_]\s*){3,}$|^\s*(?:\[[^\]]+\]):\s/.test(line)) {flush(); continue;}
  // Standalone filenames, image links, and tool receipts aren't an answer.
  if (/^\s*(?:!\[[^\]]*\]\([^)]*\)|(?:SAVED|CREATED|WROTE|OUTPUT|FILE|ARTIFACT)\s*:?\s+(?:[A-Za-z]:[\\/]|\/|[\w.-]+[\\/]).*|(?:[A-Za-z]:[\\/]|\/|[\w.-]+[\\/])[^\s]+)\s*$/i.test(line)) {flush(); continue;}
  line = line.replace(/^\s*>\s?/, '');
  const item = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.*)$/.exec(line);
  if (item) {flush(); const value = readable(item[1]); if (value) blocks.push({kind: 'list', text: terminate(value)});}
  else paragraph.push(line);
 }
 flush(); return blocks;
}

function fitsCompletion(text) {
 // Leave a little room below completionSpeech's 420-character limit, and check
 // its actual output too (artifact-path replacements may expand some inputs).
 return formatSpeech(text).length <= 400 && !completionSpeech('', text).endsWith(CLIPPED_SUFFIX);
}

function boundedCompletion(opening, limitations) {
 const required = [...new Set(limitations)];
 if (required.length && !fitsCompletion(required.join(' '))) return QUALIFIED_RESULT;
 const order=[...new Set([...opening,...required])],selected=new Set(required);
 const render=()=>order.filter(sentence=>selected.has(sentence)).join(' ');
 for (const sentence of opening) {
  if (selected.has(sentence)) continue;
  selected.add(sentence);
  if (!fitsCompletion(render())){selected.delete(sentence);break}
 }
 // Always reserve complete direct qualifications before fitting optional
 // prose. Never clip a sentence whose "but" or "not" might be at its end.
 const result = render();
 return result || WRITTEN_RESULT;
}

export function selectSpokenAnswer(text, {mode = 'completion'} = {}) {
 if (typeof text !== 'string' || !text.trim()) return WRITTEN_RESULT;
 const blocks = spokenBlocks(text);
 if (!blocks.length) return WRITTEN_RESULT;
 const all = blocks.map(block => block.text).join(' ');
 // Quick answers are already scoped by the router: retain every supplied fact
 // and requested list item. The shared speech budget is applied downstream.
 if (mode === 'reply') return all;
 if (fitsCompletion(all)) return all;
 const first = blocks[0];
 const short = all.split(/\s+/).length <= 90 && blocks.length <= 4;
 const opening = short ? blocks.flatMap(block => sentences(block.text)) : first.kind === 'prose' ? sentences(first.text).slice(0, 3) : blocks.slice(0, 3).map(block => terminate(block.text));
 const limitations = [],allSentences=blocks.flatMap(block=>sentences(block.text));
 for (const [index,sentence] of allSentences.entries()) {
  if(isSpeechQualification(sentence)){
   if(index>0&&/^(?:it|this|that|they|these|those|otherwise)\b/i.test(sentence))limitations.push(allSentences[index-1]);
   limitations.push(sentence);
  }
 }
 return boundedCompletion(opening, limitations);
}

export function selectCompletionAnswer(record, turn) {
 // The bridge may reject a conflicting note edit after the worker reports
 // success. Its current error is authoritative; an old workflowStatus alone
 // must not overwrite a later, unrelated successful conversation turn.
 if (record?.workflowCompleted && record.workflowStatus === 'error' && record.error) {
  const reason = String(record.error).replace(/^\s*BLOCKED:\s*/i, '');
  const answer = 'The workflow did not complete. ' + reason;
  // A save rejection is authoritative even when the worker's written answer
  // says success. If its full reason cannot fit, keep the failed outcome.
  return fitsCompletion(answer) ? selectSpokenAnswer(answer, {mode: 'reply'}) : 'The workflow did not complete, so I cannot confirm that the result was saved.';
 }
 return selectSpokenAnswer(turn?.text);
}
