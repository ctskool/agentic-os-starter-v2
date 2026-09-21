import {SKILLS} from '../../obsidian-v2/shared/contract.mjs';
import {DEFAULT_HUD_SKILLS,MAX_DASHBOARD_SKILLS} from '../../obsidian-v2/shared/dashboard.mjs';
import {createPollStore} from '../../obsidian-v2/shared/poll-store.mjs';
import {bridge} from './bridge';

export type DashboardProvider='claude'|'codex';
export type DashboardSkill={id:string;label:string;description:string;kind:'builtin'|'installed';arg?:string;direct?:boolean;providers:DashboardProvider[];available:boolean;reason?:string};
export type DashboardSnapshot={revision:string;configured:boolean;selected:string[]|null;catalog:DashboardSkill[];installedProviders?:DashboardProvider[];error?:string};
export type DiscoveredSkill={path:string;label:string;description:string;providers:DashboardProvider[]};
export type DashboardDiscovery={skills:DiscoveredSkill[];skipped?:number;truncated?:boolean;warnings?:string[];error?:string};
export type DashboardState={data:DashboardSnapshot;loaded:boolean;error:string};
type Request=(path:string,body?:unknown,timeoutMs?:number)=>Promise<any>;

export const initialDashboard:DashboardSnapshot={revision:'',configured:false,selected:null,catalog:Object.entries(SKILLS).filter(([id])=>id!=='voice-ask').map(([id,spec])=>({id,label:spec.label,description:spec.instruction,kind:'builtin',arg:spec.arg,direct:spec.direct,providers:['claude','codex'],available:true}))};
export function dashboardIds(data:DashboardSnapshot):string[]{return [...(data.selected??DEFAULT_HUD_SKILLS)]}
export function dashboardEntries(data:DashboardSnapshot):DashboardSkill[]{return dashboardIds(data).map(id=>data.catalog.find(skill=>skill.id===id)??{id,label:id,description:'This saved skill is no longer in the catalog.',kind:'installed',providers:[],available:false,reason:'Skill unavailable. Remove it or register its current location in Customize dashboard.'})}
export function skillUnavailable(skill:DashboardSkill,provider:DashboardProvider,installedProviders?:DashboardProvider[]):string{
  if(!skill.available)return skill.reason||'This skill is unavailable.';
  if(!skill.providers.includes(provider))return `Use ${skill.providers.map(p=>p==='claude'?'Claude Code':'Codex').join(' or ')} for this skill.`;
  if(!skill.direct&&installedProviders&&!installedProviders.includes(provider))return `${provider==='claude'?'Claude Code':'Codex'} is not installed. Choose an installed coding tool or install this one.`;
  return '';
}
export function toggleDashboardSkill(ids:string[],id:string):string[]{
  if(ids.includes(id))return ids.filter(value=>value!==id);
  if(ids.length>=MAX_DASHBOARD_SKILLS)throw new Error(`Choose up to ${MAX_DASHBOARD_SKILLS} skills. Remove one before adding another.`);
  return [...ids,id];
}
export function moveDashboardSkill(ids:string[],id:string,step:-1|1):string[]{
  const index=ids.indexOf(id),next=index+step,result=[...ids];
  if(index>=0&&next>=0&&next<ids.length)[result[index],result[next]]=[result[next],result[index]];
  return result;
}
export function dashboardDiscoveryNotice(result:DashboardDiscovery):string{
  return [`${result.skills.length} installed skills found.`,result.skipped?`${result.skipped} unreadable, linked, or invalid locations skipped.`:'',result.truncated?'The search reached its limit; enter a full SKILL.md path for anything missing.':'',...(result.warnings??[]),'Choose only skills you recognize and trust.'].filter(Boolean).join(' ');
}
export function createDashboardSkillsStore(request:Request=bridge,isHidden=()=>typeof document!=='undefined'&&document.hidden){
  const store=createPollStore({initial:{data:initialDashboard,loaded:false,error:''} as DashboardState,intervalMs:5000,
    load:async():Promise<DashboardState>=>{if(isHidden())return store.getSnapshot();try{return {data:await request('/dashboard'),loaded:true,error:''}}catch(error){return {...store.getSnapshot(),error:error instanceof Error?error.message:'Dashboard preferences unavailable'}}},
    onStart:(refresh:()=>void)=>{if(typeof document==='undefined')return()=>{};const wake=()=>{if(!document.hidden)refresh()};document.addEventListener('visibilitychange',wake);return()=>document.removeEventListener('visibilitychange',wake)},
  });
  const publish=(data:DashboardSnapshot)=>{store.publish({data,loaded:true,error:''});return data};
  return {...store,
    save:async(revision:string,selected:string[]|null)=>publish(await request('/dashboard',{revision,selected})),
    register:async(revision:string,skill:Pick<DiscoveredSkill,'path'|'providers'> & {label?:string}):Promise<DashboardSnapshot & {registeredId:string}>=>{const result=await request('/dashboard/register',{revision,...skill});publish(result);return result},
    discover:(provider:DashboardProvider):Promise<DashboardDiscovery>=>request('/dashboard/discover?provider='+provider,undefined,15000),
  };
}
export const dashboardSkillsStore=createDashboardSkillsStore();
export async function launchInstalledSkill<T extends {provider:DashboardProvider;model:string}>(skill:DashboardSkill,requestText:string,selection:T,request:Request=bridge,installedProviders?:DashboardProvider[]){
  if(skill.kind!=='installed')throw new Error('Choose an installed skill to open in a terminal.');
  const reason=skillUnavailable(skill,selection.provider,installedProviders);if(reason)throw new Error(reason);
  if(!requestText.trim())throw new Error('Describe what you want this skill to do.');
  return request('/dashboard/launch',{id:crypto.randomUUID(),skill:skill.id,request:requestText.trim(),selection},15000);
}
