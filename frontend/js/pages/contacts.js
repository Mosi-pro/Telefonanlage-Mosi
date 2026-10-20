import { crudPage } from './crud.js';
import { h } from '../ui.js';
import { state } from '../api.js';
export default (el) => crudPage(el, {
  endpoint: '/contacts', noun: 'Kontakt', canWrite: state.user.role !== 'user',
  intro: h('p', { class: 'muted' }, 'Gemeinsames Telefonbuch. Eine Kurzwahl (z. B. *01) kann an jedem angeschlossenen Telefon gewählt werden und ruft die hinterlegte Nummer an.'),
  columns: [{ label: 'Name', key: 'name' }, { label: 'Firma', key: 'company' }, { label: 'Nummer', render: (r) => h('span', { class: 'mono' }, r.number) }, { label: 'Kurzwahl', render: (r) => r.short_code || '–' }, { label: 'E-Mail', key: 'email' }],
  fields: [
    { name: 'name', label: 'Name', required: true }, { name: 'company', label: 'Firma' },
    { name: 'number', label: 'Rufnummer', required: true, hint: 'Interne Durchwahl oder externe Nummer, z. B. 101 oder 0301234567 / +49301234567' },
    { name: 'short_code', label: 'Kurzwahl', placeholder: '*01', hint: 'Optional: Stern plus 2–3 Ziffern. Reserviert sind *43, *97, *98.' },
    { name: 'email', label: 'E-Mail', type: 'email' }],
});
