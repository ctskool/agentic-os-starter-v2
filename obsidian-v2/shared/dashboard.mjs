// One saved order is shared by both dashboards. Null retains each surface's
// existing defaults; an empty array deliberately hides every quick button.
export const MAX_DASHBOARD_SKILLS = 10;
export const DEFAULT_COCKPIT_SKILLS = Object.freeze(['plan-today','inbox-brief','morning-intel','metrics-pull','weekly-review','deep-research-chase','yt-pipeline','angle-brainstorm','outline-build','content-cascade']);
export const DEFAULT_HUD_SKILLS = Object.freeze(['plan-today','inbox-brief','deep-research-chase','content-cascade']);
export const isInstalledSkill = id => typeof id === 'string' && /^installed:[a-f0-9]{24}$/.test(id);

export function validateDashboardSelection(selected, knownIds) {
  if (selected === null) return null;
  if (!Array.isArray(selected) || selected.length > MAX_DASHBOARD_SKILLS || selected.some(id => typeof id !== 'string' || !id || id.length > 100) || new Set(selected).size !== selected.length) throw new Error(`Choose up to ${MAX_DASHBOARD_SKILLS} different dashboard skills.`);
  if (knownIds) {
    const known = new Set(knownIds);
    if (selected.some(id => !known.has(id))) throw new Error('A selected dashboard skill is not registered. Refresh the list and try again.');
  }
  return [...selected];
}

export function dashboardSelected(selected, surface = 'cockpit') {
  return selected == null ? [...(surface === 'hud' ? DEFAULT_HUD_SKILLS : DEFAULT_COCKPIT_SKILLS)] : validateDashboardSelection(selected);
}
