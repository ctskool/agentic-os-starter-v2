"use client";
import {useEffect,useRef,useState} from 'react';
import {SKILLS} from '../../obsidian-v2/shared/contract.mjs';

const catalog=Object.entries(SKILLS).filter(([id])=>id!=='voice-ask');
export default function SkillBrowser({onClose,onSelect,available}:{onClose:()=>void;onSelect:(id:string)=>void;available:boolean}){
  const dialog=useRef<HTMLDialogElement>(null),[query,setQuery]=useState('');
  useEffect(()=>{const element=dialog.current,previous=document.activeElement as HTMLElement|null;element?.showModal();element?.querySelector('input')?.focus();return()=>{element?.close();previous?.focus()}},[]);
  const matches=catalog.filter(([id,skill])=>`${id} ${skill.label}`.toLowerCase().includes(query.toLowerCase().trim()));
  return <dialog ref={dialog} className="skill-browser" aria-labelledby="skill-browser-title" onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onClose()}}}>
    <header><div><h2 id="skill-browser-title">Your skills</h2><p>Find a workflow when you need it.</p></div><button onClick={onClose} aria-label="Close skill browser">×</button></header>
    <label className="skill-search"><span>Search</span><input type="search" aria-label="Search skills" placeholder="Research, planning, content…" value={query} onChange={e=>setQuery(e.target.value)}/></label>
    <div className="skill-browser-meta"><span>{matches.length} skills</span>{!available&&<span>Workflow runner offline</span>}</div>
    <div className="skill-results">
      {matches.map(([id,skill])=><button key={id} disabled={!available} onClick={()=>{onClose();onSelect(id)}}><span>{skill.label}{skill.arg&&<small>{skill.arg==='url'?'Provide a source URL':'Provide a topic'}</small>}</span><span aria-hidden="true">↗</span></button>)}
      {!matches.length&&<p className="skill-no-results">No matching skills. Try “research” or “plan”.</p>}
    </div>
    <footer>{available?'Uses the provider selected in your dashboard.':'You can still start a conversation from Terminals.'}</footer>
  </dialog>;
}
