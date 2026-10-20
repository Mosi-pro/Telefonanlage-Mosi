// append/prepend/replaceChildren ignorieren null/undefined/false und verschachtelte Listen
// (sonst wuerde der Browser "null" als Text einfuegen).
for (const m of ['append', 'prepend', 'replaceChildren']) {
  const orig = Element.prototype[m];
  Element.prototype[m] = function patched(...nodes) {
    return orig.apply(this, nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
  };
}

// Kleine DOM-Hilfen. Es wird ausschliesslich mit textContent / createElement gearbeitet (kein innerHTML => kein XSS).
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export function toast(msg, isErr = false) {
  let box = document.querySelector('.toast-box');
  if (!box) { box = h('div', { class: 'toast-box', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast${isErr ? ' err' : ''}` }, msg);
  box.append(t);
  setTimeout(() => t.remove(), isErr ? 8000 : 3500);
}

export function badge(text, kind = '') { return h('span', { class: `badge ${kind}` }, text); }
export function dot(kind) { return h('span', { class: `dot ${kind}` }); }

export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' }) : '–');
export const fmtDur = (s) => { s = Math.max(0, Math.round(s || 0)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };

export function table(columns, rows, { empty = 'Keine Einträge' } = {}) {
  if (!rows.length) return h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, empty));
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, columns.map((c) => h('th', {}, c.label)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, columns.map((c) => h('td', { class: c.class || '' }, c.render ? c.render(r) : r[c.key] ?? '–')))))));
}

/** Modaler Dialog. Gibt ein Promise zurueck, das mit dem Ergebnis von onSubmit (oder undefined) aufgeloest wird. */
export function dialog({ title, body, submitLabel = 'Speichern', onSubmit, hideCancel = false, danger = false, width }) {
  return new Promise((resolve) => {
    const err = h('div', { class: 'notice err', hidden: true, role: 'alert' });
    const submit = h('button', { class: danger ? 'danger' : 'primary', type: 'submit' }, submitLabel);
    const form = h('form', { method: 'dialog' },
      h('div', { class: 'dlg-head' }, title),
      h('div', { class: 'dlg-body' }, err, body),
      h('div', { class: 'dlg-foot' }, hideCancel ? null : h('button', { type: 'button', onClick: () => dlg.close() }, 'Abbrechen'), onSubmit ? submit : h('button', { type: 'button', class: 'primary', onClick: () => dlg.close() }, 'Schliessen')));
    const dlg = h('dialog', { style: width ? `width:min(${width},calc(100vw - 2rem))` : null }, form);
    let result;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!onSubmit) return dlg.close();
      submit.disabled = true; err.hidden = true;
      try { result = await onSubmit(); dlg.close(); }
      catch (ex) {
        err.hidden = false; err.textContent = ex.message || String(ex);
        if (ex.field) { const f = form.querySelector(`[name="${ex.field}"]`); if (f) f.closest('.field')?.classList.add('error'); }
        submit.disabled = false;
      }
    });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    document.body.append(dlg);
    dlg.showModal();
    form.querySelector('input:not([type=hidden]),select,textarea')?.focus();
  });
}

export const confirmDialog = (title, text, label = 'Löschen') =>
  dialog({ title, body: h('p', {}, text), submitLabel: label, danger: true, onSubmit: async () => true });

/**
 * Formularfelder. fields: [{name,label,type,options,hint,required,placeholder}]
 * Rueckgabe: { el, values() }
 */
export function buildForm(fields, values = {}) {
  const inputs = {};
  const el = h('div', {});
  for (const f of fields) {
    if (f.show && !f.show(values)) continue;
    const v = values[f.name];
    let input; let wrap;
    if (f.type === 'checkbox') {
      input = h('input', { type: 'checkbox', name: f.name, id: `f_${f.name}`, checked: v ?? f.default ?? false });
      wrap = h('div', { class: 'field check' }, h('label', { for: `f_${f.name}` }, input, f.label), f.hint ? h('div', { class: 'hint' }, f.hint) : null);
    } else if (f.type === 'select') {
      input = h('select', { name: f.name, id: `f_${f.name}` }, f.options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(v ?? f.default ?? '') }, o.label)));
      wrap = h('div', { class: 'field' }, h('label', { for: `f_${f.name}` }, f.label), input, f.hint ? h('div', { class: 'hint' }, f.hint) : null);
    } else if (f.type === 'multi') {
      const cur = new Set((v || []).map(String));
      const boxes = f.options.map((o) => h('label', {}, h('input', { type: 'checkbox', value: o.value, checked: cur.has(String(o.value)) }), o.label));
      input = { boxes };
      wrap = h('div', { class: 'field' }, h('label', {}, f.label), h('div', { class: 'checklist' }, boxes.length ? boxes : h('span', { class: 'muted' }, f.emptyText || 'Keine Auswahl vorhanden')), f.hint ? h('div', { class: 'hint' }, f.hint) : null);
    } else if (f.type === 'textarea') {
      input = h('textarea', { name: f.name, id: `f_${f.name}`, rows: 3, placeholder: f.placeholder }, v ?? '');
      wrap = h('div', { class: 'field' }, h('label', { for: `f_${f.name}` }, f.label), input, f.hint ? h('div', { class: 'hint' }, f.hint) : null);
    } else {
      input = h('input', { type: f.type || 'text', name: f.name, id: `f_${f.name}`, value: v ?? f.default ?? '', placeholder: f.placeholder, autocomplete: f.type === 'password' ? 'new-password' : 'off', min: f.min, max: f.max, disabled: f.readonly && values.id !== undefined });
      wrap = h('div', { class: 'field' }, h('label', { for: `f_${f.name}` }, f.label + (f.required ? ' *' : '')), input, f.hint ? h('div', { class: 'hint' }, f.hint) : null);
    }
    inputs[f.name] = { f, input };
    el.append(wrap);
  }
  return {
    el,
    values() {
      const out = {};
      for (const [name, { f, input }] of Object.entries(inputs)) {
        if (f.type === 'checkbox') out[name] = input.checked;
        else if (f.type === 'multi') out[name] = input.boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
        else if (f.type === 'number') out[name] = input.value === '' ? null : Number(input.value);
        else out[name] = input.value;
      }
      return out;
    },
  };
}

export function secretField(value) {
  const input = h('input', { type: 'password', readonly: true, value, 'aria-label': 'Geheimer Wert' });
  const show = h('button', { type: 'button', class: 'small', onClick: () => { input.type = input.type === 'password' ? 'text' : 'password'; show.textContent = input.type === 'password' ? 'Anzeigen' : 'Verbergen'; } }, 'Anzeigen');
  const copy = h('button', { type: 'button', class: 'small', onClick: async () => { try { await navigator.clipboard.writeText(value); toast('In die Zwischenablage kopiert'); } catch { input.type = 'text'; input.select(); toast('Kopieren nicht möglich – bitte manuell kopieren', true); } } }, 'Kopieren');
  return h('div', { class: 'secret' }, input, show, copy);
}
