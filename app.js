'use strict';

/* ================= Storage ================= */

const KEYS = {
  config: 'wt.config',
  session: 'wt.session',
  outbox: 'wt.outbox',
  cache: 'wt.cache'
};

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full/blocked */ }
}

const state = {
  config: load(KEYS.config, { url: '', token: '' }),
  // { id, date, startedAt, exercises: [{ name, sets: [{ id, weight, reps, done, loggedAt }] }] }
  session: load(KEYS.session, null),
  // Pending writes to the Sheet: [{ opId, type: 'exercise'|'upsert'|'delete', ... }]
  outbox: load(KEYS.outbox, []),
  // Last data from the Sheet: { exercises: [names], last: { name: [{ setNumber, weight, reps }] } }
  cache: load(KEYS.cache, { exercises: [], last: {} }),
  syncing: false,
  error: '',
  refreshAfterSync: false
};

const saveSession = () => save(KEYS.session, state.session);
const saveOutbox = () => save(KEYS.outbox, state.outbox);
const saveCache = () => save(KEYS.cache, state.cache);

/* ================= Helpers ================= */

const $ = (sel, el = document) => el.querySelector(sel);
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
const num = (v) => {
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const configured = () => Boolean(state.config.url && state.config.token);

function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ================= Totals ================= */

const setVolume = (s) => (s.done ? (s.weight || 0) * (s.reps || 0) : 0);
const exerciseVolume = (ex) => ex.sets.reduce((a, s) => a + setVolume(s), 0);
const sessionVolume = () =>
  state.session ? state.session.exercises.reduce((a, ex) => a + exerciseVolume(ex), 0) : 0;
const sessionSetCount = () =>
  state.session ? state.session.exercises.reduce((a, ex) => a + ex.sets.filter((s) => s.done).length, 0) : 0;

/** Placeholder values: same set number from last session, else its last set. */
function lastFor(name, setIndex) {
  const arr = state.cache.last[name];
  if (!arr || !arr.length) return null;
  return arr[setIndex] || arr[arr.length - 1];
}

/* ================= API + sync ================= */

async function api(payload) {
  // text/plain avoids a CORS preflight, which Apps Script can't answer
  const res = await fetch(state.config.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, token: state.config.token })
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Unexpected response — check the web app URL and that access is "Anyone"');
  }
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function queue(op) {
  op.opId = uid();
  // Only the newest write for a given set needs sending
  if (op.type === 'upsert' || op.type === 'delete') {
    const id = op.type === 'upsert' ? op.set.id : op.id;
    state.outbox = state.outbox.filter((o) =>
      !((o.type === 'upsert' && o.set.id === id) || (o.type === 'delete' && o.id === id)));
  }
  state.outbox.push(op);
  saveOutbox();
  renderStatus();
  scheduleSync();
}

let syncTimer;
function scheduleSync(delay = 800) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}

async function sync() {
  if (state.syncing) return;
  if (!state.outbox.length || !configured() || !navigator.onLine) {
    renderStatus();
    if (!state.outbox.length && state.refreshAfterSync) {
      state.refreshAfterSync = false;
      refresh();
    }
    return;
  }
  state.syncing = true;
  renderStatus();
  const batch = state.outbox.slice();
  try {
    const res = await api({ action: 'sync', ops: batch });
    const applied = new Set(res.applied);
    state.outbox = state.outbox.filter((o) => !applied.has(o.opId));
    saveOutbox();
    if (Array.isArray(res.exercises)) mergeExercises(res.exercises);
    state.error = '';
  } catch (err) {
    state.error = err.message;
    scheduleSync(15000); // retry later
  } finally {
    state.syncing = false;
    renderStatus();
  }
  if (!state.error) {
    if (state.outbox.length) scheduleSync(0);
    else if (state.refreshAfterSync) {
      state.refreshAfterSync = false;
      refresh();
    }
  }
}

function mergeExercises(fromServer) {
  const pending = state.outbox.filter((o) => o.type === 'exercise').map((o) => o.name);
  const seen = new Set();
  state.cache.exercises = [...fromServer, ...pending].filter((n) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.localeCompare(b));
  saveCache();
}

/** Pull exercise list + "last time" data from the Sheet. */
async function refresh({ quiet = true } = {}) {
  if (!configured() || !navigator.onLine) return false;
  try {
    const res = await api({ action: 'bootstrap', exclude: state.session ? state.session.id : '' });
    state.cache.last = res.last || {};
    mergeExercises(res.exercises || []);
    state.error = '';
    if (!isTyping()) render();
    else renderStatus();
    return true;
  } catch (err) {
    state.error = err.message;
    renderStatus();
    if (!quiet) throw err;
    return false;
  }
}

const isTyping = () => document.activeElement && document.activeElement.tagName === 'INPUT';

/* ================= Rendering ================= */

function renderStatus() {
  const el = $('#syncStatus');
  const pending = state.outbox.length;
  let text, cls;
  if (!configured()) { text = 'Not connected'; cls = 'err'; }
  else if (!navigator.onLine) { text = pending ? `Offline · ${pending} pending` : 'Offline'; cls = 'warn'; }
  else if (state.syncing) { text = 'Syncing…'; cls = ''; }
  else if (state.error) { text = pending ? `Sync error · ${pending}` : 'Sync error'; cls = 'err'; }
  else if (pending) { text = `${pending} pending`; cls = 'warn'; }
  else { text = 'Synced ✓'; cls = 'ok'; }
  el.textContent = text;
  el.className = 'pill ' + cls;
  el.title = state.error || 'Tap to sync now';
}

function render() {
  const main = $('#main');
  main.innerHTML = state.session ? sessionHTML() : homeHTML();
  renderStatus();
  updateTotals();
}

function homeHTML() {
  const date = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  return `
    ${configured() ? '' : `
      <div class="notice">
        Connect your Google Sheet so your workouts are saved.
        <div><button class="btn small" data-action="settings">Connect</button></div>
      </div>`}
    <section class="hero">
      <h2>Ready to lift?</h2>
      <p>${esc(date)}</p>
      <button class="btn primary" data-action="start">Start workout</button>
    </section>`;
}

function sessionHTML() {
  const s = state.session;
  return `
    <div class="summary">
      <div>
        <span class="label">Session total</span>
        <span class="big" id="sessionTotal">0 kg</span>
      </div>
      <div class="meta" id="sessionMeta"></div>
    </div>
    ${s.exercises.length ? s.exercises.map(exerciseHTML).join('')
      : '<p class="empty">Add your first exercise to get going.</p>'}
    <button class="btn wide" data-action="add-exercise">+ Add exercise</button>
    <button class="btn primary wide" data-action="finish">Finish workout</button>`;
}

function exerciseHTML(ex, ei) {
  const last = state.cache.last[ex.name];
  const lastLine = last && last.length
    ? 'Last time: ' + last.map((s) => `${fmt(s.weight)}×${s.reps}`).join(', ')
    : 'No history yet';
  return `
    <section class="card" data-ei="${ei}">
      <header>
        <h2>${esc(ex.name)}</h2>
        <button class="icon" data-action="remove-exercise" aria-label="Remove ${esc(ex.name)}">✕</button>
      </header>
      <p class="last">${esc(lastLine)}</p>
      <div class="set-head"><span>Set</span><span>kg</span><span>Reps</span><span></span></div>
      ${ex.sets.map((s, si) => setHTML(ex, s, si)).join('')}
      <footer>
        <button class="btn ghost small" data-action="add-set">+ Add set</button>
        <span class="ex-total" data-ex-total="${ei}"></span>
      </footer>
    </section>`;
}

function setHTML(ex, s, si) {
  const p = lastFor(ex.name, si);
  const val = (v) => (v === null || v === undefined ? '' : esc(v));
  return `
    <div class="set-row ${s.done ? 'done' : ''}" data-si="${si}">
      <span class="set-num">${si + 1}</span>
      <input type="text" inputmode="decimal" data-field="weight" value="${val(s.weight)}"
             placeholder="${p ? esc(p.weight) : 'kg'}" aria-label="Weight in kg">
      <input type="text" inputmode="numeric" data-field="reps" value="${val(s.reps)}"
             placeholder="${p ? esc(p.reps) : 'reps'}" aria-label="Reps">
      <button class="check" data-action="toggle-set" aria-label="${s.done ? 'Undo set' : 'Log set'}">✓</button>
    </div>`;
}

function updateTotals() {
  if (!state.session) return;
  const total = $('#sessionTotal');
  if (total) total.textContent = `${fmt(sessionVolume())} kg`;
  const meta = $('#sessionMeta');
  if (meta) {
    const n = sessionSetCount();
    meta.textContent = `${n} set${n === 1 ? '' : 's'} · ${state.session.exercises.length} exercise${state.session.exercises.length === 1 ? '' : 's'}`;
  }
  state.session.exercises.forEach((ex, ei) => {
    const el = document.querySelector(`[data-ex-total="${ei}"]`);
    if (el) el.innerHTML = `Total <strong>${fmt(exerciseVolume(ex))} kg</strong>`;
  });
}

/* ================= Session actions ================= */

function upsertOp(ex, s, si) {
  return {
    type: 'upsert',
    set: {
      id: s.id,
      sessionId: state.session.id,
      date: state.session.date,
      exercise: ex.name,
      setNumber: si + 1,
      weight: s.weight || 0,
      reps: s.reps,
      loggedAt: s.loggedAt
    }
  };
}

function startWorkout() {
  state.session = { id: uid(), date: todayISO(), startedAt: new Date().toISOString(), exercises: [] };
  saveSession();
  render();
  openExerciseDialog();
}

function addExerciseToSession(rawName) {
  const name = rawName.trim().replace(/\s+/g, ' ');
  if (!name) return;
  const existing = state.cache.exercises.find((n) => n.toLowerCase() === name.toLowerCase());
  const canonical = existing || name;

  if (state.session.exercises.some((ex) => ex.name.toLowerCase() === canonical.toLowerCase())) {
    toast(`${canonical} is already in this workout`);
    return;
  }
  if (!existing) {
    state.cache.exercises.push(canonical);
    state.cache.exercises.sort((a, b) => a.localeCompare(b));
    saveCache();
    queue({ type: 'exercise', name: canonical });
  }
  // Start with as many rows as last time, so every placeholder lines up
  const lastCount = (state.cache.last[canonical] || []).length || 1;
  state.session.exercises.push({
    name: canonical,
    sets: Array.from({ length: lastCount }, () => ({ id: uid(), weight: null, reps: null, done: false }))
  });
  saveSession();
  render();
}

function toggleSet(ei, si, rowEl) {
  const ex = state.session.exercises[ei];
  const s = ex.sets[si];

  if (s.done) {
    s.done = false;
    queue({ type: 'delete', id: s.id });
  } else {
    // Empty field = "same as last time"
    const p = lastFor(ex.name, si);
    if (s.weight === null && p) s.weight = p.weight;
    if (s.reps === null && p) s.reps = p.reps;
    if (!s.reps || s.reps <= 0 || (s.weight !== null && s.weight < 0)) {
      rowEl.classList.remove('shake');
      void rowEl.offsetWidth;
      rowEl.classList.add('shake');
      toast('Enter reps (and weight) first');
      return;
    }
    if (s.weight === null) s.weight = 0; // bodyweight
    s.done = true;
    s.loggedAt = new Date().toISOString();
    queue(upsertOp(ex, s, si));
  }
  saveSession();
  render();
}

function addSet(ei) {
  const ex = state.session.exercises[ei];
  ex.sets.push({ id: uid(), weight: null, reps: null, done: false });
  saveSession();
  render();
  const rows = document.querySelectorAll(`[data-ei="${ei}"] .set-row`);
  const input = rows[rows.length - 1] && rows[rows.length - 1].querySelector('input');
  if (input) input.focus();
}

function removeExercise(ei) {
  const ex = state.session.exercises[ei];
  const logged = ex.sets.filter((s) => s.done);
  if (!confirm(logged.length
    ? `Remove ${ex.name} and its ${logged.length} logged set${logged.length === 1 ? '' : 's'}?`
    : `Remove ${ex.name}?`)) return;
  logged.forEach((s) => queue({ type: 'delete', id: s.id }));
  state.session.exercises.splice(ei, 1);
  saveSession();
  render();
}

function finishWorkout() {
  const sets = sessionSetCount();
  const vol = sessionVolume();
  if (!sets) {
    if (!confirm('No sets logged. Discard this workout?')) return;
  } else if (!confirm(`Finish workout?\n${sets} sets · ${fmt(vol)} kg total`)) {
    return;
  }
  state.session = null;
  saveSession();
  render();
  if (sets) toast(`Workout saved — ${fmt(vol)} kg lifted 💪`, 3500);
  state.refreshAfterSync = true;
  sync();
}

/* ================= Dialogs ================= */

function openExerciseDialog() {
  const dlg = $('#exerciseDialog');
  $('#exerciseName').value = '';
  renderChips('');
  dlg.showModal();
  setTimeout(() => $('#exerciseName').focus(), 50);
}

function renderChips(query) {
  const q = query.trim().toLowerCase();
  const inSession = new Set((state.session ? state.session.exercises : []).map((e) => e.name.toLowerCase()));
  const matches = state.cache.exercises.filter((n) => !inSession.has(n.toLowerCase()) && n.toLowerCase().includes(q));
  const exact = state.cache.exercises.some((n) => n.toLowerCase() === q);
  const chips = matches.map((n) => `<button type="button" class="chip" data-name="${esc(n)}">${esc(n)}</button>`);
  if (q && !exact) {
    chips.unshift(`<button type="button" class="chip new" data-name="${esc(query.trim())}">+ Create "${esc(query.trim())}"</button>`);
  }
  $('#exerciseChips').innerHTML = chips.join('') ||
    '<span class="msg">Type a name to create your first exercise.</span>';
}

function openSettings() {
  $('#cfgUrl').value = state.config.url;
  $('#cfgToken').value = state.config.token;
  $('#settingsMsg').textContent = '';
  $('#settingsMsg').className = 'msg';
  $('#settingsDialog').showModal();
}

/* ================= Events ================= */

function locate(el) {
  const card = el.closest('[data-ei]');
  const row = el.closest('[data-si]');
  return {
    ei: card ? Number(card.dataset.ei) : -1,
    si: row ? Number(row.dataset.si) : -1,
    row
  };
}

$('#main').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { ei, si, row } = locate(btn);
  switch (btn.dataset.action) {
    case 'start': startWorkout(); break;
    case 'settings': openSettings(); break;
    case 'add-exercise': openExerciseDialog(); break;
    case 'remove-exercise': removeExercise(ei); break;
    case 'add-set': addSet(ei); break;
    case 'toggle-set': toggleSet(ei, si, row); break;
    case 'finish': finishWorkout(); break;
  }
});

$('#main').addEventListener('input', (e) => {
  const field = e.target.dataset.field;
  if (!field || !state.session) return;
  const { ei, si } = locate(e.target);
  const ex = state.session.exercises[ei];
  const s = ex.sets[si];
  s[field] = num(e.target.value);
  // Editing a logged set: keep it logged if still valid, re-sync it
  if (s.done) {
    if (s.reps && s.reps > 0) {
      if (s.weight === null) s.weight = 0;
      queue(upsertOp(ex, s, si));
    }
    updateTotals();
  }
  saveSession();
});

// Exercise dialog
$('#exerciseName').addEventListener('input', (e) => renderChips(e.target.value));
$('#exerciseChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $('#exerciseDialog').close();
  addExerciseToSession(chip.dataset.name);
});
$('#exerciseForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#exerciseName').value;
  $('#exerciseDialog').close();
  addExerciseToSession(name);
});

// Settings dialog
$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#settingsMsg');
  state.config = { url: $('#cfgUrl').value.trim(), token: $('#cfgToken').value.trim() };
  save(KEYS.config, state.config);
  msg.className = 'msg';
  msg.textContent = 'Testing connection…';
  try {
    await refresh({ quiet: false });
    msg.className = 'msg ok';
    msg.textContent = `Connected ✓ ${state.cache.exercises.length} exercises found`;
    sync();
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
  }
  render();
});

// Close buttons in dialogs
document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => b.closest('dialog').close()));

$('#syncStatus').addEventListener('click', () => {
  if (!configured()) return openSettings();
  state.error = '';
  sync();
  if (!state.outbox.length) refresh();
});

window.addEventListener('online', () => { sync(); refresh(); });
window.addEventListener('offline', renderStatus);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sync();
});

/* ================= Boot ================= */

render();
if (configured()) {
  sync();
  refresh();
} else {
  openSettings();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
