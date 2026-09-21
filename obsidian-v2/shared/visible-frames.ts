// Retain graphics without scheduling animation callbacks for hidden artwork.
export function visibleFrames(element:HTMLElement,onError?:(error:unknown)=>void){
 const doc=element.ownerDocument,view=doc.defaultView||window;
 let callback:FrameRequestCallback|null=null,frame=0,disposed=false,suspended=false;
 const visible=()=>!doc.hidden&&element.getClientRects().length>0;
 const cancel=()=>{if(frame)view.cancelAnimationFrame(frame);frame=0};
 const schedule=()=>{
  if(disposed||suspended||frame||!callback||!visible())return;
  frame=view.requestAnimationFrame(t=>{
   frame=0;
   // A provider can hide or dispose its canvas after the frame was scheduled.
   if(disposed||suspended||!visible())return;
   const next=callback;callback=null;
   try{next?.(t)}catch(error){suspended=true;cancel();if(onError)onError(error);else throw error}
  });
 };
 const changed=()=>{if(!visible())cancel();schedule()};
 const observer=new view.IntersectionObserver(changed);observer.observe(element);
 const resize=new view.ResizeObserver(changed);resize.observe(element);
 doc.addEventListener('visibilitychange',changed);
 return {
  request(fn:FrameRequestCallback){if(!disposed){callback=fn;schedule()}return frame},
  pause(){suspended=true;cancel()},
  resume(){if(!disposed){suspended=false;schedule()}},
  dispose(){disposed=true;cancel();callback=null;observer.disconnect();resize.disconnect();doc.removeEventListener('visibilitychange',changed)}
 };
}

// Three restores its renderer internals first. Then resize/redraw our retained
// scene, including when the loss happened while a provider canvas was hidden.
export function watchWebGLContext(canvas:HTMLCanvasElement,frames:ReturnType<typeof visibleFrames>,onUnavailable:(value:boolean)=>void,onRestore:()=>void){
 let disposed=false,unavailable=false;
 const visibility=canvas.style.visibility;
 canvas.dataset.webglState='ready';
 const fail=()=>{
  if(disposed||unavailable)return;
  unavailable=true;frames.pause();canvas.style.visibility='hidden';canvas.dataset.webglState='lost';onUnavailable(true);
 };
 const lost=(event:Event)=>{event.preventDefault();fail()};
 const restored=()=>{
  if(disposed||!unavailable)return;
  try{onRestore()}catch(error){canvas.dataset.webglState='restore-error';console.warn('[Agentic OS] Graphics restoration failed.',error);return}
  unavailable=false;canvas.style.visibility=visibility;canvas.dataset.webglState='ready';onUnavailable(false);frames.resume();
 };
 canvas.addEventListener('webglcontextlost',lost);
 canvas.addEventListener('webglcontextrestored',restored);
 return {fail,dispose(){disposed=true;canvas.removeEventListener('webglcontextlost',lost);canvas.removeEventListener('webglcontextrestored',restored)}};
}
