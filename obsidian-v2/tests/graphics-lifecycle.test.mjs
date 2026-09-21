import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const bundle=await build({entryPoints:['shared/visible-frames.ts','src/components/GalaxyCore.tsx','src/components/GraphCore.tsx'],bundle:true,platform:'node',format:'esm',write:false,outdir:'unused',plugins:[{
 name:'graphics-fixtures',setup(builder){
  builder.onResolve({filter:/^preact\/hooks$/},()=>({path:'hooks',namespace:'fixtures'}));
  builder.onResolve({filter:/^three$/},()=>({path:'three',namespace:'fixtures'}));
  builder.onLoad({filter:/.*/,namespace:'fixtures'},args=>({loader:'js',resolveDir:process.cwd(),contents:args.path==='hooks'?`
   export const useRef=value=>({current:value===null?globalThis.__graphics.mount:value});
   export const useState=value=>[value,next=>globalThis.__graphics.states.push(next)];
   export const useEffect=fn=>globalThis.__graphics.effects.push(fn);
  `:`
   export * from ${JSON.stringify(fileURLToPath(new URL('../node_modules/three/build/three.module.js',import.meta.url)))};
   export class WebGLRenderer {
    constructor(options){if(globalThis.__graphics.throwCreate)throw Error('No graphics');this.domElement=options.canvas;this.renders=0;this.sizes=[];this.disposed=0;this.released=0;globalThis.__graphics.renderers.push(this)}
    setPixelRatio(value){this.ratio=value}getPixelRatio(){return this.ratio}setClearColor(){}
    setSize(w,h){this.sizes.push([w,h])}render(scene,camera){if(globalThis.__graphics.throwRender)throw Error('Render failed');this.renders++;this.scene=scene;this.camera=camera}
    dispose(){this.disposed++}forceContextLoss(){this.released++;this.domElement.dispatchEvent(new Event('webglcontextlost',{cancelable:true}))}
   }
  `}));
 }
}]});
const modules=await Promise.all(bundle.outputFiles.map(f=>import('data:text/javascript;base64,'+Buffer.from(f.text).toString('base64'))));
const {visibleFrames,watchWebGLContext}=modules.find(m=>m.visibleFrames),GalaxyCore=modules.find(m=>m.default)?.default,{GraphCore}=modules.find(m=>m.GraphCore);

function fixture(t){
 const previous=globalThis.__graphics;
 const f={effects:[],states:[],renderers:[],throwCreate:false,throwRender:false};globalThis.__graphics=f;
 const queued=new Map(),observers=[],resizers=[];let sequence=1,rects=true;
 const view=new EventTarget();Object.assign(view,{
  innerWidth:1200,innerHeight:900,devicePixelRatio:1,
  requestAnimationFrame(fn){const id=sequence++;queued.set(id,fn);return id},cancelAnimationFrame(id){queued.delete(id)},
  matchMedia(){return {matches:false}},
  IntersectionObserver:class{constructor(fn){this.fn=fn;observers.push(this)}observe(){}disconnect(){this.off=true}},
  ResizeObserver:class{constructor(fn){this.fn=fn;resizers.push(this)}observe(){}disconnect(){this.off=true}}
 });
 const doc=new EventTarget();Object.assign(doc,{defaultView:view,hidden:false,createElement(){
  const canvas=new EventTarget();Object.assign(canvas,{ownerDocument:doc,style:{visibility:''},dataset:{},getContext:()=>({createRadialGradient:()=>({addColorStop(){}}),fillRect(){}}),remove(){this.removed=true}});return canvas;
 }});
 f.mount={ownerDocument:doc,clientWidth:128,clientHeight:128,getClientRects:()=>({length:rects?1:0}),closest:()=>null,appendChild(canvas){canvas.parent=this}};
 f.doc=doc;f.queued=queued;f.resizers=resizers;f.observers=observers;
 f.hide=value=>{rects=!value;for(const observer of [...observers,...resizers])if(!observer.off)observer.fn()};
 f.step=(now=1000)=>{const batch=[...queued.values()];queued.clear();for(const fn of batch)fn(now)};
 f.mountComponent=component=>{component({compact:true,bloom:false});f.cleanups=f.effects.map(fn=>fn()).filter(fn=>typeof fn==='function')};
 f.dispose=()=>{for(const cleanup of f.cleanups||[])cleanup();f.cleanups=[]};
 t.after(()=>{f.dispose();globalThis.__graphics=previous});
 return f;
}

test('hidden provider frames suspend without losing their callback and never run after disposal',t=>{
 const f=fixture(t);let calls=0;const frames=visibleFrames(f.mount);
 const tick=()=>{calls++;frames.request(tick)};frames.request(tick);assert.equal(f.queued.size,1);
 f.hide(true);assert.equal(f.queued.size,0);f.step();assert.equal(calls,0);
 f.hide(false);assert.equal(f.queued.size,1);f.step();assert.equal(calls,1);
 const stale=[...f.queued.values()][0];frames.dispose();stale(2000);frames.request(tick);frames.resume();assert.equal(calls,1);assert.equal(f.queued.size,0);
 assert.ok([...f.observers,...f.resizers].every(o=>o.off));
});

test('frame visibility follows the owning document and is checked again at callback time',t=>{
 const f=fixture(t);let calls=0;const frames=visibleFrames(f.mount);frames.request(()=>calls++);
 f.doc.hidden=true;f.step();assert.equal(calls,0);assert.equal(f.queued.size,0);
 f.doc.hidden=false;f.doc.dispatchEvent(new Event('visibilitychange'));f.step();assert.equal(calls,1);frames.dispose();
});

test('loss pauses frames and restoration resumes only when the provider becomes visible',t=>{
 const f=fixture(t),canvas=f.doc.createElement('canvas'),states=[];let restores=0,calls=0;
 const frames=visibleFrames(f.mount),tick=()=>{calls++;frames.request(tick)};
 const recovery=watchWebGLContext(canvas,frames,value=>states.push(value),()=>{restores++;frames.request(tick)});
 frames.request(tick);const lost=new Event('webglcontextlost',{cancelable:true});canvas.dispatchEvent(lost);
 assert.equal(lost.defaultPrevented,true);assert.equal(f.queued.size,0);assert.equal(canvas.style.visibility,'hidden');assert.equal(canvas.dataset.webglState,'lost');
 f.hide(true);canvas.dispatchEvent(new Event('webglcontextrestored'));assert.equal(restores,1);assert.equal(f.queued.size,0);assert.equal(canvas.style.visibility,'');
 f.hide(false);f.step();assert.equal(calls,1);assert.deepEqual(states,[true,false]);
 recovery.dispose();frames.dispose();canvas.dispatchEvent(new Event('webglcontextrestored'));assert.equal(restores,1);
});

test('render exceptions stop their scheduled successor instead of throwing every frame',t=>{
 const f=fixture(t);let errors=0;const frames=visibleFrames(f.mount,()=>errors++);
 const tick=()=>{frames.request(tick);throw new Error('Context fault')};frames.request(tick);f.step();assert.equal(errors,1);assert.equal(f.queued.size,0);f.step();assert.equal(errors,1);frames.dispose();
});

for(const [name,component]of [['Galaxy',GalaxyCore],['Graph',GraphCore]]){
 test(`${name} component redraws after context restoration and releases its canvas on unmount`,t=>{
  const f=fixture(t);f.mountComponent(component);const renderer=f.renderers[0];assert.ok(renderer);f.step();assert.equal(renderer.renders,1);
  f.hide(true);renderer.domElement.dispatchEvent(new Event('webglcontextlost',{cancelable:true}));assert.equal(f.states.at(-1),true);assert.equal(f.queued.size,0);
  renderer.domElement.dispatchEvent(new Event('webglcontextrestored'));assert.equal(f.states.at(-1),false);assert.equal(f.queued.size,0);
  f.hide(false);f.step(2000);assert.equal(renderer.renders,2);assert.deepEqual(renderer.sizes.at(-1),[128,128]);
  const stateCount=f.states.length;f.dispose();assert.equal(renderer.disposed,1);assert.equal(renderer.released,1);assert.equal(renderer.domElement.removed,true);assert.equal(f.queued.size,0);
  assert.equal(f.states.length,stateCount);renderer.domElement.dispatchEvent(new Event('webglcontextrestored'));assert.equal(f.states.length,stateCount);
 });
 test(`${name} component creation failure remains contained`,t=>{
  const f=fixture(t);f.throwCreate=true;assert.doesNotThrow(()=>f.mountComponent(component));assert.equal(f.states.at(-1),true);assert.equal(f.queued.size,0);
 });
}
