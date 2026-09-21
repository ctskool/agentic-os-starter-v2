import { App, Modal, Notice } from 'obsidian';
import { readSelection, type Provider } from '../lib/provider';
import { readDashboard, dashboardSkillReason, launchDashboardSkill, type DashboardSkill } from '../lib/dashboard';
import { askForArg } from './IntentArgModal';

export function openWorkflowPicker(app: App) { new WorkflowModal(app).open(); }
class WorkflowModal extends Modal {
 private choosing = false;
 private closed = false;
 onOpen() {
  this.contentEl.addClass('aos-v2-cc-modal');
  this.contentEl.createEl('h2', { text: 'Run a workflow' });
  const search = this.contentEl.createEl('input');
  search.type = 'search'; search.placeholder = 'Find a workflow';
  search.setAttribute('aria-label', 'Find a workflow'); search.style.width = '100%';
  const message = this.contentEl.createEl('p', { text: 'Loading workflows…' }); message.setAttribute('role', 'status');
  const list = this.contentEl.createDiv();
  Object.assign(list.style, { display: 'grid', gap: '6px', maxHeight: '50vh', overflowY: 'auto', marginTop: '12px' });
  let catalog: DashboardSkill[] = [], provider: Provider = 'codex', error = '', installedProviders: Provider[] | undefined;
  const show = () => {
   if (this.closed) return;
   list.empty();
   const entries = catalog.filter(skill => `${skill.id} ${skill.label} ${skill.description}`.toLowerCase().includes(search.value.toLowerCase()));
   for (const skill of entries) {
    const reason = dashboardSkillReason(skill, provider, undefined, error, installedProviders);
    const button = list.createEl('button', { text: skill.label + (skill.direct ? ' · Refresh' : '') });
    button.type = 'button'; button.disabled = !!reason;
    button.title = reason || skill.description;
    button.onclick = () => void this.choose(skill);
    if (reason) list.createEl('small', { text: reason });
   }
   if (!entries.length) list.createEl('p', { text: 'No matching workflow.' });
  };
  void Promise.all([readDashboard(this.app), readSelection(this.app)]).then(([value, selection]) => {
   if (this.closed) return;
   catalog = value.catalog; provider = selection.provider; error = value.error; installedProviders = value.installedProviders;
   message.textContent = error || 'Stock workflows run in the background. Your installed skills open an agent terminal.';
   show();
  }).catch(error => { if (!this.closed) message.textContent = error instanceof Error ? error.message : String(error); });
  search.addEventListener('input', show); search.focus();
 }
 private async choose(skill: DashboardSkill) {
  if (this.choosing) return;
  this.choosing = true; this.close();
  try {
   let input = '';
   if (skill.arg || skill.kind === 'installed') {
    const value = await askForArg(this.app, skill.label, skill.arg === 'url' ? 'https://…' : 'What should this skill do?');
    if (!value) return;
    input = value;
   }
   await launchDashboardSkill(this.app, skill, input);
  } catch (error) { new Notice(`Could not start workflow: ${error instanceof Error ? error.message : String(error)}`); }
 }
 onClose() { this.closed = true; this.contentEl.empty(); }
}
