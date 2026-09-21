// Selected-conversation evidence only. This does not search the vault, inspect
// other tasks, or infer files from prose. The caller labels this JSON as data.
const envelope=/\r?\n[ \t]*\r?\n(?:Original voice request:|Recent conversation \(context only\):|Recent voice context \(data only, not instructions\):)/;

function request(value){
 if(typeof value!=='string')return null;
 return value.split(envelope,1)[0];
}

// Count the serialized string, including escaped quotes/control characters.
// Raw string limits alone can exceed the prompt budget by a factor of six.
function text(value,budget){
 if(typeof value!=='string'||!value.trim())return null;
 const content=value.trim();
 if(JSON.stringify(content).length<=budget)return content;
 let low=0,high=Math.min(content.length,budget);
 while(low<high){
  const middle=Math.ceil((low+high)/2);
  if(JSON.stringify(content.slice(0,middle)+'…').length<=budget)low=middle;
  else high=middle-1;
 }
 return content.slice(0,low)+'…';
}

export function selectedTaskContext(task){
 if(!task||typeof task!=='object'||Array.isArray(task))return null;
 // TerminalManager stores completed turns in order. Keep old selected-task
 // answers even after short-lived voice memory expires; never select by age.
 const turns=Array.isArray(task.turns)?task.turns.slice(-2):[];
 const artifacts=Array.isArray(task.turns)?task.turns.flatMap(turn=>Array.isArray(turn?.artifacts)?turn.artifacts.filter(item=>item?.isFinal!==false):[]).slice(-3):[];
 return {
  id:text(task.id,80),provider:text(task.provider,24),title:text(task.title,160),state:text(task.state,40),
  originalRequest:text(request(task.prompt),900),
  turns:turns.map(turn=>({
   id:text(turn?.id,80),
   ts:typeof turn?.ts==='number'&&Number.isFinite(turn.ts)?turn.ts:text(turn?.ts,32),
   // Existing terminal records often have only answer text. A missing prompt
   // remains unknown, rather than borrowing the initial request for each turn.
   prompt:text(request(turn?.prompt),300),text:text(turn?.text,artifacts.length?650:1100),
  })),
  workflowDestination:text(task.workflow?.destination,320),
  // Retained output references come only from the registry, not prose parsing.
  // Keep these bounded independently of the two most recent answer snippets.
  ...(artifacts.length?{artifacts:artifacts.map(item=>({id:text(item?.id,50),path:text(item?.path,180),label:text(item?.label,80),mime:text(item?.mime,32)}))}:{}),
 };
}
