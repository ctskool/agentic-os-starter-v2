import { App, PluginSettingTab, Setting } from 'obsidian';
import type ChaseCommandCenter from './main';
export type CockpitTheme = 'terminal' | 'glass';
export interface ChaseSettings { vaultSystemPath:string; claudeTokenBudget5h:number; metricsPullCadenceHours:number; dismissedRunIds:string[]; orbEnabled:boolean; orbBloom:boolean; orbRight:number; orbBottom:number; jarvisHudUrl:string; jarvisEventsUrl:string; theme:CockpitTheme; reduceBlur:boolean; pauseMotion:boolean }
export const DEFAULT_SETTINGS:ChaseSettings={vaultSystemPath:'system/v2',claudeTokenBudget5h:2000000,metricsPullCadenceHours:6,dismissedRunIds:[],orbEnabled:true,orbBloom:false,orbRight:28,orbBottom:48,jarvisHudUrl:'',jarvisEventsUrl:'',theme:'terminal',reduceBlur:false,pauseMotion:false};
export class ChaseSettingTab extends PluginSettingTab {
 constructor(app:App,public plugin:ChaseCommandCenter){super(app,plugin)}
 display(){const el=this.containerEl;el.empty();
 el.createEl('p',{text:'V2 works in this vault with shared agent tasks and local voice capture and playback. Quick voice requests use Haiku or Luna; complex work opens the selected CLI. Transcripts go to the selected provider. Google access uses the connectors available to that CLI.'});
 new Setting(el).setName('Show floating agent orb').setDesc('Displays the selected provider and task state. Click to talk, click again to send. Open the voice controls for text input and the dashboard.').addToggle(t=>t.setValue(this.plugin.settings.orbEnabled).onChange(async v=>{this.plugin.settings.orbEnabled=v;await this.plugin.saveSettings();this.plugin.remountOrb()}));
 new Setting(el).setName('Pause motion').setDesc('Stops galaxy motion, meter effects, and decorative dashboard animations.').addToggle(t=>t.setValue(this.plugin.settings.pauseMotion).onChange(async v=>{this.plugin.settings.pauseMotion=v;await this.plugin.saveSettings();this.plugin.applyTheme();window.dispatchEvent(new Event('aos-v2-settings'));}));
 new Setting(el).setName('Reduce blur').setDesc('Uses solid glass panels to reduce graphics work while keeping the dashboard readable.').addToggle(t=>t.setValue(this.plugin.settings.reduceBlur).onChange(async v=>{this.plugin.settings.reduceBlur=v;await this.plugin.saveSettings();this.plugin.applyTheme();window.dispatchEvent(new Event('aos-v2-settings'));}));
 new Setting(el).setName('Cockpit theme').addDropdown(d=>d.addOption('terminal','Terminal').addOption('glass','Glass').setValue(this.plugin.settings.theme).onChange(async v=>{this.plugin.settings.theme=v==='glass'?'glass':'terminal';await this.plugin.saveSettings();this.plugin.applyTheme();window.dispatchEvent(new Event('aos-v2-cc-theme'))}));
 }
}
