"use client";
import {useEffect,useRef,useState} from 'react';
import {skillUnavailable,type DashboardProvider,type DashboardSkill} from '@/lib/dashboard-skills';

export default function SkillBrowser({onClose,onSelect,available,catalog,provider,installedProviders}:{onClose:()=>void;onSelect:(id:string)=>void;available:boolean;catalog:DashboardSkill[];provider:DashboardProvider;installedProviders?:DashboardProvider[]}){
  const dialog=useRef<HTMLDialogElement>(null),[query,setQuery]=useState('');
  useEffect(()=>{const element=dialog.current,previous=document.activeElement as HTMLElement|null;element?.showModal();element?.querySelector('input')?.focus();return()=>{element?.close();previous?.focus()}},[]);
  const matches=catalog.filter(skill=>`${skill.id} ${skill.label} ${skill.description}`.toLowerCase().includes(query.toLowerCase().trim()));
  return <dialog ref={dialog} className="skill-browser" aria-labelledby="skill-browser-title" onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onClose()}}}>
    <header><div><h2 id="skill-browser-title">Your skills</h2><p>Find a workflow when you need it.</p></div><button onClick={onClose} aria-label="Close skill browser">×</button></header>
    <label className="skill-search"><span>Search</span><input type="search" aria-label="Search skills" placeholder="Research, planning, content…" value={query} onChange={e=>setQuery(e.target.value)}/></label>
    <div className="skill-browser-meta"><span>{matches.length} skills</span>{!available&&<span>Workflow runner offline</span>}</div>
    <div className="skill-results">
      {matches.map(skill=>{const reason=skillUnavailable(skill,provider,installedProviders);return <button key={skill.id} disabled={!available||!!reason} title={reason||skill.description} onClick={()=>{onClose();onSelect(skill.id)}}><span>{skill.label}<small>{skill.kind==='installed'?'Installed · opens in a terminal':skill.arg==='url'?'Provide a source URL':skill.arg?'Provide a topic':'Bundled workflow'}</small>{reason&&<small>{reason}</small>}</span><span aria-hidden="true">↗</span></button>})}
      {!matches.length&&<p className="skill-no-results">No matching skills. Try “research” or “plan”.</p>}
    </div>
    <footer>{available?'Uses your selected provider. Bundled workflows run in the background; installed skills open in a terminal.':'You can still start a conversation from Terminals.'}</footer>
  </dialog>;
}
