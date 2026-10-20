import { h } from '../ui.js';
import { crudPage } from './crud.js';
import { destinations, destLabel } from './dest.js';

export default async function render(el) {
  const { options, exts } = await destinations();
  const members = exts.map((e) => ({ value: e.number, label: `${e.number} ${e.display_name}` }));
  await crudPage(el, {
    endpoint: '/queues', noun: 'Warteschlange',
    intro: h('p', { class: 'muted' }, 'Anrufer warten mit Wartemusik, bis ein Mitglied frei ist. Die Mitglieder sind fest zugeordnet (kein dynamisches An-/Abmelden). Ist kein Mitglied erreichbar, geht der Ruf sofort an das Ausweichziel.'),
    columns: [{ label: 'Durchwahl', render: (r) => h('strong', {}, r.number) }, { label: 'Name', key: 'name' }, { label: 'Strategie', key: 'strategy' },
      { label: 'Mitglieder', render: (r) => r.members.join(', ') || '–' }, { label: 'Max. Wartezeit', render: (r) => `${r.max_wait} s` }, { label: 'Ausweichziel', render: (r) => destLabel(r.fallback, options) }],
    fields: [{ name: 'number', label: 'Durchwahl', required: true, readonly: true }, { name: 'name', label: 'Name', required: true },
      { name: 'strategy', label: 'Verteilung', type: 'select', options: [{ value: 'ringall', label: 'Alle freien gleichzeitig' }, { value: 'leastrecent', label: 'Wer am längsten nicht dran war' }, { value: 'fewestcalls', label: 'Wer die wenigsten Anrufe hatte' }, { value: 'rrmemory', label: 'Reihum' }, { value: 'linear', label: 'Feste Reihenfolge' }] },
      { name: 'members', label: 'Mitglieder', type: 'multi', options: members, emptyText: 'Zuerst Nebenstellen anlegen' },
      { name: 'timeout', label: 'Klingeldauer pro Mitglied (Sekunden)', type: 'number', min: 5, max: 120, default: 20 },
      { name: 'max_wait', label: 'Maximale Wartezeit (Sekunden)', type: 'number', min: 10, max: 3600, default: 300 },
      { name: 'fallback', label: 'Ausweichziel (Zeitüberschreitung / keine Mitglieder)', type: 'select', options }],
    newDefaults: { strategy: 'ringall', members: [], timeout: 20, max_wait: 300, fallback: 'hangup' },
  });
}
