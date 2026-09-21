/** A single plugin-lifetime owner of reports for jobs started in that lifetime.
 * Historical run records are never enrolled just because a dashboard mounts. */
export interface SkillReportRecord {
 id: string; skill: string; status: string; summary?: string;
 deliverable_path?: string | null;
}
interface PendingReport {id:string;skill:string;label:string;expectsReport:boolean;started:number;settledAt?:number}
interface ReportOptions {
 read:(id:string)=>Promise<SkillReportRecord|null>;
 ready:(path:string)=>Promise<boolean>;
 open:(path:string)=>Promise<void>;
 notice:(message:string)=>void;
 changed?:(pending:boolean)=>void;
 now?:()=>number;
}
export function checkedReportPath(value:unknown):string|null {
 if(typeof value!=='string'||!value||value!==value.trim()||/[\\:\x00-\x1f\x7f?#]/.test(value)||!value.endsWith('.md'))return null;
 const parts=value.split('/');
 if(parts.some(part=>!part||part==='.'||part==='..'||part.startsWith('.')))return null;
 return value;
}
export class SkillReportTracker {
 private pending=new Map<string,PendingReport>();
 private seen=new Set<string>();
 private busy=false;
 private again=false;
 private closed=false;
 private now:()=>number;
 constructor(private options:ReportOptions){this.now=options.now||Date.now}
 track(id:string,skill:string,label:string,expectsReport=true){
  if(this.closed||this.seen.has(id))return;
  this.seen.add(id);this.pending.set(id,{id,skill,label,expectsReport,started:this.now()});
  this.options.changed?.(true);return this.check();
 }
 private finish(job:PendingReport,message?:string){
  this.pending.delete(job.id);if(message)this.options.notice(message);
  this.options.changed?.(this.pending.size>0);
 }
 async check(){
  if(this.closed)return;
  if(this.busy){this.again=true;return}
  this.busy=true;
  try{
   do{
    this.again=false;
    for(const job of this.pending.values()){
     let run:SkillReportRecord|null=null;
     try{run=await this.options.read(job.id)}catch{/* A partial write or temporary vault read failure is retried. */}
     if(this.closed)return;
     if(!run||run.status==='running'||run.status==='queued'){
      if(this.now()-job.started>2*60*60_000)this.finish(job,`${job.label}: completion could not be confirmed. Check the Activity Feed.`);
      continue;
     }
     if(run.id!==job.id||run.skill!==job.skill){this.finish(job,`${job.label}: its result did not match this request. Check the Activity Feed.`);continue}
     if(run.status!=='ok'){
      const detail=typeof run.summary==='string'?run.summary.replace(/\s+/g,' ').trim().slice(0,220):'';
      this.finish(job,`${job.label} did not finish${detail?`: ${detail}`:'. Check the Activity Feed.'}`);continue;
     }
     if(!run.deliverable_path&&!job.expectsReport){this.finish(job,`${job.label} finished.`);continue}
     const path=checkedReportPath(run.deliverable_path);
     if(!path){this.finish(job,`${job.label}: no readable report was returned. Check the Activity Feed.`);continue}
     let ready=false;
     try{ready=await this.options.ready(path)}catch{/* The new file may not be indexed yet. */}
     if(this.closed)return;
     if(!ready){
      job.settledAt??=this.now();
      if(this.now()-job.settledAt>15_000)this.finish(job,`${job.label}: the report is not available to open. Check the Activity Feed.`);
      continue;
     }
     // Claim before awaiting the open: vault events and multiple mounted
     // dashboards cannot race into creating another tab for the same job.
     this.finish(job);
     try{await this.options.open(path)}catch{if(!this.closed)this.options.notice(`${job.label}: the report was saved, but could not be opened. Open it from the Activity Feed.`)}
    }
   }while(this.again&&!this.closed);
  }finally{this.busy=false}
 }
 dispose(){this.closed=true;this.pending.clear();this.seen.clear();this.options.changed?.(false)}
}
