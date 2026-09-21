"use client";
import {useEffect,useState} from 'react';
import type {CodexUsage} from '@/lib/usage';

export default function ProviderUsage({provider}:{provider:'codex'|'claude'}){
  const [readings,setReadings]=useState<Partial<Record<'codex'|'claude',CodexUsage>>>({});
  const usage=readings[provider],name=provider==='claude'?'Claude':'Codex';
  useEffect(()=>{
    let gone=false,busy=false;const controller=new AbortController();
    const pull=async()=>{if(busy||document.visibilityState==='hidden')return;busy=true;try{const r=await fetch(`/api/usage?provider=${provider}`,{cache:'no-store',signal:controller.signal});if(!r.ok)throw new Error();const next=await r.json();if(!gone)setReadings(old=>({...old,[provider]:next}))}catch{if(!gone)setReadings(old=>({...old,[provider]:{windows:old[provider]?.windows||[],checkedAt:old[provider]?.checkedAt||null,status:old[provider]?.windows.length?'stale':'unavailable',message:'Usage reader unavailable.'}}))}finally{busy=false}};
    void pull();const timer=setInterval(()=>void pull(),60000);document.addEventListener('visibilitychange',pull);return()=>{gone=true;controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',pull)};
  },[provider]);
  const weekly=usage?.windows.find(w=>w.windowDurationMins===10080);
  const pct=weekly?.usedPercent;
  const issue=usage&&usage.status!=='ok'?usage.message:undefined;
  return <section className="weekly-gauge" data-provider={provider} aria-label={name+' weekly usage'}>
    {['tl','tr','bl','br'].map(corner=><span key={corner} aria-hidden="true" className={'weekly-gauge-corner weekly-gauge-corner--'+corner}/>)}
    <header><span>{name} · Weekly usage</span>{usage?.status==='stale'&&<small tabIndex={0} title={issue} aria-label={'Last known. '+issue}>Last known</small>}</header>
    <div className="weekly-gauge-number">{pct===undefined?'—':Math.round(pct)}<small tabIndex={pct===undefined&&issue?0:undefined} title={pct===undefined?issue:undefined} aria-label={pct===undefined&&issue?'Unavailable. '+issue:undefined}>{pct===undefined?(!usage?'Loading':'Unavailable'):'% used'}</small></div>
    <div className="weekly-gauge-bar" role="progressbar" aria-label={name+' weekly usage'} aria-valuenow={pct} aria-valuetext={pct===undefined?(!usage?'Loading':'Unavailable'):Math.round(pct)+'% used'} aria-valuemin={0} aria-valuemax={100}>
      <div className="weekly-gauge-track"/>
      <div className="weekly-gauge-ticks"/>
      <div className="weekly-gauge-fill" style={{width:Math.min(100,Math.max(0,pct??0))+'%'}}><span className="weekly-gauge-comet"/></div>
      {pct!==undefined&&pct>0&&<div className="weekly-gauge-endpoint" style={{left:Math.min(100,pct)+'%'}}><span className="weekly-gauge-endpoint-pulse"/><span className="weekly-gauge-endpoint-core"/></div>}
    </div>
    <div className="weekly-gauge-ruler" aria-hidden="true"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div>
  </section>;
}
