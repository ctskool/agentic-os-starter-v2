export class LiveUpdates {
 constructor(limitMs=20000){this.limitMs=limitMs;this.sequence=0;this.acknowledged=0;this.events=[];this.pending=null}
 push(event){
  this.events.push({...event,seq:++this.sequence});
  this.pending?.finish();
 }
 poll(cursor,signal){
  if(!Number.isSafeInteger(cursor)||cursor<0||cursor>this.sequence)throw new Error('Invalid Live updates cursor.');
  if(this.pending)throw new Error('A Live updates poll is already open.');
  if(cursor<this.acknowledged)throw new Error('This Live updates cursor was already acknowledged.');
  // The next cursor acknowledges the preceding response. Keeping unacknowledged
  // events lets a surface repeat a cursor after a dropped HTTP response.
  this.acknowledged=cursor;this.events=this.events.filter(event=>event.seq>cursor);
  const result=()=>({cursor:this.events.at(-1)?.seq??cursor,events:this.events.slice()});
  if(this.events.length||signal?.aborted)return Promise.resolve(result());
  return new Promise(resolve=>{
   const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);this.pending=null;resolve(result())};
   const timer=setTimeout(finish,this.limitMs);
   this.pending={finish};signal?.addEventListener('abort',finish,{once:true});
  });
 }
}
