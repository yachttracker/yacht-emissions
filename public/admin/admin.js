// ── Admin-Seite: Sichtbarkeit, Share-Links, Eigentümer je Yacht ─────────────
// Der Token liegt nur in sessionStorage (endet mit dem Tab) und geht als Header
// x-admin-token an /admin/api/*. Ohne ADMIN_TOKEN auf dem Server ist alles gesperrt.

import { h, clear, icon, store } from '../js/dom.js';
import * as fmt from '../js/format.js';

const session = store('session');
const TOKEN_KEY = 'ye_admin_token';
const root = document.getElementById('admin-root');
let state = null;

async function call(method, path, body) {
  const res = await fetch(path, {
    method, cache: 'no-store',
    headers: { 'x-admin-token': session.get(TOKEN_KEY) || '', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* leer */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function signIn(message) {
  clear(root);
  const input = h('input', { type: 'password', class: 'input', id: 'token', autocomplete: 'current-password', required: true,
    'aria-describedby': 'token-help' });
  root.append(h('section', { class: 'admin-card signin' },
    h('h2', {}, 'Sign in'),
    h('p', { id: 'token-help', class: 'fine' }, 'Enter the admin token (Railway variable ADMIN_TOKEN). It is kept only for this browser tab.'),
    message ? h('p', { class: 'form-error', role: 'alert' }, message) : null,
    h('form', { class: 'row-form', onsubmit: async (e) => {
      e.preventDefault();
      session.set(TOKEN_KEY, input.value.trim());
      await load();
    } }, h('label', { for: 'token', class: 'sr-only' }, 'Admin token'), input,
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Sign in'))));
  input.focus();
}

async function load() {
  if (!session.get(TOKEN_KEY)) return signIn();
  try {
    state = await call('GET', '/admin/api/state');
    render();
  } catch (err) {
    if (err.status === 403) {
      const disabled = /ADMIN_TOKEN not set/.test(err.message);
      session.del(TOKEN_KEY);
      return signIn(disabled ? 'Admin is switched off: the server has no ADMIN_TOKEN. Set the variable on Railway first.' : 'The token was not accepted.');
    }
    if (err.status === 429) return signIn('Too many attempts. Wait 15 minutes and try again.');
    signIn(`The admin data could not be loaded: ${err.message}`);
  }
}

function flash(el, text, ok = true) {
  el.textContent = text;
  el.className = ok ? 'form-ok' : 'form-error';
}

function render() {
  clear(root);
  root.append(
    h('div', { class: 'admin-top' },
      h('p', { class: 'fine' }, `Dataset: ${state.dataset}`),
      h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { session.del(TOKEN_KEY); signIn(); } }, 'Sign out')),
    visibilityCard(), shareCard(), ownersCard());
}

// (a) globaler Schalter
function visibilityCard() {
  const msg = h('p', { 'aria-live': 'polite' });
  const sw = h('input', { type: 'checkbox', role: 'switch', id: 'vis', checked: state.owner_names_visible,
    onchange: async (e) => {
      const v = e.target.checked;
      e.target.disabled = true;
      try {
        await call('PUT', '/admin/api/settings', { owner_names_visible: v });
        state.owner_names_visible = v;
        flash(msg, v ? 'Owner names are now visible to every visitor (sourced owners only).' : 'Owner names are now hidden for every visitor.');
      } catch (err) { e.target.checked = !v; flash(msg, err.message, false); }
      e.target.disabled = false;
    } });
  return h('section', { class: 'admin-card' },
    h('h2', {}, 'Owner names'),
    h('label', { class: 'switch', for: 'vis' }, sw, h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
      h('span', {}, 'Show owner names to everyone')),
    h('p', { class: 'fine' }, 'Off: visitors see aliases such as “Owner 07”. On: names appear for owners whose record is marked sourced and has a source URL. Takes effect within seconds.'),
    msg);
}

// (b) Share-Links
function shareCard() {
  const label = h('input', { class: 'input', id: 'sk-label', placeholder: 'e.g. Prof. Baumann', maxlength: 100, required: true });
  const out = h('div', { 'aria-live': 'polite' });
  const list = h('tbody', {});
  for (const k of state.share_keys) {
    list.append(h('tr', { class: k.revoked_at ? 'is-revoked' : null },
      h('td', {}, k.label),
      h('td', {}, fmt.dateTime(k.created_at)),
      h('td', {}, k.last_used_at ? fmt.ago(k.last_used_at) : 'never'),
      h('td', {}, k.revoked_at ? `Revoked ${fmt.dateShort(k.revoked_at)}` : 'Active'),
      h('td', { class: 'num' }, k.revoked_at ? '' : h('button', { type: 'button', class: 'btn', onclick: async (e) => {
        e.target.disabled = true;
        try { await call('POST', `/admin/api/share-keys/${k.id}/revoke`); await load(); }
        catch (err) { e.target.disabled = false; flash(out, err.message, false); }
      } }, 'Revoke'))));
  }
  return h('section', { class: 'admin-card' },
    h('h2', {}, 'Shared links'),
    h('p', { class: 'fine' }, 'A shared link shows owner names even while they are hidden for everyone else. Anyone holding the link sees the names, so only send it to people you trust, and revoke it when it is no longer needed.'),
    h('form', { class: 'row-form', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const k = await call('POST', '/admin/api/share-keys', { label: label.value });
        const url = `${window.location.origin}/?key=${encodeURIComponent(k.key)}`;
        const field = h('input', { class: 'input link-out', readonly: true, value: url, 'aria-label': 'Shared link' });
        clear(out).append(h('div', { class: 'new-link' },
          h('p', {}, h('strong', {}, `Link for “${k.label}”. `), 'Copy it now – it is shown only once.'),
          h('div', { class: 'row-form' }, field,
            h('button', { type: 'button', class: 'btn', onclick: async (ev) => {
              try { await navigator.clipboard.writeText(url); ev.target.textContent = 'Copied'; }
              catch { field.select(); ev.target.textContent = 'Press Ctrl+C'; }
            } }, 'Copy link'))));
        field.select();
        label.value = '';
        const st = await call('GET', '/admin/api/state');
        state.share_keys = st.share_keys;
        const fresh = shareCard();
        fresh.querySelector('[aria-live]').replaceWith(out);
        e.target.closest('.admin-card').replaceWith(fresh);
      } catch (err) { flash(out, err.message, false); }
    } }, h('label', { for: 'sk-label', class: 'sr-only' }, 'Label'), label,
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create link')),
    out,
    state.share_keys.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'data-table admin-table' },
        h('thead', {}, h('tr', {}, ['Label', 'Created', 'Last used', 'Status', ''].map(t => h('th', { scope: 'col' }, t)))), list))
      : h('p', { class: 'fine' }, 'No shared links yet.'));
}

// (c) Eigentümer je Yacht
function ownersCard() {
  const dl = h('datalist', { id: 'owner-names' }, state.owners.map(o => h('option', { value: o.name })));
  const rows = state.vessels.map(v => ownerRow(v));
  return h('section', { class: 'admin-card' },
    h('h2', {}, 'Owner per yacht'),
    h('p', { class: 'fine' }, 'Enter the owner only with a source. Mark it sourced when the source backs the ownership; otherwise keep it unverified – unverified owners are never shown. The same name on several yachts keeps one alias.'),
    dl, h('div', { class: 'owner-rows' }, rows));
}

function ownerRow(v) {
  const o = v.owner;
  const id = `o-${v.mmsi}`;
  const name = h('input', { class: 'input', id: `${id}-name`, list: 'owner-names', value: o ? o.name : '', maxlength: 200, placeholder: 'Owner name' });
  const src = h('input', { class: 'input', id: `${id}-src`, type: 'url', value: o && o.source_url ? o.source_url : '', placeholder: 'https://…' });
  const status = h('select', { class: 'select', id: `${id}-status` },
    h('option', { value: 'unverified' }, 'Unverified'), h('option', { value: 'sourced' }, 'Sourced'));
  status.value = o ? o.status : 'unverified';
  const note = h('input', { class: 'input', id: `${id}-note`, value: o && o.note ? o.note : '', maxlength: 2000, placeholder: 'Note (optional)' });
  const msg = h('p', { 'aria-live': 'polite' });
  const save = async (e) => {
    e.preventDefault();
    try {
      const r = await call('PUT', `/admin/api/vessels/${v.mmsi}/owner`, { name: name.value, source_url: src.value || null, status: status.value, note: note.value || null });
      flash(msg, `Saved as ${r.alias} (${r.status === 'sourced' ? 'sourced' : 'unverified'}).`);
      const st = await call('GET', '/admin/api/state');
      state = st;
      const badge = document.getElementById(`${id}-badge`);
      if (badge) badge.replaceWith(aliasBadge(st.vessels.find(x => x.mmsi === v.mmsi), id));
    } catch (err) { flash(msg, err.message, false); }
  };
  const remove = async () => {
    try { await call('DELETE', `/admin/api/vessels/${v.mmsi}/owner`); name.value = ''; src.value = ''; note.value = ''; status.value = 'unverified';
      flash(msg, 'Owner removed from this yacht. The alias stays reserved.'); await load(); }
    catch (err) { flash(msg, err.message, false); }
  };
  return h('form', { class: 'owner-row', onsubmit: save, 'aria-labelledby': `${id}-title` },
    h('div', { class: 'owner-row-head' },
      h('h3', { id: `${id}-title` }, v.name), h('span', { class: 'fine' }, `MMSI ${v.mmsi}`), aliasBadge(v, id)),
    h('div', { class: 'owner-fields' },
      h('label', { class: 'field', for: `${id}-name` }, h('span', { class: 'field-label' }, 'Owner'), name),
      h('label', { class: 'field field-wide', for: `${id}-src` }, h('span', { class: 'field-label' }, 'Source URL'), src),
      h('label', { class: 'field', for: `${id}-status` }, h('span', { class: 'field-label' }, 'Status'), status),
      h('label', { class: 'field field-wide', for: `${id}-note` }, h('span', { class: 'field-label' }, 'Note'), note)),
    h('div', { class: 'owner-actions' },
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save'),
      o ? h('button', { type: 'button', class: 'btn', onclick: remove }, 'Remove owner') : null, msg));
}

function aliasBadge(v, id) {
  const o = v && v.owner;
  if (!o) return h('span', { class: 'chip chip-unverified', id: `${id}-badge` }, 'No owner');
  const shown = o.status === 'sourced' && o.source_url;
  return h('span', { class: `chip ${shown ? 'chip-sourced' : 'chip-unverified'}`, id: `${id}-badge`,
    title: shown ? 'Shown as alias, or by name when names are visible' : 'Not shown publicly (unverified or no source)' },
  icon(shown ? 'check' : 'question', { size: 12 }), `${o.alias}${shown ? '' : ' (hidden)'}`);
}

load();
