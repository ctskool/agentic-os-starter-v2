// Tool hand-offs (GPT-Live "Responses delegation"), chosen with `aos voice live-handoff tools`.
//
// With client delegation V2 is told only that a hand-off happened, and rebuilds the caller's request from transcript
// fragments: that is where the talk-over joins, mid-sentence waits and phrase lists came from (2026-11-26). Here a small
// OpenAI model that already has the conversation calls one of these tools, with the request written out and, for a
// follow-up or a cancel, the task it concerns. V2 runs it through the same router and answers with what happened.
//
// Checked on real calls, 2026-11-27: the tool call arrives about 1.3 s after the caller's last word; "Wait six full
// minutes…" arrives whole as new work; "wait, actually never mind" arrives as cancel for the right task. A tool call
// left pending keeps the call awake but blocks every later hand-off (the next one waited 21 s), so V2 always answers
// at once and says results later as plain lines (task-updates.mjs), through a fresh session after standby.
export const TOOL_BACKEND_MODEL='gpt-6-luna';
export const TOOL_INSTRUCTIONS=`You route voice requests from the user to V2, the assistant software on their computer. You are given the conversation.
Call at most one tool per turn. Write each argument in the user's own words, as close to word for word as you can, with every concrete detail they gave (numbers, names, where to save it), including anything they added after a pause or while the voice assistant was talking. Add nothing of your own: no extra steps, caveats, quality bars or research instructions, and nothing the voice assistant said.
Use follow_up_task only when they refer back to a task from this call; otherwise start_task. Use cancel_task for "never mind" or "stop that".
After the tool returns, reply with one short spoken sentence saying what its "say" field reports. A result with status "started" means the work has only begun: say it has started, never that it is done, saved or ready. No markdown, no file paths. If nothing needs a tool, or the latest request was already handled, reply with exactly: NOTHING`;
const fn=(name,description,required,properties)=>({type:'function',name,strict:true,description,parameters:{type:'object',additionalProperties:false,required,properties}});
export const LIVE_TOOLS=Object.freeze([
 fn('start_task',"Start a NEW background task on the user's computer (research, drafting, writing a note, running a workflow or a slash skill).",['request'],
  {request:{type:'string',description:"The complete request in the user's words, with every constraint they gave."}}),
 fn('follow_up_task','Add an instruction, edit or follow-up to a task already started in this call.',['task_ref','change'],
  {task_ref:{type:'string',description:'Task id from an earlier tool result, for example t1.'},change:{type:'string',description:'The change or addition the user asked for.'}}),
 fn('cancel_task','Cancel or stop a task started in this call ("never mind", "stop that").',['task_ref'],
  {task_ref:{type:'string',description:'Task id from an earlier tool result, or "latest".'}}),
 fn('get_task_status','How a task started in this call is going.',['task_ref'],
  {task_ref:{type:'string',description:'Task id from an earlier tool result, or "all".'}}),
 fn('confirm_action','The user answered yes or no to V2\'s question "say yes to go ahead".',['confirm'],
  {confirm:{type:'boolean',description:'true for yes / go ahead, false for no / cancel.'}}),
 fn('ask_vault',"A read-only lookup on the user's computer: a fresh calendar or inbox reading, or a note that is not in the snapshot.",['question'],
  {question:{type:'string',description:'The lookup question, in full.'}})
]);
export const toolDelegation=()=>({type:'responses',acknowledgement_delay_ms:700,
 responses:{model:TOOL_BACKEND_MODEL,instructions:TOOL_INSTRUCTIONS,tools:LIVE_TOOLS,tool_choice:'auto',parallel_tool_calls:false}});

const text=value=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,4000):'';
// A tool call as V2's router wants it: what kind of request, its words, and which of this call's tasks it concerns.
// `refs` maps the ids V2 gave the model (t1, t2…) to real task ids; nothing outside this call is ever named to it.
export function toolRequest(name,rawArguments,refs){
 let args;try{args=typeof rawArguments==='string'?JSON.parse(rawArguments):rawArguments}catch{return null}
 if(!args||typeof args!=='object')return null;
 const ref=text(args.task_ref).toLowerCase(),ids=[...refs.values()];
 const taskId=ref==='latest'?ids.at(-1)??null:refs.get(ref)??null;
 if(name==='start_task')return text(args.request)?{kind:'new_work',request:text(args.request),taskId:null}:null;
 // A follow-up that names no task V2 knows: with one task on the call it is that one; with none it is new work
 // ("make that note shorter" about something from before the call); with several, V2 asks which.
 if(name==='follow_up_task'){
  if(!text(args.change))return null;
  const only=ids.length===1?ids[0]:null,target=taskId??only;
  if(!target&&ids.length>1)return {kind:'unclear',request:text(args.change),taskId:null,say:'Which task is that for?'};
  return {kind:target?'follow_up':'new_work',request:text(args.change),taskId:target};
 }
 if(name==='cancel_task')return {kind:'cancel',request:'Stop that task.',taskId};
 if(name==='get_task_status')return {kind:'status',request:"How's that going?",taskId};
 if(name==='confirm_action')return typeof args.confirm==='boolean'?{kind:'confirm',request:args.confirm?'Yes.':'No.',confirm:args.confirm,taskId:null}:null;
 if(name==='ask_vault')return text(args.question)?{kind:'question',request:text(args.question),taskId:null}:null;
 return null;
}
// The function-call item inside a `response.event` envelope, when that event completes one.
export function toolCall(event){
 const inner=event?.type==='response.event'?event.event:null,item=inner?.type==='response.output_item.done'?inner.item:null;
 return item?.type==='function_call'&&typeof item.call_id==='string'&&item.call_id&&typeof item.name==='string'?{callId:item.call_id,name:item.name,arguments:item.arguments}:null;
}
