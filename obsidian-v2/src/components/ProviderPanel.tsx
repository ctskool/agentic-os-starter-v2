import { h } from 'preact';
import { useState } from 'preact/hooks';
import type ChaseCommandCenter from '../main';
import { saveSelection, type Provider, type useProvider } from '../lib/provider';
import { MODELS } from '../../shared/contract.mjs';
export function ProviderPanel({plugin,state,busy}:{plugin:ChaseCommandCenter;state:ReturnType<typeof useProvider>;busy:boolean}){
 const [saving,setSaving]=useState(false),[error,setError]=useState('');
 const choose=async(provider:Provider,model=MODELS[provider][0]!)=>{if(saving||(provider===state.selection.provider&&model===state.selection.model))return;setSaving(true);try{await saveSelection(plugin.app,{provider,model});setError('')}catch(e){setError(String(e))}finally{setSaving(false)}};
 const current=state.selection.provider;
 return <div className="v2-header-agent">
  <div className="v2-provider-switch" role="group" aria-label="Execution provider">{(['codex','claude'] as Provider[]).map(p=><button aria-pressed={p===current} disabled={saving} onClick={()=>void choose(p)}>{p==='codex'?'Codex':'Claude Code'}</button>)}</div>
  <details className="v2-agent-options">
   <summary aria-label="Agent settings" title="Agent settings"><svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M3 5h14M3 10h14M3 15h14"/><circle cx="7" cy="5" r="2"/><circle cx="13" cy="10" r="2"/><circle cx="7" cy="15" r="2"/></svg></summary>
   <div className="v2-agent-menu">
    <label className="v2-model">Worker model <select value={state.selection.model} disabled={saving} onChange={e=>void choose(current,e.currentTarget.value)}>{MODELS[current].map(m=><option value={m}>{m==='claude-fable-5-1'?'Fable 5.1':m}</option>)}</select></label>
    <p className="v2-status" role="status">{state.health?state.health.providers[current]?.installed?'Terminal bridge ready':`${current} CLI not installed`:'Terminal bridge offline · Start V2'}</p>
    <p className="v2-detail">Changes apply to the next job. Running jobs keep their provider.</p>
    <label className="v2-pause"><input type="checkbox" checked={plugin.settings.pauseMotion} onChange={e=>{plugin.settings.pauseMotion=e.currentTarget.checked;void plugin.saveSettings();window.dispatchEvent(new Event('aos-v2-settings'))}}/> Pause background motion</label>
    <p className="v2-detail">Voice controls are on the floating bubble. Connectors use each CLI’s own sign-in; permission requests appear in its terminal.</p>
   </div>
  </details>
  {(error||state.error)&&<span className="v2-provider-error" role="alert">{error||state.error}</span>}
 </div>;
}
