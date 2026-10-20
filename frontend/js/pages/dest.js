// Auswahl von Anrufzielen (Nebenstelle, Gruppe, Warteschlange, Menue, Voicemail, Auflegen)
import { get } from '../api.js';

export async function destinations({ withHangup = true } = {}) {
  const [exts, groups, queues, ivrs] = await Promise.all([get('/extensions'), get('/ring-groups').catch(() => []), get('/queues').catch(() => []), get('/ivrs').catch(() => [])]);
  const o = [];
  if (withHangup) o.push({ value: 'hangup', label: 'Auflegen' });
  exts.forEach((e) => o.push({ value: e.number, label: `Nebenstelle ${e.number} – ${e.display_name}` }));
  exts.filter((e) => e.voicemail_enabled).forEach((e) => o.push({ value: `vm:${e.number}`, label: `Voicemail von ${e.number}` }));
  groups.forEach((g) => o.push({ value: g.number, label: `Rufgruppe ${g.number} – ${g.name}` }));
  queues.forEach((q) => o.push({ value: q.number, label: `Warteschlange ${q.number} – ${q.name}` }));
  ivrs.forEach((i) => o.push({ value: i.number, label: `Telefonmenü ${i.number} – ${i.name}` }));
  return { options: o, exts };
}
export const destLabel = (value, options) => options.find((o) => o.value === value)?.label || value || '–';
