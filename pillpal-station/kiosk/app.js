// PillPal touchscreen. Polls the local station (/api/state) and redraws; buttons POST actions back.
'use strict';

const $ = (id) => document.getElementById(id);
let state = null;
let tz = undefined;
let modalSlot = null;

// ------------------------------------------------------------------ formatting
const fmtTime = (iso) => new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso));
const fmtDate = (d) => new Intl.DateTimeFormat([], { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz }).format(d);
const pills = (n) => `${n} ${n === 1 ? 'pill' : 'pills'}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function countdown(iso) {
  const mins = Math.max(0, Math.round((new Date(iso) - Date.now()) / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h >= 24) return `in ${Math.floor(h / 24)} day${h >= 48 ? 's' : ''}`;
  return m ? `in ${h} h ${m} min` : `in ${h} h`;
}

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

const STATUS_LABEL = { TAKEN: 'Taken', DISPENSED: 'In tray', SCHEDULED: 'Upcoming', MISSED: 'Missed', FAILED: 'Problem', SKIPPED: 'Skipped' };

// ------------------------------------------------------------------ rendering
function renderClock() {
  const now = new Date();
  $('clock-time').textContent = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(now);
  $('clock-date').textContent = fmtDate(now);
}

function renderHeader(s) {
  $('device-name').textContent = s.ownerName ? `${s.deviceName} · Hello, ${s.ownerName}` : s.deviceName;
  $('status').innerHTML = s.online
    ? `<span class="dot"></span>Online`
    : `<span class="dot off"></span>Offline`;

  let banner = '';
  if (!s.online && s.mode === 'ready') {
    banner = `Offline: using the schedule saved ${ago(s.lastSyncAt)}. Doses still dispense and will sync when the connection returns.`;
    if (s.pendingReports) banner += ` (${s.pendingReports} waiting to send)`;
  } else if (s.error && s.mode !== 'ready') {
    banner = s.error;
  }
  $('banner').hidden = !banner;
  $('banner').textContent = banner;
  document.body.classList.toggle('with-banner', Boolean(banner));
}

function renderNext(s) {
  const el = $('next');
  if (!s.next.length) {
    el.innerHTML = `<div class="when"><div class="label">Next dose</div></div>
      <div class="meds"><div class="empty">No upcoming doses. Add medications in the PillPal app.</div></div>`;
    return;
  }
  const at = s.next[0].scheduledAt;
  el.innerHTML = `
    <div class="when">
      <div class="label">Next dose</div>
      <div class="time">${fmtTime(at)}</div>
      <div class="countdown">${countdown(at)}</div>
    </div>
    <div class="meds">
      ${s.next.map((d) => `<div class="med">${esc(d.name)} <span>${esc(d.strength || '')} · ${pills(d.quantity)}${d.slotIndex ? ` · slot ${d.slotIndex}` : ''}</span></div>`).join('')}
    </div>`;
}

function renderToday(s) {
  const rows = s.today.slice(0, 6);
  $('today').innerHTML = rows.length
    ? rows.map((d) => `
        <li>
          <span class="t">${fmtTime(d.scheduledAt)}</span>
          <span class="n">${esc(d.name)}<small>${esc(d.strength || '')}</small></span>
          <span class="chip ${d.status}">${STATUS_LABEL[d.status] || d.status}</span>
        </li>`).join('') +
      (s.today.length > rows.length ? `<li><span></span><span class="n"><small>+ ${s.today.length - rows.length} more today</small></span><span></span></li>` : '')
    : `<li class="none">Nothing scheduled today.</li>`;
}

function renderSlots(s) {
  $('slots').innerHTML = s.slots
    .map((sl) => {
      if (!sl.name) {
        return `<button class="slot empty" data-slot="${sl.index}"><span class="num">${sl.index}</span><span class="name">Empty</span><span class="count"></span></button>`;
      }
      const pct = Math.min(100, Math.round((sl.pillCount / Math.max(1, sl.capacity)) * 100));
      return `<button class="slot ${sl.low ? 'low' : ''}" data-slot="${sl.index}">
          <span class="num">${sl.index}</span>
          <span><span class="name">${esc(sl.name)}<small>${esc(sl.strength || '')}</small></span><span class="bar" style="display:block"><i style="width:${pct}%"></i></span></span>
          <span class="count">${sl.pillCount}<small>${sl.low ? 'refill soon' : 'left'}</small></span>
        </button>`;
    })
    .join('');
}

function renderPairing(s) {
  const show = s.mode !== 'ready';
  $('pairing').hidden = !show;
  if (!show) return;
  if (s.mode === 'starting' || !s.claimCode) {
    $('pairing').innerHTML = `<div class="logo-big">PillPal</div>
      <div class="spinner" style="margin:40px 0"></div>
      <p>${esc(s.error || 'Connecting to the PillPal server…')}</p>`;
    return;
  }
  $('pairing').innerHTML = `
    <div class="logo-big">Let's set up your PillPal</div>
    <p>Open the PillPal app on your phone and go to <b>Settings → Pair a dispenser</b>,<br/>then enter this code:</p>
    <div class="code">${esc(s.claimCode)}</div>
    <div class="steps">The code refreshes automatically. This screen changes as soon as you're paired.</div>`;
}

function renderAlert(s) {
  const a = s.alert;
  const el = $('alert');
  el.hidden = !a;
  if (!a) return;
  el.className = `screen alert ${a.phase === 'done' ? 'done' : a.phase === 'error' ? 'error' : ''}`;

  const doseCards = a.doses
    .map((d) => {
      const r = d.result;
      const cls = r ? (r.ok ? 'ok' : 'bad') : '';
      const note = r
        ? r.ok
          ? r.manual ? 'Take from your bottle' : 'Dispensed ✓'
          : esc(r.error || 'Problem')
        : `${pills(d.quantity)}${d.slotIndex ? ` · slot ${d.slotIndex}` : ' · not in dispenser'}`;
      return `<div class="dose ${cls}"><b>${esc(d.name)}</b><span>${esc(d.strength || '')}</span><em>${note}</em></div>`;
    })
    .join('');
  const at = a.doses[0] ? fmtTime(a.doses[0].scheduledAt) : '';

  if (a.phase === 'due') {
    el.innerHTML = `
      <div class="kicker">${at} dose</div>
      <h1>It's time for your medicine</h1>
      <div class="doses">${doseCards}</div>
      <div class="actions">
        <button class="btn-big" data-action="dispense">Dispense</button>
        <button class="btn-ghost" data-action="skip">Skip</button>
      </div>`;
  } else if (a.phase === 'dispensing') {
    el.innerHTML = `<div class="spinner"></div><h1>Dispensing…</h1><div class="doses">${doseCards}</div><div class="hint">Please wait while your pills are released.</div>`;
  } else if (a.phase === 'confirm') {
    el.innerHTML = `
      <h1>Take your pills from the tray</h1>
      <div class="doses">${doseCards}</div>
      <div class="actions"><button class="btn-big" data-action="taken">I took them</button></div>`;
  } else if (a.phase === 'done') {
    el.innerHTML = `
      <div class="check">✓</div>
      <h1>All set!</h1>
      <div class="doses">${doseCards}</div>
      <div class="actions"><button class="btn-big" data-action="dismiss">Close</button></div>
      <div class="hint">Your pills are in the tray. Your app and caregivers have been updated.</div>`;
  } else if (a.phase === 'error') {
    el.innerHTML = `
      <h1>Something went wrong</h1>
      <div class="doses">${doseCards}</div>
      <div class="actions">
        <button class="btn-big" data-action="retry">Try again</button>
        <button class="btn-ghost" data-action="dismiss">Close</button>
      </div>
      <div class="hint">Check that the slot isn't empty or jammed. Your caregivers have been notified.</div>`;
  }
}

function renderOverlays(s) {
  const showBusy = Boolean(s.busy) && !s.alert;
  $('busy').hidden = !showBusy;
  $('busy-text').textContent = s.busy;
  $('toast').hidden = !s.toast;
  $('toast').textContent = s.toast;
}

function render() {
  if (!state) return;
  tz = state.timezone || undefined;
  renderClock();
  renderHeader(state);
  renderPairing(state);
  if (state.mode === 'ready') {
    renderNext(state);
    renderToday(state);
    renderSlots(state);
  }
  renderAlert(state);
  renderOverlays(state);
}

// ------------------------------------------------------------------ actions
async function post(path) {
  try {
    await fetch(path, { method: 'POST' });
  } catch (e) {
    console.error(e);
  }
  poll();
}

function openSlotModal(index) {
  const sl = state.slots.find((x) => x.index === index);
  modalSlot = index;
  const m = $('modal');
  if (!sl || !sl.name) {
    m.innerHTML = `<div class="modal"><h3>Slot ${index} is empty</h3><p>Load a medication into this slot from the PillPal app (Settings → Dispenser).</p><div class="row"><button class="no" data-modal="close">OK</button></div></div>`;
  } else {
    m.innerHTML = `<div class="modal"><h3>Dispense 1 ${esc(sl.name)}?</h3>
      <p>This releases one pill from slot ${index} now and records it as taken. Use this only if you need an extra or late dose.</p>
      <div class="row"><button class="yes" data-modal="yes">Dispense</button><button class="no" data-modal="close">Cancel</button></div></div>`;
  }
  m.hidden = false;
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, .modal-backdrop');
  if (!t) return;
  if (t.dataset.action) return post(`/api/due/${t.dataset.action}`);
  if (t.dataset.slot) return openSlotModal(Number(t.dataset.slot));
  if (t.dataset.modal === 'yes') {
    $('modal').hidden = true;
    return post(`/api/slots/${modalSlot}/dispense`);
  }
  if (t.dataset.modal === 'close' || t === $('modal')) $('modal').hidden = true;
});
document.addEventListener('contextmenu', (e) => e.preventDefault()); // no long-press menu on the touchscreen

// ------------------------------------------------------------------ polling
let timer = null;
async function poll() {
  clearTimeout(timer);
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    state = await res.json();
    render();
  } catch (e) {
    // the station service is restarting; keep the last screen and try again
  }
  const fast = state && (state.alert || state.busy);
  timer = setTimeout(poll, fast ? 500 : 1000);
}
setInterval(renderClock, 1000);
poll();
