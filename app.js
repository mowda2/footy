import { SUPABASE_URL, SUPABASE_KEY, TIMEZONE, DEFAULT_GAME } from './config.js';

/* ------------------------------------------------------------------ basics */

const $app = document.getElementById('app');
// Works at the domain root or in a subfolder (GitHub Pages serves this at /footy/).
const BASE = location.pathname.replace(/[^/]*$/, '');
const $toast = document.getElementById('toast');

const memory = {};
const store = {
  get(k) { try { return localStorage.getItem('footy.' + k); } catch { return memory[k] ?? null; } },
  set(k, v) {
    memory[k] = v;
    try { v == null ? localStorage.removeItem('footy.' + k) : localStorage.setItem('footy.' + k, v); } catch { /* private mode */ }
  },
};

function randHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function deviceToken() {
  let t = store.get('token');
  if (!t) { t = randHex(24); store.set('token', t); }
  return t;
}

async function rpc(fn, args = {}) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    throw new Error("Can't reach the server. Check your connection and try again.");
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error((data && data.message) || `Something went wrong (${res.status})`);
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameKey = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------- dates */

const fmt = (o) => new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, ...o });
const F = {
  dow: fmt({ weekday: 'long' }),
  dowShort: fmt({ weekday: 'short' }),
  monthDay: fmt({ month: 'short', day: 'numeric' }),
  monthLong: fmt({ month: 'long' }),
  day: fmt({ day: 'numeric' }),
  mon: fmt({ month: 'short' }),
  time: fmt({ hour: 'numeric', minute: '2-digit' }),
  parts: fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
};

function partsOf(date) {
  const o = {};
  for (const p of F.parts.formatToParts(date)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}
const dayKey = (d) => { const p = partsOf(d); return p.year * 10000 + p.month * 100 + p.day; };
const clock = (iso) => F.time.format(new Date(iso)).replace(/\s+/g, '').toLowerCase();

function timeRange(a, b) {
  const x = clock(a), y = clock(b);
  return (x.slice(-2) === y.slice(-2) ? x.slice(0, -2) : x) + '–' + y;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function dayWord(iso) {
  const d = new Date(iso), today = dayKey(new Date());
  const k = dayKey(d);
  const tomorrow = dayKey(new Date(Date.now() + 864e5));
  if (k === today) return 'Tonight';
  if (k === tomorrow) return 'Tomorrow';
  return F.dow.format(d);
}

function shortWhen(iso) {
  const d = new Date(iso), k = dayKey(d);
  if (k === dayKey(new Date())) return `today at ${clock(iso)}`;
  if (k === dayKey(new Date(Date.now() + 864e5))) return `tomorrow at ${clock(iso)}`;
  return `${F.dowShort.format(d)}, ${F.monthDay.format(d)} at ${clock(iso)}`;
}

function tzOffsetMs(date) {
  const p = partsOf(date);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

// "2026-10-04" + "20:45" in TIMEZONE -> ISO string
function zonedISO(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess - tzOffsetMs(new Date(guess));
  const second = guess - tzOffsetMs(new Date(utc));
  if (second !== utc) utc = second;
  return new Date(utc).toISOString();
}

function zonedInputs(iso) {
  const p = partsOf(new Date(iso));
  const pad = (n) => String(n).padStart(2, '0');
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour % 24)}:${pad(p.minute)}` };
}

/* ------------------------------------------------------------------- state */

const S = {
  status: null,
  pin: store.get('pin'),
  isOrg: false,
  matches: null,
  data: null,       // footy_get_match result
  dataJSON: '',
  tb: null,         // team builder state
  ui: {},
  busy: false,
};

const TEAM_META = [
  { name: 'Bibs', color: '#FF8A2A' },
  { name: 'Shirts', color: '#F3F6EF' },
  { name: 'Yellow', color: '#FFD43B' },
  { name: 'Blue', color: '#5FB4FF' },
  { name: 'Pink', color: '#FF7EB6' },
  { name: 'Purple', color: '#B79CFF' },
];

/* ------------------------------------------------------------------ router */

function route() {
  const q = new URLSearchParams(location.search);
  if (q.get('m')) return { name: 'match', slug: q.get('m') };
  if (q.get('edit')) return { name: 'form', slug: q.get('edit') };
  if (q.has('new')) return { name: 'form', from: q.get('from') };
  if (q.get('teams')) return { name: 'teams', slug: q.get('teams') };
  if (q.has('organizer')) return { name: 'organizer', next: q.get('next') };
  return { name: 'home' };
}

function navigate(url, replace = false) {
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
  S.ui = {};
  window.scrollTo(0, 0);
  load();
}

window.addEventListener('popstate', () => { S.ui = {}; load(); });

/* ------------------------------------------------------------------- toast */

let toastTimer;
function toast(msg, kind = 'ok') {
  $toast.textContent = msg;
  $toast.dataset.kind = kind;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), kind === 'error' ? 5200 : 3400);
}

/* -------------------------------------------------------------- rendering */

function paint(html) {
  // Keep whatever someone was typing when the page refreshes underneath them.
  const saved = {};
  const active = document.activeElement;
  $app.querySelectorAll('input[id], textarea[id], select[id]').forEach((el) => {
    saved[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  const focusId = active && $app.contains(active) ? active.id : null;
  const sel = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

  $app.innerHTML = html;

  for (const [id, v] of Object.entries(saved)) {
    const el = document.getElementById(id);
    if (!el || el.dataset.fresh !== undefined) continue;
    if (el.type === 'checkbox') el.checked = v; else el.value = v;
  }
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) { el.focus({ preventScroll: true }); if (sel) try { el.setSelectionRange(...sel); } catch { /* not a text field */ } }
  }
}

function topBar(back) {
  const org = S.isOrg
    ? `<a class="chip chip-org" href="${BASE}?organizer" data-nav>Organizer</a>`
    : `<a class="chip" href="${BASE}?organizer&next=${encodeURIComponent(location.search)}" data-nav>Organizer</a>`;
  return `<header class="top">
    ${back ? `<a class="back" href="${back.href}" data-nav>${esc(back.label)}</a>` : `<span></span>`}
    ${org}
  </header>`;
}

function errorView(msg) {
  return `${topBar({ href: BASE, label: 'All games' })}
  <section class="block empty">
    <h1 class="h-section">That didn't load</h1>
    <p>${esc(msg)}</p>
    <button class="btn btn-line" data-action="reload">Try again</button>
  </section>`;
}

/* ---------------------------------------------------------------- loading */

let loadSeq = 0;
async function load() {
  const r = route();
  const seq = ++loadSeq;
  if (!S.status) {
    try {
      const [status, ok] = await Promise.all([
        rpc('footy_status'),
        S.pin ? rpc('footy_check_pin', { p_pin: S.pin }) : Promise.resolve(false),
      ]);
      S.status = status;
      S.isOrg = !!ok;
      if (S.pin && !ok) { store.set('pin', null); S.pin = null; }
    } catch (e) {
      $app.innerHTML = errorView(e.message);
      return;
    }
  }
  try {
    if (r.name === 'home') {
      S.matches = await rpc('footy_list_matches');
      if (seq === loadSeq) paint(viewHome());
    } else if (r.name === 'match') {
      await fetchMatch(r.slug);
      if (seq === loadSeq) paint(viewMatch());
    } else if (r.name === 'organizer') {
      paint(viewOrganizer(r));
    } else if (r.name === 'form') {
      if (!S.isOrg) return navigate(`${BASE}?organizer&next=${encodeURIComponent(location.search)}`, true);
      paint(await viewForm(r));
    } else if (r.name === 'teams') {
      if (!S.isOrg) return navigate(`${BASE}?organizer&next=${encodeURIComponent(location.search)}`, true);
      await fetchMatch(r.slug);
      const ratings = await rpc('footy_get_ratings', { p_pin: S.pin });
      initTeamBuilder(ratings);
      if (seq === loadSeq) paint(viewTeams());
    }
  } catch (e) {
    if (seq === loadSeq) paint(errorView(e.message));
  }
}

async function fetchMatch(slug) {
  const data = await rpc('footy_get_match', { p_slug: slug, p_token: deviceToken() });
  S.data = data;
  S.dataJSON = JSON.stringify(data && { ...data, server_now: null });
  return data;
}

async function refreshMatch() {
  const r = route();
  if (r.name !== 'match' || S.busy) return;
  try {
    const before = S.dataJSON;
    await fetchMatch(r.slug);
    if (S.dataJSON !== before && route().name === 'match') paint(viewMatch());
  } catch { /* try again next tick */ }
}

setInterval(() => { if (document.visibilityState === 'visible') refreshMatch(); }, 15000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshMatch(); });

/* -------------------------------------------------------------------- home */

function viewHome() {
  const now = Date.now();
  const all = S.matches || [];
  const upcoming = all.filter((m) => new Date(m.ends_at) > now).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const past = all.filter((m) => new Date(m.ends_at) <= now).slice(0, 6);

  const row = (m, isPast) => {
    const d = new Date(m.starts_at);
    const left = m.capacity - m.confirmed;
    let spots;
    if (m.status === 'cancelled') spots = `<span class="tag tag-off">Cancelled</span>`;
    else if (isPast) spots = `<span class="spots-num">${m.confirmed}</span><span class="spots-of">played</span>`;
    else spots = `<span class="spots-num">${m.confirmed}</span><span class="spots-of">of ${m.capacity}</span>`;
    const sub = m.status === 'cancelled' ? '' :
      isPast ? '' :
      left > 0 ? `<span class="fx-sub">${plural(left, 'spot')} left</span>` :
      `<span class="fx-sub">Full${m.waitlist ? `, ${m.waitlist} waiting` : ''}</span>`;
    return `<li><a class="fx ${isPast ? 'fx-past' : ''}" href="${BASE}?m=${encodeURIComponent(m.slug)}" data-nav>
      <span class="fx-cal"><span class="fx-day">${F.day.format(d)}</span><span class="fx-mon">${F.mon.format(d)}</span></span>
      <span class="fx-body">
        <span class="fx-when">${esc(isPast ? F.dow.format(d) : dayWord(m.starts_at))} ${timeRange(m.starts_at, m.ends_at)}</span>
        <span class="fx-where">${esc(m.venue)}${m.field ? `, field ${esc(m.field)}` : ''}</span>
        ${sub}
      </span>
      <span class="fx-spots">${spots}</span>
    </a></li>`;
  };

  return `${topBar(null)}
  <section class="hero-home">
    <h1 class="wordmark">${esc(S.status?.group_name || 'Footy')}</h1>
    <p class="lede">Put your name down, send your e-transfer, check it off. Teams get posted before kickoff.</p>
  </section>
  <section class="block">
    <h2 class="h-section">Next games</h2>
    ${upcoming.length ? `<ul class="fx-list">${upcoming.map((m) => row(m, false)).join('')}</ul>`
      : `<div class="empty"><p>No games scheduled yet.</p>${S.isOrg ? '' : '<p class="muted">Whoever books the field schedules the game here, then shares the link in the chat.</p>'}</div>`}
    ${S.isOrg ? `<a class="btn btn-bib btn-wide" href="${BASE}?new" data-nav>Schedule a game</a>` : ''}
  </section>
  ${past.length ? `<section class="block">
    <h2 class="h-section h-quiet">Played</h2>
    <ul class="fx-list">${past.map((m) => row(m, true)).join('')}</ul>
  </section>` : ''}`;
}

/* ------------------------------------------------------------------- match */

function viewMatch() {
  if (!S.data) {
    return `${topBar({ href: BASE, label: 'All games' })}
    <section class="block empty">
      <h1 class="h-section">Game not found</h1>
      <p>It may have been deleted. Check the chat for the latest link.</p>
      <a class="btn btn-line" href="${BASE}" data-nav>See all games</a>
    </section>`;
  }
  const { match: m, signups } = S.data;
  const now = Date.now();
  const ins = signups.filter((s) => s.in);
  const wait = signups.filter((s) => !s.in);
  const me = signups.find((s) => s.mine && !s.guest_of) || null;
  const over = new Date(m.ends_at) < now;
  const started = new Date(m.starts_at) < now;
  const open = m.status === 'open' && !over;
  const overdue = !!m.pay_by && now > new Date(m.pay_by);
  const paidIn = ins.filter((s) => s.paid).length;
  const left = m.capacity - ins.length;
  const d = new Date(m.starts_at);

  let banner = '';
  if (m.status === 'cancelled') banner = `<p class="banner banner-off">This game is cancelled.</p>`;
  else if (over) banner = `<p class="banner">This game has been played.</p>`;
  else if (m.status === 'closed') banner = `<p class="banner">Sign-ups are closed.</p>`;

  const head = `<section class="fixture">
    <p class="kicker">${esc(m.title)}</p>
    <h1 class="date"><span class="date-dow">${esc(dayWord(m.starts_at))}</span><span class="date-md">${esc(F.monthDay.format(d))}</span></h1>
    <p class="when">${timeRange(m.starts_at, m.ends_at)}</p>
    <p class="where">${esc(m.venue)}${m.field ? `<span class="where-field">Field ${esc(m.field)}</span>` : ''}</p>
    ${banner}
    ${Number(m.price) > 0 || m.etransfer_to ? `<div class="pay">
      <p class="pay-line"><span class="pay-amt">${money(m.price)}</span> ${m.etransfer_to ? 'by e-transfer to' : 'each'}</p>
      ${m.etransfer_to ? `<button class="email" data-action="copy" data-text="${esc(m.etransfer_to)}" data-done="E-transfer address copied">
        <span class="email-addr">${esc(m.etransfer_to)}</span><span class="email-copy">Copy</span></button>` : ''}
      ${m.pay_by && !over ? `<p class="deadline ${overdue ? 'deadline-past' : ''}">${overdue ? `Payment was due ${esc(shortWhen(m.pay_by))}` : `Pay by ${esc(shortWhen(m.pay_by))}`}</p>` : ''}
    </div>` : ''}
    ${m.notes ? `<p class="notes">${esc(m.notes)}</p>` : ''}
  </section>`;

  return `${topBar({ href: BASE, label: 'All games' })}
    ${head}
    ${viewYou(m, me, signups, { open, over, left, ins })}
    ${viewSquad(m, ins, wait, { open, overdue, me, paidIn, started })}
    ${viewTeamsPublic(m, ins)}
    <section class="block share">
      <button class="btn btn-line" data-action="whatsapp">Copy list for WhatsApp</button>
      <button class="btn btn-line" data-action="share">Share link</button>
      ${!over ? `<button class="btn btn-line" data-action="ics">Add to calendar</button>` : ''}
    </section>
    ${S.isOrg ? viewOrgTools(m, ins, wait, { overdue, over }) : ''}`;
}

function viewYou(m, me, signups, { open, over, left, ins }) {
  const saved = store.get('name') || '';
  const myGuests = signups.filter((s) => s.mine && s.guest_of);
  const unclaimed = signups.some((s) => !s.claimed);

  if (me) {
    const where = me.in
      ? `You're in. Number ${me.pos} of ${m.capacity}.`
      : `You're ${ordinal(me.pos - m.capacity)} on the waitlist. You'll move up automatically if someone drops.`;
    let pay = '';
    if (me.in && Number(m.price) > 0) {
      pay = me.paid
        ? `<p class="you-paid">Paid. You're all set.</p>
           <button class="link" data-action="paid" data-id="${me.id}" data-paid="0">I haven't sent it yet</button>`
        : `<p class="you-todo">Send ${money(m.price)}${m.etransfer_to ? ` to ${esc(m.etransfer_to)}` : ''}, then tap below.</p>
           <button class="btn btn-bib btn-wide" data-action="paid" data-id="${me.id}" data-paid="1">I've sent my e-transfer</button>`;
    }
    const guestCount = myGuests.length ? `<p class="muted">You're also covering ${myGuests.map((g) => esc(g.name)).join(', ')}.</p>` : '';
    return `<section class="block you ${me.in ? 'you-in' : 'you-wait'}">
      <h2 class="you-title">${esc(me.name)}</h2>
      <p>${where}</p>
      ${pay}
      ${guestCount}
      <div class="you-actions">
        ${open ? `<button class="link" data-action="toggle" data-key="guest">Add a guest</button>` : ''}
        ${!over ? dropButton(me, 'Drop out') : ''}
      </div>
      ${open && S.ui.guest ? guestForm(me.name) : ''}
    </section>`;
  }

  if (!open) return '';

  const full = left <= 0;
  return `<section class="block you">
    <h2 class="h-section">${full ? 'Join the waitlist' : 'Put your name down'}</h2>
    <form class="join" data-form="join">
      <label class="sr" for="join-name">Your name</label>
      <input id="join-name" name="name" maxlength="40" autocomplete="nickname" placeholder="Your name" value="${esc(saved)}" required>
      <button class="btn btn-bib" type="submit">${full ? 'Join waitlist' : 'Add me'}</button>
    </form>
    <p class="muted">${full
      ? `All ${m.capacity} spots are taken. If someone drops, the first name on the waitlist moves in.`
      : `${plural(left, 'spot')} left.${Number(m.price) > 0 ? ' Once you\'re in, send the e-transfer and check yourself off.' : ''}`}</p>
    ${unclaimed ? `<p class="muted">Already on the list from the chat? Find your name below and tap <strong>That's me</strong>.</p>` : ''}
    <button class="link" data-action="toggle" data-key="guest">Adding a friend who isn't in the chat?</button>
    ${S.ui.guest ? guestForm(null) : ''}
  </section>`;
}

function guestForm(hostName) {
  return `<form class="guest" data-form="guest">
    ${hostName ? '' : `<label for="guest-host">Your name</label>
      <input id="guest-host" name="host" maxlength="40" placeholder="Your name" value="${esc(store.get('name') || '')}" required>`}
    <label for="guest-name">Guest's name</label>
    <input id="guest-name" name="guest" maxlength="40" placeholder="Guest's name" required>
    <p class="muted">Their e-transfer is on you. You can check them off once it's sent.</p>
    <button class="btn btn-line" type="submit">Add guest</button>
  </form>`;
}

function dropButton(s, label) {
  const confirming = S.ui.confirm === s.id;
  return `<button class="link link-danger" data-action="drop" data-id="${s.id}">${confirming ? 'Tap again to confirm' : label}</button>`;
}

function viewSquad(m, ins, wait, { open, overdue, me, paidIn, started }) {
  const priced = Number(m.price) > 0;
  const row = (s) => {
    const canEdit = s.mine || S.isOrg;
    const tags = [];
    if (s.mine && !s.guest_of) tags.push('You');
    if (s.guest_of) tags.push(`${esc(s.guest_of)}'s guest`);
    let state = '';
    if (priced && s.paid) state = `<span class="st st-paid"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Paid</span>`;
    else if (priced && s.in && overdue) state = `<span class="st st-card">Unpaid</span>`;
    const actions = [];
    if (canEdit && priced && s.in) {
      actions.push(`<button class="link" data-action="paid" data-id="${s.id}" data-paid="${s.paid ? 0 : 1}">${s.paid ? 'Mark unpaid' : 'Mark paid'}</button>`);
    }
    if (canEdit && !(s.mine && !s.guest_of)) actions.push(dropButton(s, s.mine ? 'Remove guest' : 'Remove'));
    if (!s.claimed && !s.mine && !me && !started) actions.push(`<button class="link" data-action="claim" data-id="${s.id}" data-name="${esc(s.name)}">That's me</button>`);
    return `<li class="row ${s.mine ? 'row-mine' : ''}">
      <span class="num">${s.in ? s.pos : s.pos - m.capacity}</span>
      <span class="who">
        <span class="name">${esc(s.name)}</span>
        ${tags.length ? `<span class="tagline">${tags.join(', ')}</span>` : ''}
      </span>
      ${state}
      ${actions.length ? `<span class="row-actions">${actions.join('')}</span>` : ''}
    </li>`;
  };

  const openRows = [];
  for (let i = ins.length + 1; i <= m.capacity; i++) {
    openRows.push(`<li class="row row-open"><span class="num">${i}</span><span class="who"><span class="name">Open</span></span></li>`);
  }

  return `<section class="block squad">
    <div class="squad-head">
      <h2 class="h-section">Squad</h2>
      <p class="squad-count"><strong>${ins.length}</strong> of ${m.capacity} in${priced ? `, <strong>${paidIn}</strong> paid` : ''}</p>
    </div>
    <ol class="rows">${ins.map(row).join('')}${openRows.join('')}</ol>
    ${wait.length ? `
      <div class="halfway" role="presentation"><span class="halfway-label">Waitlist</span></div>
      <ol class="rows rows-wait">${wait.map(row).join('')}</ol>` : ''}
  </section>`;
}

function teamsFromMatch(m, ins) {
  if (!Array.isArray(m.teams) || !m.teams.length) return null;
  const byId = new Map(ins.map((s) => [s.id, s]));
  let changed = false;
  const placed = new Set();
  const teams = m.teams.map((t, i) => {
    const players = (t.ids || []).map((id) => {
      const s = byId.get(id);
      if (!s) { changed = true; return null; }
      placed.add(id);
      return s;
    }).filter(Boolean);
    return { name: t.name || TEAM_META[i]?.name || `Team ${i + 1}`, color: t.color || TEAM_META[i]?.color || '#F3F6EF', players };
  });
  const missing = ins.filter((s) => !placed.has(s.id));
  if (missing.length) changed = true;
  return { teams, changed, missing };
}

function viewTeamsPublic(m, ins) {
  const t = teamsFromMatch(m, ins);
  if (!t) return '';
  return `<section class="block">
    <h2 class="h-section">Teams</h2>
    ${t.changed ? `<p class="banner">The list changed after these teams were made${t.missing.length ? `. Not on a team yet: ${t.missing.map((s) => esc(s.name)).join(', ')}` : ''}.</p>` : ''}
    <div class="teams">
      ${t.teams.map((team) => `<div class="team" style="--team:${esc(team.color)}">
        <h3 class="team-name"><span class="bib" aria-hidden="true"></span>${esc(team.name)}</h3>
        <ol class="team-list">${team.players.map((s) => `<li>${esc(s.name)}</li>`).join('')}</ol>
      </div>`).join('')}
    </div>
  </section>`;
}

function viewOrgTools(m, ins, wait, { overdue, over }) {
  const unpaid = ins.filter((s) => !s.paid);
  const priced = Number(m.price) > 0;
  const confirmDelete = S.ui.confirm === 'delete-match';
  return `<section class="block org">
    <h2 class="h-section">Organizer</h2>
    ${priced && ins.length ? `<p>${unpaid.length ? `Still unpaid: ${unpaid.map((s) => esc(s.name)).join(', ')}.` : 'Everyone in the squad has paid.'}</p>` : ''}
    <div class="org-grid">
      <a class="btn btn-line" href="${BASE}?teams=${encodeURIComponent(m.slug)}" data-nav>${m.teams ? 'Redo teams' : 'Make teams'}</a>
      <a class="btn btn-line" href="${BASE}?edit=${encodeURIComponent(m.slug)}" data-nav>Edit game</a>
      <button class="btn btn-line" data-action="toggle" data-key="bulk">Paste names from chat</button>
      ${priced && unpaid.length && wait.length ? `<button class="btn btn-line" data-action="bump">Move unpaid to waitlist</button>` : ''}
      ${!over && m.status !== 'cancelled' ? (m.status === 'open'
        ? `<button class="btn btn-line" data-action="status" data-status="closed">Close sign-ups</button>`
        : `<button class="btn btn-line" data-action="status" data-status="open">Reopen sign-ups</button>`) : ''}
      ${m.status === 'cancelled'
        ? `<button class="btn btn-line" data-action="status" data-status="open">Restore game</button>`
        : !over ? `<button class="btn btn-line" data-action="status" data-status="cancelled">Cancel game</button>` : ''}
      <a class="btn btn-line" href="${BASE}?new&from=${encodeURIComponent(m.slug)}" data-nav>Schedule next week</a>
      <button class="btn btn-line btn-danger" data-action="delete-match">${confirmDelete ? 'Tap again to delete' : 'Delete game'}</button>
    </div>
    ${priced && unpaid.length && wait.length ? `<p class="muted">Moving unpaid players puts them behind the waitlist, so the people waiting get their spots.</p>` : ''}
    ${S.ui.bulk ? `<form class="bulk" data-form="bulk">
      <label for="bulk-names">Paste the list from the group chat</label>
      <textarea id="bulk-names" name="names" rows="8" placeholder="1- Kababji&#10;2- Ghassan&#10;3- Yazen"></textarea>
      <p class="muted">One name per line. Numbers are stripped and names already on the list are skipped. Each person can tap That's me to check themselves off later.</p>
      <button class="btn btn-bib" type="submit">Add names</button>
    </form>` : ''}
  </section>`;
}

/* -------------------------------------------------------------- organizer */

function viewOrganizer(r) {
  const next = r.next && r.next.startsWith('?') ? BASE + r.next : BASE;
  if (!S.status?.has_pin) {
    return `${topBar({ href: BASE, label: 'All games' })}
    <section class="block narrow">
      <h1 class="h-page">Set an organizer PIN</h1>
      <p>Anyone with this PIN can schedule games, fix the list and make teams. Share it only with the people who book the field.</p>
      <form class="stack" data-form="setpin" data-next="${esc(next)}">
        <label for="pin-new">PIN</label>
        <input id="pin-new" name="pin" type="password" minlength="4" maxlength="32" autocomplete="new-password" inputmode="text" required>
        <label for="pin-confirm">Type it again</label>
        <input id="pin-confirm" name="confirm" type="password" minlength="4" maxlength="32" autocomplete="new-password" required>
        <button class="btn btn-bib" type="submit">Set PIN</button>
      </form>
    </section>`;
  }
  if (S.isOrg) {
    return `${topBar({ href: BASE, label: 'All games' })}
    <section class="block narrow">
      <h1 class="h-page">Organizer mode is on</h1>
      <p>This device can schedule games, fix the list and make teams.</p>
      <div class="stack">
        <a class="btn btn-bib" href="${BASE}?new" data-nav>Schedule a game</a>
        <button class="btn btn-line" data-action="logout">Turn off organizer mode</button>
      </div>
      <button class="link" data-action="toggle" data-key="changepin">Change the PIN</button>
      ${S.ui.changepin ? `<form class="stack" data-form="changepin">
        <label for="pin-old">Current PIN</label>
        <input id="pin-old" name="old" type="password" autocomplete="current-password" required>
        <label for="pin-next">New PIN</label>
        <input id="pin-next" name="pin" type="password" minlength="4" maxlength="32" autocomplete="new-password" required>
        <button class="btn btn-line" type="submit">Change PIN</button>
      </form>` : ''}
    </section>`;
  }
  return `${topBar({ href: BASE, label: 'All games' })}
  <section class="block narrow">
    <h1 class="h-page">Organizer PIN</h1>
    <p>Enter the PIN to schedule games, fix the list and make teams.</p>
    <form class="stack" data-form="login" data-next="${esc(next)}">
      <label for="pin-login">PIN</label>
      <input id="pin-login" name="pin" type="password" autocomplete="current-password" required>
      <button class="btn btn-bib" type="submit">Continue</button>
    </form>
  </section>`;
}

/* -------------------------------------------------------------- game form */

const PAY_BY_OPTIONS = [
  { h: 0, label: 'No deadline' },
  { h: 72, label: '3 days before' },
  { h: 48, label: '2 days before' },
  { h: 24, label: '1 day before' },
  { h: 12, label: '12 hours before' },
  { h: 6, label: '6 hours before' },
  { h: 3, label: '3 hours before' },
  { h: 1, label: '1 hour before' },
];

async function viewForm(r) {
  let src = null, editing = false;
  if (r.slug) {
    const data = await rpc('footy_get_match', { p_slug: r.slug, p_token: deviceToken() });
    if (!data) return errorView('That game no longer exists.');
    src = data.match; editing = true;
  } else if (r.from) {
    const data = await rpc('footy_get_match', { p_slug: r.from, p_token: deviceToken() });
    src = data?.match || null;
  } else {
    const list = await rpc('footy_list_matches');
    src = list[0] || null;   // most recent game, used as a template
  }

  const v = {
    id: editing ? src.id : '',
    title: src?.title ?? DEFAULT_GAME.title,
    venue: src?.venue ?? DEFAULT_GAME.venue,
    field: src?.field ?? DEFAULT_GAME.field,
    price: src ? Number(src.price).toFixed(2) : DEFAULT_GAME.price,
    etransfer_to: src?.etransfer_to ?? '',
    capacity: src?.capacity ?? DEFAULT_GAME.capacity,
    team_count: src?.team_count ?? DEFAULT_GAME.team_count,
    notes: editing ? (src.notes || '') : '',
  };

  let start, end, payH = DEFAULT_GAME.pay_by_hours;
  if (src) {
    const s = new Date(src.starts_at), e = new Date(src.ends_at);
    if (src.pay_by) payH = Math.round((s - new Date(src.pay_by)) / 36e5); else payH = 0;
    if (editing) { start = s; end = e; }
    else {
      // Same weekday and time as the template, on the next date that's still ahead.
      const dur = e - s;
      let next = new Date(s.getTime());
      while (next.getTime() < Date.now() + 36e5) next = new Date(next.getTime() + 7 * 864e5);
      const { date } = zonedInputs(next.toISOString());
      const { time } = zonedInputs(src.starts_at);
      start = new Date(zonedISO(date, time));
      end = new Date(start.getTime() + dur);
    }
  } else {
    const today = partsOf(new Date());
    const base = new Date(Date.UTC(today.year, today.month - 1, today.day));
    let add = (DEFAULT_GAME.weekday - base.getUTCDay() + 7) % 7;
    const pad = (n) => String(n).padStart(2, '0');
    let dt, iso;
    for (;;) {
      dt = new Date(base.getTime() + add * 864e5);
      iso = zonedISO(`${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`, DEFAULT_GAME.start);
      if (new Date(iso).getTime() > Date.now() + 36e5) break;
      add += 7;
    }
    start = new Date(iso);
    const [sh, sm] = DEFAULT_GAME.start.split(':').map(Number);
    const [eh, em] = DEFAULT_GAME.end.split(':').map(Number);
    end = new Date(start.getTime() + (((eh * 60 + em) - (sh * 60 + sm) + 1440) % 1440) * 6e4);
  }
  // For a game coming up soon, don't default to a deadline that's already gone.
  if (!editing && payH && start.getTime() - payH * 36e5 < Date.now() + 30 * 6e4) {
    const fit = PAY_BY_OPTIONS.filter((o) => o.h && start.getTime() - o.h * 36e5 > Date.now() + 30 * 6e4).sort((a, b) => b.h - a.h)[0];
    payH = fit ? fit.h : 0;
  }
  const si = zonedInputs(start.toISOString()), ei = zonedInputs(end.toISOString());
  const opts = PAY_BY_OPTIONS.some((o) => o.h === payH) ? PAY_BY_OPTIONS : [...PAY_BY_OPTIONS, { h: payH, label: `${payH} hours before` }];

  const back = editing ? { href: `${BASE}?m=${encodeURIComponent(src.slug)}`, label: 'Back to game' } : { href: BASE, label: 'All games' };
  return `${topBar(back)}
  <section class="block narrow">
    <h1 class="h-page">${editing ? 'Edit game' : 'Schedule a game'}</h1>
    <form class="stack gameform" data-form="game">
      <input type="hidden" name="id" value="${esc(v.id)}">
      <label for="g-title">What</label>
      <input id="g-title" name="title" maxlength="40" value="${esc(v.title)}" placeholder="8 v 8" data-fresh>
      <div class="pair">
        <div><label for="g-venue">Venue</label><input id="g-venue" name="venue" maxlength="80" value="${esc(v.venue)}" required data-fresh></div>
        <div class="pair-small"><label for="g-field">Field</label><input id="g-field" name="field" maxlength="40" value="${esc(v.field)}" data-fresh></div>
      </div>
      <label for="g-date">Date</label>
      <input id="g-date" name="date" type="date" value="${si.date}" required data-fresh>
      <div class="pair">
        <div><label for="g-start">Starts</label><input id="g-start" name="start" type="time" value="${si.time}" required data-fresh></div>
        <div><label for="g-end">Ends</label><input id="g-end" name="end" type="time" value="${ei.time}" required data-fresh></div>
      </div>
      <div class="pair">
        <div><label for="g-price">Price per player</label><input id="g-price" name="price" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(v.price)}" data-fresh></div>
        <div><label for="g-payby">Pay by</label><select id="g-payby" name="payby" data-fresh>${opts.map((o) => `<option value="${o.h}" ${o.h === payH ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>
      </div>
      <label for="g-et">E-transfer to</label>
      <input id="g-et" name="etransfer_to" maxlength="120" type="email" inputmode="email" value="${esc(v.etransfer_to)}" placeholder="whoever booked the field" data-fresh>
      <div class="pair">
        <div><label for="g-cap">Spots</label><input id="g-cap" name="capacity" type="number" min="2" max="60" value="${v.capacity}" required data-fresh></div>
        <div><label for="g-teams">Teams</label><input id="g-teams" name="team_count" type="number" min="2" max="6" value="${v.team_count}" required data-fresh></div>
      </div>
      <p class="muted" id="g-split">${splitText(v.capacity, v.team_count)}</p>
      <label for="g-notes">Notes for players</label>
      <textarea id="g-notes" name="notes" rows="3" maxlength="500" placeholder="Bring a light and a dark shirt" data-fresh>${esc(v.notes)}</textarea>
      <button class="btn btn-bib" type="submit">${editing ? 'Save changes' : 'Schedule game'}</button>
    </form>
  </section>`;
}

function splitText(cap, teams) {
  cap = Number(cap); teams = Number(teams);
  if (!cap || !teams) return '';
  const per = Math.floor(cap / teams), extra = cap % teams;
  return extra ? `${teams} teams of ${per} or ${per + 1}` : `${teams} teams of ${per}`;
}

/* ------------------------------------------------------------ team builder */

function initTeamBuilder(ratings) {
  const { match: m, signups } = S.data;
  const ins = signups.filter((s) => s.in);
  const k = m.team_count || 2;
  let teams = Array.from({ length: k }, () => []);
  let unplaced = ins.map((s) => s.id);
  const t = teamsFromMatch(m, ins);
  if (t) {
    teams = Array.from({ length: k }, (_, i) => (t.teams[i]?.players || []).map((s) => s.id));
    const placed = new Set(teams.flat());
    unplaced = ins.filter((s) => !placed.has(s.id)).map((s) => s.id);
  }
  S.tb = { ratings: ratings || {}, teams, unplaced, selected: null, k, hasTeams: !!t };
}

function ratingOf(s) {
  const r = S.tb.ratings[nameKey(s.name)];
  return typeof r === 'number' ? r : 3;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Split players into k teams with even sizes and totals as close as possible.
// Randomised restarts mean "Shuffle again" gives a different, equally fair split.
function balance(players, k) {
  const n = players.length;
  let best = null, bestScore = Infinity;
  const score = (sums) => {
    const max = Math.max(...sums), min = Math.min(...sums);
    const mean = sums.reduce((a, b) => a + b, 0) / sums.length;
    return (max - min) * 10 + sums.reduce((a, b) => a + (b - mean) ** 2, 0) / 100;
  };
  for (let trial = 0; trial < 250; trial++) {
    const sizes = Array.from({ length: k }, () => Math.floor(n / k));
    shuffle([...Array(k).keys()]).slice(0, n % k).forEach((i) => sizes[i]++);
    const order = shuffle(players.slice()).sort((a, b) => b.r - a.r);
    const teams = Array.from({ length: k }, () => []);
    const sums = Array(k).fill(0);
    for (const p of order) {
      let bi = -1;
      for (let i = 0; i < k; i++) {
        if (teams[i].length >= sizes[i]) continue;
        if (bi < 0 || sums[i] < sums[bi] || (sums[i] === sums[bi] && Math.random() < 0.5)) bi = i;
      }
      teams[bi].push(p); sums[bi] += p.r;
    }
    let improved = true, guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      const cur = score(sums);
      outer:
      for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) {
        for (let i = 0; i < teams[a].length; i++) for (let j = 0; j < teams[b].length; j++) {
          const d = teams[b][j].r - teams[a][i].r;
          if (!d) continue;
          sums[a] += d; sums[b] -= d;
          if (score(sums) < cur - 1e-9) {
            [teams[a][i], teams[b][j]] = [teams[b][j], teams[a][i]];
            improved = true;
            break outer;
          }
          sums[a] -= d; sums[b] += d;
        }
      }
    }
    const sc = score(sums);
    if (sc < bestScore - 1e-9 || (Math.abs(sc - bestScore) < 1e-9 && Math.random() < 0.3)) { bestScore = sc; best = teams.map((t) => t.slice()); }
  }
  return best;
}

function viewTeams() {
  const { match: m, signups } = S.data;
  const ins = signups.filter((s) => s.in);
  const byId = new Map(ins.map((s) => [s.id, s]));
  const tb = S.tb;
  const back = { href: `${BASE}?m=${encodeURIComponent(m.slug)}`, label: 'Back to game' };
  if (ins.length < 2) {
    return `${topBar(back)}<section class="block narrow empty"><h1 class="h-page">Make teams</h1><p>Teams can be made once at least 2 players are in.</p></section>`;
  }
  const anyTeams = tb.teams.some((t) => t.length);

  const rateRow = (s) => {
    const r = ratingOf(s);
    const set = typeof tb.ratings[nameKey(s.name)] === 'number';
    return `<li class="rate-row">
      <span class="name">${esc(s.name)}</span>
      <span class="rate ${set ? '' : 'rate-default'}" role="group" aria-label="Rating for ${esc(s.name)}">
        ${[1, 2, 3, 4, 5].map((n) => `<button class="rate-btn" data-action="rate" data-id="${s.id}" data-r="${n}" aria-pressed="${n === r}">${n}</button>`).join('')}
      </span>
    </li>`;
  };

  const playerBtn = (id) => {
    const s = byId.get(id);
    if (!s) return '';
    return `<li><button class="pl ${tb.selected === id ? 'pl-sel' : ''}" data-action="pick" data-id="${id}">
      <span>${esc(s.name)}</span><span class="pl-r">${ratingOf(s)}</span></button></li>`;
  };

  return `${topBar(back)}
  <section class="block">
    <h1 class="h-page">Make teams</h1>
    <p>${esc(dayWord(m.starts_at))}, ${esc(F.monthDay.format(new Date(m.starts_at)))}. ${ins.length} players, ${splitText(ins.length, tb.k)}.</p>
  </section>
  <section class="block">
    <h2 class="h-section">Rate players</h2>
    <p class="muted">1 is just starting out, 5 is one of the best in the group. Ratings are saved for next time and only organizers see them. Anyone unrated counts as a 3.</p>
    <ol class="rate-list">${ins.map(rateRow).join('')}</ol>
  </section>
  <section class="block">
    <button class="btn btn-bib btn-wide" data-action="generate">${anyTeams ? 'Shuffle fair teams again' : 'Make fair teams'}</button>
    ${anyTeams ? `
      <p class="muted">Tap two players to swap them.</p>
      <div class="teams teams-edit">
        ${tb.teams.map((ids, i) => {
          const meta = TEAM_META[i] || { name: `Team ${i + 1}`, color: '#F3F6EF' };
          const total = ids.reduce((a, id) => a + (byId.get(id) ? ratingOf(byId.get(id)) : 0), 0);
          return `<div class="team" style="--team:${meta.color}">
            <h3 class="team-name"><span class="bib" aria-hidden="true"></span>${meta.name}<span class="team-total">${total}</span></h3>
            <ol class="team-list">${ids.map(playerBtn).join('')}</ol>
          </div>`;
        }).join('')}
      </div>
      ${tb.unplaced.length ? `<h3 class="h-sub">Not on a team</h3><ol class="team-list bench">${tb.unplaced.map(playerBtn).join('')}</ol>` : ''}
      <div class="stack">
        <button class="btn btn-bib" data-action="publish">Publish teams</button>
        ${tb.hasTeams ? `<button class="link link-danger" data-action="unpublish">Take down published teams</button>` : ''}
      </div>` : ''}
  </section>`;
}

/* ---------------------------------------------------------- share helpers */

function gameURL(m) { return `${location.origin}${BASE}?m=${encodeURIComponent(m.slug)}`; }

function whatsappText() {
  const { match: m, signups } = S.data;
  const d = new Date(m.starts_at);
  const ins = signups.filter((s) => s.in), wait = signups.filter((s) => !s.in);
  const priced = Number(m.price) > 0;
  const lines = [
    `⚽ ${m.title} at ${m.venue}${m.field ? `, Field ${m.field}` : ''}`,
    `📅 ${F.dow.format(d)}, ${F.monthLong.format(d)} ${ordinal(Number(F.day.format(d)))}`,
    `⏰ ${clock(m.starts_at)} → ${clock(m.ends_at)}`,
  ];
  if (priced) lines.push(`💰 ${money(m.price)}${m.etransfer_to ? ` → ${m.etransfer_to}` : ''}`);
  if (m.pay_by) lines.push(`Pay by ${shortWhen(m.pay_by)}`);
  if (m.status === 'cancelled') lines.push('', '❌ CANCELLED');
  lines.push('', 'Sign up and check yourself off here:', gameURL(m), '', `Players (${ins.length}/${m.capacity}):`);
  ins.forEach((s) => lines.push(`${s.pos}- ${s.name}${s.guest_of ? ` (${s.guest_of}'s guest)` : ''}${priced && s.paid ? ' ✅' : ''}`));
  const left = m.capacity - ins.length;
  if (left > 0) lines.push(`${plural(left, 'spot')} left`);
  if (wait.length) {
    lines.push('', 'Waitlist:');
    wait.forEach((s) => lines.push(`${s.pos - m.capacity}- ${s.name}`));
  }
  const t = teamsFromMatch(m, ins);
  if (t) {
    t.teams.forEach((team) => { lines.push('', `${team.name}:`, team.players.map((s) => s.name).join(', ')); });
  }
  return lines.join('\n');
}

function icsFile() {
  const { match: m } = S.data;
  const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const escI = (s) => String(s).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Footy//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${m.id}@footy`, `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(m.starts_at)}`, `DTEND:${stamp(m.ends_at)}`,
    `SUMMARY:${escI(`Footy: ${m.title}`)}`,
    `LOCATION:${escI(m.venue + (m.field ? `, Field ${m.field}` : ''))}`,
    `DESCRIPTION:${escI(gameURL(m))}`, `URL:${gameURL(m)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', 'DESCRIPTION:Footy tonight', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove(); return ok;
  }
}

/* ----------------------------------------------------------------- actions */

let confirmTimer;
function armConfirm(key) {
  S.ui.confirm = key;
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => { if (S.ui.confirm === key) { S.ui.confirm = null; rerender(); } }, 4000);
  rerender();
}

function rerender() {
  const r = route();
  if (r.name === 'match') paint(viewMatch());
  else if (r.name === 'teams') paint(viewTeams());
  else if (r.name === 'organizer') paint(viewOrganizer(r));
}

async function withBusy(el, fn) {
  if (S.busy) return;
  S.busy = true;
  if (el) el.disabled = true;
  try { await fn(); } catch (e) { toast(e.message, 'error'); } finally {
    S.busy = false;
    if (el && document.body.contains(el)) el.disabled = false;
  }
}

async function reloadMatch() { await fetchMatch(route().slug); rerender(); }

$app.addEventListener('click', async (e) => {
  const nav = e.target.closest('a[data-nav]');
  if (nav && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
    e.preventDefault();
    navigate(nav.getAttribute('href'));
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const m = S.data?.match;

  if (a === 'reload') { S.status = null; return load(); }
  if (a === 'toggle') { S.ui[el.dataset.key] = !S.ui[el.dataset.key]; rerender(); return; }

  if (a === 'copy') {
    if (await copyText(el.dataset.text)) toast(el.dataset.done || 'Copied');
    else toast("Couldn't copy. Press and hold to copy it instead.", 'error');
    return;
  }
  if (a === 'whatsapp') {
    if (await copyText(whatsappText())) toast('List copied. Paste it in the group chat.');
    else toast("Couldn't copy the list on this device.", 'error');
    return;
  }
  if (a === 'share') {
    const url = gameURL(m);
    const title = `Footy ${dayWord(m.starts_at).toLowerCase()} ${clock(m.starts_at)}`;
    if (navigator.share) { try { await navigator.share({ title, url }); } catch { /* closed */ } return; }
    if (await copyText(url)) toast('Link copied');
    return;
  }
  if (a === 'ics') {
    const blob = new Blob([icsFile()], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `footy-${m.slug}.ics`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return;
  }

  if (a === 'paid') {
    const paid = el.dataset.paid === '1';
    return withBusy(el, async () => {
      await rpc('footy_set_paid', { p_signup_id: el.dataset.id, p_paid: paid, p_token: deviceToken(), p_pin: S.isOrg ? S.pin : null });
      await reloadMatch();
      toast(paid ? 'Marked as paid' : 'Marked as unpaid');
    });
  }

  if (a === 'drop') {
    const id = el.dataset.id;
    if (S.ui.confirm !== id) return armConfirm(id);
    S.ui.confirm = null;
    const before = S.data.signups;
    const leaving = before.find((s) => s.id === id);
    return withBusy(el, async () => {
      await rpc('footy_leave', { p_signup_id: id, p_token: deviceToken(), p_pin: S.isOrg ? S.pin : null });
      await reloadMatch();
      const promoted = leaving?.in ? S.data.signups.find((s) => s.in && !before.find((b) => b.id === s.id && b.in)) : null;
      let msg = leaving?.mine && !leaving.guest_of ? "You've dropped out." : `Removed ${leaving?.name || 'player'}.`;
      if (promoted) msg += ` ${promoted.name} moves up from the waitlist.`;
      if (leaving?.paid && Number(m.price) > 0) msg += ' Already paid? Whoever takes the spot can e-transfer you instead.';
      toast(msg);
    });
  }

  if (a === 'claim') {
    return withBusy(el, async () => {
      await rpc('footy_claim', { p_signup_id: el.dataset.id, p_token: deviceToken() });
      store.set('name', el.dataset.name);
      await reloadMatch();
      toast(`Got it, you're ${el.dataset.name}. You can check yourself off now.`);
    });
  }

  if (a === 'status') {
    const st = el.dataset.status;
    return withBusy(el, async () => {
      await rpc('footy_set_match_status', { p_pin: S.pin, p_match_id: m.id, p_status: st });
      await reloadMatch();
      toast({ open: 'Sign-ups are open', closed: 'Sign-ups closed', cancelled: 'Game cancelled. Let the chat know.' }[st]);
    });
  }

  if (a === 'bump') {
    return withBusy(el, async () => {
      const n = await rpc('footy_bump_unpaid', { p_pin: S.pin, p_match_id: m.id });
      await reloadMatch();
      toast(n ? `Moved ${plural(n, 'unpaid player')} behind the waitlist` : 'Everyone in the squad has paid');
    });
  }

  if (a === 'delete-match') {
    if (S.ui.confirm !== 'delete-match') return armConfirm('delete-match');
    S.ui.confirm = null;
    return withBusy(el, async () => {
      await rpc('footy_delete_match', { p_pin: S.pin, p_match_id: m.id });
      toast('Game deleted');
      navigate(BASE, true);
    });
  }

  if (a === 'logout') {
    store.set('pin', null); S.pin = null; S.isOrg = false;
    toast('Organizer mode is off on this device');
    navigate(BASE, true);
    return;
  }

  // team builder
  if (a === 'rate') {
    const s = S.data.signups.find((x) => x.id === el.dataset.id);
    const r = Number(el.dataset.r);
    S.tb.ratings[nameKey(s.name)] = r;
    rerender();
    rpc('footy_set_rating', { p_pin: S.pin, p_name: s.name, p_rating: r }).catch((err) => toast(err.message, 'error'));
    return;
  }
  if (a === 'generate') {
    const ins = S.data.signups.filter((s) => s.in);
    const best = balance(ins.map((s) => ({ id: s.id, r: ratingOf(s) })), S.tb.k);
    S.tb.teams = best.map((t) => t.map((p) => p.id));
    S.tb.unplaced = [];
    S.tb.selected = null;
    rerender();
    return;
  }
  if (a === 'pick') {
    const id = el.dataset.id, tb = S.tb;
    if (!tb.selected) { tb.selected = id; rerender(); return; }
    if (tb.selected === id) { tb.selected = null; rerender(); return; }
    const locate = (x) => {
      for (let i = 0; i < tb.teams.length; i++) { const j = tb.teams[i].indexOf(x); if (j >= 0) return [tb.teams[i], j]; }
      return [tb.unplaced, tb.unplaced.indexOf(x)];
    };
    const [la, ia] = locate(tb.selected), [lb, ib] = locate(id);
    if (la === tb.unplaced && lb === tb.unplaced) { tb.selected = id; rerender(); return; }
    [la[ia], lb[ib]] = [lb[ib], la[ia]];
    tb.selected = null;
    rerender();
    return;
  }
  if (a === 'publish') {
    const teams = S.tb.teams.map((ids, i) => ({ name: TEAM_META[i]?.name || `Team ${i + 1}`, color: TEAM_META[i]?.color || '#F3F6EF', ids }));
    return withBusy(el, async () => {
      await rpc('footy_save_teams', { p_pin: S.pin, p_match_id: m.id, p_teams: teams });
      toast('Teams published');
      navigate(`${BASE}?m=${encodeURIComponent(m.slug)}`);
    });
  }
  if (a === 'unpublish') {
    return withBusy(el, async () => {
      await rpc('footy_save_teams', { p_pin: S.pin, p_match_id: m.id, p_teams: null });
      toast('Teams taken down');
      navigate(`${BASE}?m=${encodeURIComponent(m.slug)}`);
    });
  }
});

$app.addEventListener('input', (e) => {
  if (e.target.id === 'g-cap' || e.target.id === 'g-teams') {
    const out = document.getElementById('g-split');
    if (out) out.textContent = splitText(document.getElementById('g-cap').value, document.getElementById('g-teams').value);
  }
});

$app.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  const f = Object.fromEntries(new FormData(form));
  const btn = form.querySelector('button[type="submit"]');
  const slug = route().slug;

  if (kind === 'join') {
    return withBusy(btn, async () => {
      const name = f.name.trim();
      await rpc('footy_join', { p_slug: slug, p_name: name, p_token: deviceToken() });
      store.set('name', name);
      await reloadMatch();
      const me = S.data.signups.find((s) => s.mine && !s.guest_of);
      toast(me?.in ? `You're in at number ${me.pos}` : `You're on the waitlist`);
    });
  }
  if (kind === 'guest') {
    return withBusy(btn, async () => {
      const host = (f.host || S.data.signups.find((s) => s.mine && !s.guest_of)?.name || '').trim();
      if (!host) throw new Error('Add your name so people know who the guest is with');
      if (f.host) store.set('name', host);
      await rpc('footy_join', { p_slug: slug, p_name: f.guest.trim(), p_token: deviceToken(), p_guest_of: host });
      S.ui.guest = false;
      await reloadMatch();
      const g = S.data.signups.filter((s) => s.mine && s.guest_of).pop();
      toast(g?.in ? `${g.name} is in at number ${g.pos}` : `${g?.name || 'Your guest'} is on the waitlist`);
    });
  }
  if (kind === 'bulk') {
    const names = String(f.names || '').split(/\r?\n/)
      .map((l) => l.replace(/^\s*\d+\s*[-.):]?\s*/, '').replace(/[✅✔☑️]/gu, '').trim())
      .filter((l) => l && !/^players?\s*list:?$/i.test(l) && !/^waitlist:?$/i.test(l));
    if (!names.length) { toast('Paste at least one name', 'error'); return; }
    return withBusy(btn, async () => {
      const n = await rpc('footy_bulk_add', { p_pin: S.pin, p_slug: slug, p_names: names });
      S.ui.bulk = false;
      await reloadMatch();
      toast(n ? `Added ${plural(n, 'name')}` : 'Those names are already on the list');
    });
  }
  if (kind === 'setpin') {
    if (f.pin !== f.confirm) { toast("The two PINs don't match", 'error'); return; }
    return withBusy(btn, async () => {
      await rpc('footy_set_pin', { p_new_pin: f.pin });
      store.set('pin', f.pin); S.pin = f.pin; S.isOrg = true; S.status.has_pin = true;
      toast('PIN set. Organizer mode is on.');
      navigate(form.dataset.next || BASE, true);
    });
  }
  if (kind === 'login') {
    return withBusy(btn, async () => {
      const ok = await rpc('footy_check_pin', { p_pin: f.pin });
      if (!ok) throw new Error('That PIN is wrong');
      store.set('pin', f.pin); S.pin = f.pin; S.isOrg = true;
      toast('Organizer mode is on');
      navigate(form.dataset.next || BASE, true);
    });
  }
  if (kind === 'changepin') {
    return withBusy(btn, async () => {
      await rpc('footy_set_pin', { p_new_pin: f.pin, p_old_pin: f.old });
      store.set('pin', f.pin); S.pin = f.pin;
      S.ui.changepin = false;
      toast('PIN changed. Tell the other organizers.');
      rerender();
    });
  }
  if (kind === 'game') {
    return withBusy(btn, async () => {
      const starts = zonedISO(f.date, f.start);
      let ends = zonedISO(f.date, f.end);
      if (new Date(ends) <= new Date(starts)) ends = new Date(new Date(ends).getTime() + 864e5).toISOString();
      const h = Number(f.payby || 0);
      const payload = {
        id: f.id || null, title: f.title, venue: f.venue, field: f.field,
        starts_at: starts, ends_at: ends, price: f.price || '0', etransfer_to: f.etransfer_to,
        capacity: f.capacity, team_count: f.team_count, notes: f.notes,
        pay_by: h ? new Date(new Date(starts).getTime() - h * 36e5).toISOString() : '',
      };
      const newSlug = await rpc('footy_save_match', { p_pin: S.pin, p: payload });
      toast(f.id ? 'Changes saved' : 'Game scheduled. Share the link in the chat.');
      navigate(`${BASE}?m=${encodeURIComponent(newSlug)}`, true);
    });
  }
});

load();
