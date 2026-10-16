export function installedCount(effects, inventory, group = 'all') {
  if (!inventory) return null;
  const ids = new Set(inventory.entries.filter(e => e.installed).map(e => e.id));
  return effects.filter(e => (group === 'all' || String(e.id >>> 24) === String(group)) && ids.has(e.id)).length;
}
export function unavailableEffects(patch, inventory) {
  if (!inventory) return [];
  const ids = new Set(inventory.entries.filter(e => e.installed).map(e => e.id));
  return [...new Set(patch.effectSettings.filter(s => s.id && !ids.has(s.id)).map(s => s.id))];
}
