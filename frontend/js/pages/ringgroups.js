import { h } from '../ui.js';
import { crudPage } from './crud.js';
import { destinations, destLabel } from './dest.js';

export default async function render(el) {
  const { options, exts } = await destinations();
  const members = exts.map((e) => ({ value: e.number, label: `${e.number} ${e.display_name}` }));
  await crudPage(el, {
    endpoint: '/ring-groups', noun: 'Rufgruppe',
    intro: h('p', { class: 'muted' }, 'Eine Rufgruppe hat eine eigene Durchwahl. „Alle gleichzeitig“ lässt alle Mitglieder klingeln, „Der Reihe nach“ ruft nacheinander an. Individuelle Umleitungen der Mitglieder gelten innerhalb der Gruppe nicht.'),
    columns: [{ label: 'Durchwahl', render: (r) => h('strong', {}, r.number) }, { label: 'Name', key: 'name' }, { label: 'Strategie', render: (r) => (r.strategy === 'ringall' ? 'alle gleichzeitig' : 'der Reihe nach') },
      { label: 'Mitglieder', render: (r) => r.members.join(', ') || '–' }, { label: 'Klingeldauer', render: (r) => `${r.timeout} s` }, { label: 'Wenn niemand annimmt', render: (r) => destLabel(r.fallback, options) }],
    fields: [{ name: 'number', label: 'Durchwahl', required: true, readonly: true }, { name: 'name', label: 'Name', required: true },
      { name: 'strategy', label: 'Strategie', type: 'select', options: [{ value: 'ringall', label: 'Alle gleichzeitig' }, { value: 'hunt', label: 'Der Reihe nach' }] },
      { name: 'members', label: 'Mitglieder', type: 'multi', options: members, emptyText: 'Zuerst Nebenstellen anlegen' },
      { name: 'timeout', label: 'Klingeldauer pro Durchlauf (Sekunden)', type: 'number', min: 5, max: 120, default: 25 },
      { name: 'fallback', label: 'Wenn niemand annimmt', type: 'select', options }],
    newDefaults: { strategy: 'ringall', members: [], timeout: 25, fallback: 'hangup' },
  });
}
