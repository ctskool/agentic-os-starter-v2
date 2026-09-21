import type {App} from 'obsidian';
import {draftKey} from '../../shared/drafts';

/** Retire empty restored launchers after layout restoration. Never hide a
 * saved request, an unsaved input, a task view, or a native terminal. */
export function retireEmptyLaunchers(app:App,workView:string):void {
 try {
  const vault=(app.vault.adapter as typeof app.vault.adapter&{getBasePath?:()=>string}).getBasePath?.();
  if(typeof vault!=='string'||!vault.trim())return;
  const key=draftKey('obsidian',vault,null);
  // Unlike readDraft, a storage failure must preserve the existing view.
  if(localStorage.getItem(key)||localStorage.getItem(key+':selection')!==null)return;
  for(const leaf of [...app.workspace.getLeavesOfType(workView)]){
   try {
    const state=leaf.getViewState();
    const view=leaf.view as typeof leaf.view&{taskId?:unknown;contentEl?:HTMLElement};
    if(state.type!==workView||view.taskId||(state.state as {taskId?:unknown}|undefined)?.taskId)continue;
    const host=view.contentEl||view.containerEl;
    if(!host||Array.from(host.querySelectorAll('textarea')).some(input=>input.value))continue;
    leaf.detach();
   }catch {
    // A view that cannot be inspected safely remains available to its owner.
   }
  }
 }catch {
  // Missing local storage or vault access is not evidence of an empty draft.
 }
}
