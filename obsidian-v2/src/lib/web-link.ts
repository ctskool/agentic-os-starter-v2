import {Notice} from 'obsidian';
import {safeWebLink} from '../../shared/web-link.mjs';
export function openWebLink(value:string,hostname?:string){
 const url=safeWebLink(value,hostname);
 if(!url){new Notice('This report contains an invalid web link. Open the source report to inspect it.');return}
 window.open(url,'_blank','noopener,noreferrer');
}
