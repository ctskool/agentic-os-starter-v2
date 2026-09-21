import { h } from 'preact';
import { useState } from 'preact/hooks';
import { Notice } from 'obsidian';
import type ChaseCommandCenter from '../main';
import { useProvider } from '../lib/provider';
import { useDashboard, dashboardButtons, dashboardSkillReason, launchDashboardSkill, type DashboardSkill } from '../lib/dashboard';
import { askForArg } from './IntentArgModal';
import { openWorkflowPicker } from './WorkflowModal';
import { openDashboardCustomization } from './DashboardModal';

interface Props {
 plugin: ChaseCommandCenter;
 onSubmitted?: () => void;
 appearance?: 'terminal' | 'glass';
}

/** Both cockpit themes render the same saved selection and use the same launch path. */
export function ActionBar({ plugin, onSubmitted, appearance = 'terminal' }: Props) {
 const provider = useProvider(plugin.app);
 const dashboard = useDashboard(plugin.app);
 const [busy, setBusy] = useState(false);
 const fire = async (skill: DashboardSkill) => {
  if (busy) return;
  setBusy(true);
  try {
   let input = '';
   if (skill.arg || skill.kind === 'installed') {
    const value = await askForArg(plugin.app, skill.kind === 'installed' ? `Run ${skill.label}` : skill.label,
     skill.arg === 'url' ? 'https://…' : 'What should this skill do?');
    if (!value) return;
    input = value;
   }
   await launchDashboardSkill(plugin.app, skill, input);
   onSubmitted?.();
  } catch (error) {
   new Notice(`Could not start workflow: ${error instanceof Error ? error.message : String(error)}`);
  } finally { setBusy(false); }
 };
 const buttons = dashboardButtons(dashboard);
 return <div>
  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
   <button type="button" onClick={() => openDashboardCustomization(plugin.app)} style={{ fontSize: '11px' }}>Customize dashboard</button>
   <button type="button" onClick={() => openWorkflowPicker(plugin.app)} style={{ fontSize: '11px' }}>More workflows…</button>
  </div>
  {dashboard.error && <p role="status" style={{ fontSize: '12px' }}>{dashboard.error} {dashboard.configured ? 'Showing your last saved buttons.' : 'Showing starter buttons.'}</p>}
  {!buttons.length && <p className="aos-v2-empty">Choose buttons in Customize dashboard, or use More workflows.</p>}
  <div className={appearance === 'glass' ? 'aos-v2-row aos-v2-row--keys' : 'aos-v2-cc-actionbar'}>
   {buttons.map(skill => {
    const reason = dashboardSkillReason(skill, provider.selection.provider, provider.health, dashboard.error, dashboard.installedProviders);
    return <button key={skill.id} type="button"
     className={appearance === 'glass' ? `aos-v2-key ${skill.id === 'morning-intel' ? 'aos-v2-key--primary' : ''}` : 'aos-v2-cc-action-btn'}
     disabled={busy || !!reason} title={reason || skill.description}
     aria-label={reason ? `${skill.label}: ${reason}` : skill.label}
     onClick={() => void fire(skill)}>
     {skill.label}
     {reason && <small style={{ display: 'block', fontSize: '10px', lineHeight: '1.3', marginTop: '4px' }}>{reason}</small>}
    </button>;
   })}
  </div>
 </div>;
}
