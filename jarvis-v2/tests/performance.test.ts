import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleFrames} from '../../obsidian-v2/shared/visible-frames';

test('hidden artwork schedules no frames, resumes once, and releases observers on disposal',()=>{
 const pending=new Map<number,FrameRequestCallback>();let id=0,visible=true,draws=0,disconnected=0;
 const listeners=new Map<string,()=>void>();const observers:(()=>void)[]=[];
 class Observer {constructor(fn:()=>void){observers.push(fn)}observe(){}disconnect(){disconnected++}}
 const fakeWindow={IntersectionObserver:Observer,ResizeObserver:Observer,requestAnimationFrame:(fn:FrameRequestCallback)=>{pending.set(++id,fn);return id},cancelAnimationFrame:(n:number)=>pending.delete(n)};
 const fakeDocument={defaultView:fakeWindow,hidden:false,addEventListener:(name:string,fn:()=>void)=>listeners.set(name,fn),removeEventListener:(name:string)=>listeners.delete(name)};
 const frames=visibleFrames({ownerDocument:fakeDocument,getClientRects:()=>visible?[{}]:[]} as unknown as HTMLElement);
 try{
  const draw=()=>{draws++;frames.request(draw)};
  frames.request(draw);assert.equal(pending.size,1);
  visible=false;observers[0]();assert.equal(pending.size,0);
  visible=true;observers[0]();observers[1]();assert.equal(pending.size,1);
  const [key,fn]=[...pending][0];pending.delete(key);fn(1);assert.equal(draws,1);assert.equal(pending.size,1);
  fakeDocument.hidden=true;listeners.get('visibilitychange')!();assert.equal(pending.size,0);
  fakeDocument.hidden=false;listeners.get('visibilitychange')!();assert.equal(pending.size,1);
  frames.dispose();assert.equal(pending.size,0);assert.equal(disconnected,2);assert.equal(listeners.size,0);
 }finally{frames.dispose()}
});
