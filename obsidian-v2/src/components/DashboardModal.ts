import { App, Modal, Notice } from 'obsidian';
import { DEFAULT_COCKPIT_SKILLS, MAX_DASHBOARD_SKILLS } from '../../shared/dashboard.mjs';
import { readSelection, type Provider } from '../lib/provider';
import {
 readDashboard, saveDashboard, discoverDashboardSkills, registerDashboardSkill,
 dashboardSkillReason, type DashboardSnapshot, type DashboardSkill, type DiscoveredSkill,
} from '../lib/dashboard';

export function openDashboardCustomization(app: App) { new DashboardModal(app).open(); }

class DashboardModal extends Modal {
 private value: DashboardSnapshot | null = null;
 private draft: string[] | null = null;
 private provider: Provider = 'codex';
 private busy = false;
 private closed = false;
 private search = '';
 private message = '';
 private discovered: DiscoveredSkill[] | null = null;
 private path = '';
 private label = '';
 private registerProviders: Provider[] = [];

 onOpen() {
  this.contentEl.addClass('aos-v2-cc-modal');
  this.render();
  void this.reload();
 }
 onClose() { this.closed = true; this.contentEl.empty(); }
 private ids() { return [...(this.draft ?? DEFAULT_COCKPIT_SKILLS)]; }
 private button(parent: HTMLElement, text: string, action: () => void, disabled = false) {
  const button = parent.createEl('button', { text });
  button.type = 'button'; button.disabled = disabled || this.busy;
  button.onclick = action;
  return button;
 }
 private async reload() {
  this.busy = true; this.render();
  try {
   const [value, selection] = await Promise.all([readDashboard(this.app), readSelection(this.app)]);
   if (this.closed) return;
   this.value = value;
   this.provider = selection.provider;
   if (!this.registerProviders.length) this.registerProviders = [selection.provider];
   this.draft = value.selected === null ? null : [...value.selected];
   this.message = value.error;
  } catch (error) { this.message = String(error instanceof Error ? error.message : error); }
  finally { this.busy = false; this.render(); }
 }
 private mutate(ids: string[], focusLabel?: string) {
  this.draft = ids;
  this.render();
  const target = focusLabel && Array.from(this.contentEl.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === focusLabel && !button.disabled);
  if (target) target.focus();
  else this.contentEl.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
 }
 private async save() {
  if (!this.value || this.busy || !this.value.ready || this.value.error) return;
  this.busy = true; this.message = ''; this.render();
  try {
   await saveDashboard(this.app, this.value.revision, this.draft);
   new Notice('Dashboard updated in Obsidian and Jarvis.');
   this.close();
  } catch (error) {
   this.message = `${error instanceof Error ? error.message : String(error)} Your unsaved selection is still here. Reload saved selection to start from the latest settings.`;
  } finally { this.busy = false; this.render(); }
 }
 private async discover() {
  this.busy = true; this.message = ''; this.render();
  try {
   const result = await discoverDashboardSkills(this.app, this.provider);
   this.discovered = result.skills;
   this.message = [
    ...(result.warnings || []),
    result.skills.length ? `Found ${result.skills.length} installed skills.` : `No installed ${this.provider === 'claude' ? 'Claude Code' : 'Codex'} skills were found. You can add a SKILL.md path below.`,
    result.skipped ? `${result.skipped} folders or skill files were skipped because they could not be safely read.` : '',
    result.truncated ? 'This search reached its limit. Add a missing skill by its SKILL.md path below.' : '',
   ].filter(Boolean).join('\n');
  } catch (error) { this.message = error instanceof Error ? error.message : String(error); }
  finally { this.busy = false; this.render(); }
 }
 private async register(path: string, providers: Provider[], label?: string) {
  if (!this.value || this.busy || !path.trim() || !providers.length) return;
  this.busy = true; this.message = ''; this.render();
  try {
   const value = await registerDashboardSkill(this.app, this.value.revision, path.trim(), providers, label);
   const added = value.registeredId;
   this.value = value;
   if (added && !this.ids().includes(added) && this.ids().length < MAX_DASHBOARD_SKILLS) this.draft = [...this.ids(), added];
   this.message = added && this.ids().includes(added)
    ? 'Skill registered. Save your dashboard to show its button.'
    : 'Skill registered in your library. Remove a button before adding it to your dashboard.';
   this.path = ''; this.label = '';
  } catch (error) { this.message = error instanceof Error ? error.message : String(error); }
  finally { this.busy = false; this.render(); }
 }

 private render() {
  if (this.closed) return;
  const root = this.contentEl;
  root.empty();
  root.createEl('h2', { text: 'Customize dashboard' });
  root.createEl('p', { text: `Choose up to ${MAX_DASHBOARD_SKILLS} buttons and arrange them in the order you use them. Your saved selection appears in both Obsidian and Jarvis.` });
  if (this.message) {
   const message = root.createEl('p', { text: this.message });
   message.setAttribute('role', 'status'); message.style.whiteSpace = 'pre-wrap';
  }
  if (!this.value) {
   root.createEl('p', { text: this.busy ? 'Loading dashboard settings…' : 'Dashboard settings are unavailable.' });
   this.button(root, 'Try again', () => void this.reload());
   return;
  }
  const editable = this.value.ready && !this.value.error;
  const ids = this.ids();
  const controls = root.createDiv();
  Object.assign(controls.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });
  this.button(controls, 'Use defaults', () => { this.draft = null; this.render(); }, !editable);
  this.button(controls, 'Clear buttons', () => this.mutate([]), !editable);
  this.button(controls, 'Reload saved selection', () => void this.reload());
  root.createEl('h3', { text: `Selected buttons (${ids.length}/${MAX_DASHBOARD_SKILLS})` });
  if (this.draft === null) root.createEl('p', { text: 'Using defaults: Obsidian keeps its starter buttons and Jarvis keeps its compact starter row.' });
  const selected = root.createEl('ol'); selected.setAttribute('aria-label', 'Selected dashboard buttons');
  for (const [index, id] of ids.entries()) {
   const skill = this.value.catalog.find(item => item.id === id);
   const label = skill?.label || id;
   const row = selected.createEl('li');
   Object.assign(row.style, { marginBottom: '8px' });
   row.createEl('span', { text: label + ' ' });
   const up = this.button(row, '↑', () => {
    const next = [...ids]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
    this.mutate(next, `Move ${label} ${index === 1 ? 'down' : 'up'}`);
   }, !editable || index === 0);
   up.setAttribute('aria-label', `Move ${label} up`); up.title = `Move ${label} up`;
   const down = this.button(row, '↓', () => {
    const next = [...ids]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
    this.mutate(next, `Move ${label} ${index === ids.length - 2 ? 'up' : 'down'}`);
   }, !editable || index === ids.length - 1);
   down.setAttribute('aria-label', `Move ${label} down`); down.title = `Move ${label} down`;
   const remove = this.button(row, 'Remove', () => this.mutate(ids.filter(item => item !== id)), !editable);
   remove.setAttribute('aria-label', `Remove ${label}`);
   const reason = skill ? dashboardSkillReason(skill, this.provider, undefined, '', this.value.installedProviders) : 'This skill is no longer registered.';
   if (reason) row.createEl('small', { text: ` ${reason}` });
  }
  if (!ids.length) root.createEl('p', { text: 'No quick buttons selected. More workflows will still be available.' });
  root.createEl('h3', { text: 'Available workflows' });
  const search = root.createEl('input');
  search.type = 'search'; search.value = this.search; search.placeholder = 'Find a skill or workflow';
  search.setAttribute('aria-label', 'Find a skill or workflow'); search.style.width = '100%';
  const catalog = root.createDiv();
  Object.assign(catalog.style, { display: 'grid', gap: '8px', maxHeight: '220px', overflowY: 'auto', marginTop: '8px' });
  const show = () => {
   catalog.empty();
   const entries = this.value!.catalog.filter(skill => !ids.includes(skill.id) && `${skill.label} ${skill.description} ${skill.id}`.toLowerCase().includes(this.search.toLowerCase()));
   for (const skill of entries) this.catalogRow(catalog, skill, ids, editable);
   if (!entries.length) catalog.createEl('p', { text: 'No matching unselected workflows.' });
  };
  search.oninput = () => { this.search = search.value; show(); }; show();

  root.createEl('h3', { text: 'Your installed skills' });
  root.createEl('p', { text: 'Use skills already installed for Claude Code or Codex. Registered skills stay in your library even if you cancel this dashboard selection.' });
  this.button(root, `Find ${this.provider === 'claude' ? 'Claude Code' : 'Codex'} skills`, () => void this.discover(), !editable);
  if (this.discovered?.length) {
   const list = root.createDiv(); Object.assign(list.style, { maxHeight: '200px', overflowY: 'auto' });
   for (const skill of this.discovered) {
    const row = list.createDiv(); row.style.marginTop = '8px';
    this.button(row, `Register ${skill.label}`, () => void this.register(skill.path, skill.providers, skill.label), !editable);
    row.createEl('small', { text: ` ${skill.description || skill.path}` });
   }
  }
  const details = root.createEl('details');
  details.createEl('summary', { text: 'Add a skill by its SKILL.md path' });
  const path = details.createEl('input'); path.type = 'text'; path.value = this.path;
  path.placeholder = 'Full path to SKILL.md'; path.setAttribute('aria-label', 'Full path to SKILL.md'); path.style.width = '100%';
  path.oninput = () => { this.path = path.value; };
  const label = details.createEl('input'); label.type = 'text'; label.value = this.label;
  label.placeholder = 'Button label (optional)'; label.setAttribute('aria-label', 'Button label (optional)'); label.style.width = '100%';
  label.oninput = () => { this.label = label.value; };
  details.createEl('p', { text: 'Which tools can use this installed skill?' });
  for (const provider of ['claude', 'codex'] as const) {
   const wrapper = details.createEl('label'); wrapper.style.marginRight = '12px';
   const checkbox = wrapper.createEl('input'); checkbox.type = 'checkbox'; checkbox.checked = this.registerProviders.includes(provider);
   wrapper.appendText(provider === 'claude' ? ' Claude Code' : ' Codex');
   checkbox.onchange = () => { this.registerProviders = checkbox.checked ? [...this.registerProviders, provider] : this.registerProviders.filter(item => item !== provider); };
  }
  this.button(details, 'Register skill', () => {
   if (!this.path.trim() || !this.registerProviders.length) { new Notice('Enter a SKILL.md path and select its coding tool.'); return; }
   void this.register(this.path, this.registerProviders, this.label);
  }, !editable);
  const footer = root.createDiv({ cls: 'aos-v2-cc-modal-buttons' });
  this.button(footer, 'Save dashboard', () => void this.save(), !editable).addClass('mod-cta');
  this.button(footer, 'Cancel', () => this.close());
 }

 private catalogRow(parent: HTMLElement, skill: DashboardSkill, ids: string[], editable: boolean) {
  const row = parent.createDiv();
  const button = this.button(row, `Add ${skill.label}`, () => this.mutate([...ids, skill.id], `Remove ${skill.label}`), !editable || ids.length >= MAX_DASHBOARD_SKILLS);
  button.setAttribute('aria-label', `Add ${skill.label} to dashboard`);
  row.createEl('small', { text: ` ${skill.description}` });
  const reason = dashboardSkillReason(skill, this.provider, undefined, '', this.value?.installedProviders);
  if (reason) row.createEl('div', { text: reason });
 }
}
