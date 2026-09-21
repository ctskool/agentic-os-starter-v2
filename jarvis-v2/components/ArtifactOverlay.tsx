"use client";

import {useEffect,useRef,useState} from 'react';
import {artifactUrl,loadArtifact,type ArtifactView} from '../lib/artifact-viewer';
import {ArtifactText} from '../lib/artifact-text';

export default function ArtifactOverlay({view,onClose,onLoaded,onFailed}:{view:ArtifactView;onClose:()=>void;onLoaded:(generation:number)=>void;onFailed:(generation:number,error:string)=>void}){
 const {artifact,generation}=view;
 const [content,setContent]=useState<{url:string|null;text:string|null;mime:string}|null>(null),[error,setError]=useState('');
 const close=useRef<HTMLButtonElement>(null),loaded=useRef(false);
 useEffect(()=>{
  const previous=document.activeElement;close.current?.focus();return()=>{if(previous instanceof HTMLElement&&previous.isConnected)previous.focus()};
 },[]);
 useEffect(()=>{
  const controller=new AbortController();let url:string|null=null,active=true;loaded.current=false;setContent(null);setError('');
  const timer=setTimeout(()=>controller.abort(),16000);
  void loadArtifact(artifact,controller.signal).then(result=>{
   if(!active||controller.signal.aborted)return;
   if(result.text===null)url=URL.createObjectURL(result.blob);
   setContent({url,text:result.text,mime:result.mime});
  }).catch(cause=>{if(!active)return;const message=cause instanceof Error?cause.message:'The saved file could not be displayed.';setError(message);onFailed(generation,message)}).finally(()=>clearTimeout(timer));
  return()=>{active=false;controller.abort();clearTimeout(timer);if(url)URL.revokeObjectURL(url)};
 },[artifact,generation,onFailed]);
 const ready=()=>{if(!loaded.current){loaded.current=true;onLoaded(generation)}};
 const fail=()=>{const message='The saved file could not be displayed.';setError(message);onFailed(generation,message)};
 useEffect(()=>{if(content?.text!==null&&content?.text!==undefined&&!error)ready()},[content,error]); // Text is now committed to the visible viewer.
 return <div className="report-overlay" onClick={onClose}>
  <section className="report-panel artifact-panel" role="dialog" aria-modal="true" aria-label={artifact.label||'Saved file'} onClick={event=>event.stopPropagation()}>
   <div className="report-head"><span className="report-title">{artifact.label||'Saved file'}</span><span className="report-path" title={artifact.path}>{artifact.path}</span><a className="report-obsidian" href={artifactUrl(artifact.id)} target="_blank" rel="noopener noreferrer">Open file ↗</a><button ref={close} className="report-close" onClick={onClose} aria-label="Close file preview">✕</button></div>
   <div className={'report-body artifact-body'+(content?.text!==null&&content?.text!==undefined?' artifact-text':'')}>
    {error?<p role="alert">{error}</p>:!content?<p role="status">Opening file…</p>:content.mime.startsWith('image/')?<img className="artifact-image" src={content.url!} alt={artifact.label||'Generated graphic'} onLoad={event=>event.currentTarget.naturalWidth>0?ready():fail()} onError={fail}/>:content.mime==='application/pdf'?<iframe className="artifact-pdf" src={content.url!} title={artifact.label||'Saved PDF'} referrerPolicy="no-referrer" onLoad={ready} onError={fail}/>:<ArtifactText text={content.text||''} mime={content.mime}/>}
   </div>
  </section>
 </div>;
}
