export interface VoiceArtifact {id:string;taskId:string;turnId:string;path:string;label:string;mime:string;bytes:number}
export type ArtifactOpener=(artifact:VoiceArtifact,signal?:AbortSignal)=>Promise<void>;
interface ArtifactAck {client:string;id:string;ok:boolean;error?:string}
type Request=(path:string,body:unknown)=>Promise<any>;

// Opening a file is a durable UI action, separate from an expiring speech item.
// Keep the receipt before sending it so a lost ACK can never reopen the same file.
export class ArtifactDelivery {
 private pendingAck:ArtifactAck|null=null;private receipts=new Map<string,ArtifactAck>();
 private active:AbortController|null=null;private disposed=false;private generation=0;
 constructor(private request:Request,private client:string,private canOpen:()=>boolean,private open:ArtifactOpener,private report:(text:string)=>void){}
 async tick(presence?:Record<string,unknown>){
  if(this.disposed)return;
  if(this.pendingAck){await this.request('/artifacts/ack',this.pendingAck);this.pendingAck=null}
  if(!this.canOpen())return;
  const generation=this.generation,response=await this.request('/artifacts/claim',{client:this.client,...presence});
  const action=response?.action;if(!action?.id)return;
  const previous=this.receipts.get(action.id);if(previous){this.pendingAck=previous;await this.request('/artifacts/ack',previous);this.pendingAck=null;return}
  const controller=new AbortController();this.active=controller;
  let timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{},ok=false,timedOut=false,error:string|undefined;
  try{
   if(this.disposed||generation!==this.generation||!this.canOpen()){controller.abort();throw new Error('Opening was cancelled.');}
   await Promise.race([
    this.open(action.artifact,controller.signal),
    new Promise<never>((_resolve,reject)=>{abort=()=>reject(new Error('Opening was cancelled.'));controller.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>{timedOut=true;reject(new Error('The file took too long to open.'));controller.abort()},25000)})
   ]);
   ok=true;
  }catch(cause){error=cause instanceof Error?cause.message:'The file could not be opened.';if(!this.disposed&&(timedOut||!controller.signal.aborted))this.report(error)}
  finally{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);if(this.active===controller)this.active=null}
  const receipt:ArtifactAck={client:this.client,id:action.id,ok,...(error?{error:error.slice(0,300)}:{})};
  this.receipts.set(action.id,receipt);while(this.receipts.size>500)this.receipts.delete(this.receipts.keys().next().value!);
  this.pendingAck=receipt;await this.request('/artifacts/ack',receipt);this.pendingAck=null;
 }
 cancel(){this.generation++;this.active?.abort()}
 destroy(){this.disposed=true;this.cancel()}
}
