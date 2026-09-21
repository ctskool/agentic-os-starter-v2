import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type ChaseCommandCenter from '../main';
import GalaxyCore from './GalaxyCore';
import StarField from './StarField';
export function ProviderBackdrop({plugin,busy,active}:{plugin:ChaseCommandCenter;busy:boolean;active:boolean}){
 const [visited,setVisited]=useState(active);
 useEffect(()=>{if(active)setVisited(true)},[active]);
 const [paused,setPaused]=useState(plugin.settings.pauseMotion);
 useEffect(()=>{const sync=()=>setPaused(plugin.settings.pauseMotion);window.addEventListener('aos-v2-settings',sync);return()=>window.removeEventListener('aos-v2-settings',sync)},[plugin]);
 if(!visited&&!active)return null;
 return <div className="v2-galaxy-backdrop" hidden={!active} data-paused={paused} aria-hidden="true"><StarField/><div className="v2-galaxy-art"><GalaxyCore variant="tight" mode={busy?'working':'idle'} paused={paused||!active}/></div></div>;
}
