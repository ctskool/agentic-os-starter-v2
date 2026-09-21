// Browser-only harness for native Preact components. Never bundled into plugin.
import {authorizedBridgeFetch} from '../shared/bridge-auth';
import {previewAuthorization} from './auth';
export class Notice {constructor(text:string){window.dispatchEvent(new CustomEvent('preview-notice',{detail:text}))}}
function decorate(el:any):any {el.empty=()=>el.replaceChildren();el.addClass=(c:string)=>el.classList.add(c);el.createEl=(tag:string,opts:any={})=>{const child=decorate(document.createElement(tag));child.textContent=opts.text||'';if(opts.cls)child.className=opts.cls;el.append(child);return child};el.createDiv=(opts:any={})=>el.createEl('div',opts);return el}
export class Modal {dialog=document.createElement('dialog');contentEl=decorate(document.createElement('div'));constructor(public app:any){this.dialog.append(this.contentEl);this.dialog.addEventListener('cancel',e=>{e.preventDefault();this.close()})}onOpen(){}onClose(){}open(){document.body.append(this.dialog);this.onOpen();this.dialog.showModal()}close(){this.onClose();this.dialog.close();this.dialog.remove()}}
export class Menu {addItem(fn:any){const item:any={setTitle:()=>item,setIcon:()=>item,onClick:()=>item};fn(item);return this}showAtMouseEvent(){}}
export class Setting {settingEl:HTMLElement;constructor(el:any){this.settingEl=document.createElement('div');el.append(this.settingEl)}addText(fn:any){const inputEl=document.createElement('input');this.settingEl.append(inputEl);const text:any={inputEl,setPlaceholder:(v:string)=>{inputEl.placeholder=v;return text},setValue:(v:string)=>{inputEl.value=v;return text}};fn(text);return this}}
export class PluginSettingTab {}
export class TFile {constructor(public path:string){} }
export const setIcon=(el:HTMLElement,icon:string)=>{el.textContent=icon==='plus'?'+':'↗'};
export const requestUrl=async(options:any)=>{if(!options.url.startsWith('http://127.0.0.1:3219/'))throw new Error('Only the local V2 bridge is available');const r=await authorizedBridgeFetch(options.url,{method:options.method,headers:options.headers,body:options.body},previewAuthorization);const headers=Object.fromEntries(r.headers.entries());const arrayBuffer=await r.arrayBuffer();return {status:r.status,headers,arrayBuffer,get json(){return JSON.parse(new TextDecoder().decode(arrayBuffer))}}};
export const MarkdownRenderer={render:async(_app:any,md:string,el:HTMLElement)=>{el.textContent=md}};
