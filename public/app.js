import { SystemBars, SystemBarsStyle } from './vendor/capacitor.js';
import * as realAws from './aws.js';
import { NATIVE, AwsError, REGIONS, regionName, mapLimit, IAM_POLICY } from './aws.js';
import { lineChart, formatValue, formatSeconds } from './charts.js';
import * as adv from './advanced.js';

const VERSION = '1.0.0';

// In a desktop browser, ?demo shows the interface with made-up data (requests need the Android app).
const DEMO = !NATIVE && new URLSearchParams(location.search).has('demo');
const aws = DEMO ? await import('./demo.js') : realAws;

// ---------------------------------------------------------------------------
// Helpers

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const enc = encodeURIComponent;

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`cb:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`cb:${key}`, JSON.stringify(value));
    } catch {
      // Storage full: preferences just won't persist.
    }
  },
};

function parseJSON(v, fallback = null) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : /^\d+$/.test(String(v)) ? new Date(Number(v) * (String(v).length <= 10 ? 1000 : 1)) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ago(v) {
  const d = toDate(v);
  if (!d) return '';
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDate(v) {
  const d = toDate(v);
  return d ? d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

function bytes(n) {
  let v = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const num = (n) => Number(n || 0).toLocaleString();
const plural = (n, word, many = `${word}s`) => `${num(n)} ${n === 1 ? word : many}`;

function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Short-lived cache so moving between screens feels instant. Refresh clears it.
const memoStore = new Map();
function memo(key, ttl, fn) {
  const hit = memoStore.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.p;
  const p = fn();
  memoStore.set(key, { at: Date.now(), p });
  p.catch(() => memoStore.delete(key));
  return p;
}

// ---------------------------------------------------------------------------
// Icons (24px grid, stroked)

const ICONS = {
  home: '<path d="M4 11l8-7 8 7v8.5a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19.5z"/>',
  bucket: '<ellipse cx="12" cy="6" rx="8" ry="2.6"/><path d="M4 6l1.8 12.3c.2 1.3 2.9 2.3 6.2 2.3s6-1 6.2-2.3L20 6"/>',
  queue: '<rect x="3" y="7" width="4" height="10" rx="1.2"/><rect x="9.5" y="7" width="4" height="10" rx="1.2"/><path d="M16.5 12H21M19 9.5l2.5 2.5-2.5 2.5"/>',
  watch: '<circle cx="10.5" cy="10.5" r="7"/><path d="M15.6 15.6L21 21M6.3 11h2l1.3-2.6 1.9 5 1.3-2.4h2"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  chart: '<path d="M4 19.5h16"/><path d="M5 15l4-5 4 3 6-7"/>',
  logs: '<path d="M6 3.5h9l4 4v13H6z"/><path d="M15 3.5v4h4M9 12h7M9 15.5h7M9 8.5h3"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  file: '<path d="M6 3.5h8l5 5v12H6z"/><path d="M14 3.5v5h5"/>',
  fileText: '<path d="M6 3.5h8l5 5v12H6z"/><path d="M14 3.5v5h5M9 13h6M9 16.5h6"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-9 8.5"/>',
  archive: '<rect x="3.5" y="4" width="17" height="4.5" rx="1"/><path d="M5 8.5v10.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M10 12.5h4"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.7 5.4 3.7 8.5s-1.2 5.9-3.7 8.5c-2.5-2.6-3.7-5.4-3.7-8.5s1.2-5.9 3.7-8.5z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16 7l2.5 2.5M14 9l2 2"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z"/><path d="M8.8 12l2.2 2.2 4.3-4.4"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
  inbox: '<path d="M3.5 13l2.5-7.5h12L20.5 13v5.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/><path d="M3.5 13H8l1.5 2.5h5L16 13h4.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.4L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.6 4.4l1.4-1.9M20 20v-4.5h-4.5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  settings: '<circle cx="12" cy="12" r="2.8"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4.9a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.4A7.5 7.5 0 0 0 7 6.4l-2.4-.9-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-.9a7.5 7.5 0 0 0 2.6 1.5l.4 2.4h4l.4-2.4a7.5 7.5 0 0 0 2.6-1.5l2.4.9 2-3.4z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.3l2.4 2.4 4.6-4.9"/>',
  xCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/>',
  alert: '<path d="M12 4l9 16H3zM12 10v4.5M12 17.5v.1"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  logout: '<path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10"/>',
  wrap: '<path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4M4 18h5M14.5 16l-2 2 2 2"/>',
  play: '<path d="M8 5.5l11 6.5-11 6.5z"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  pin: '<path d="M9 3.5h6l-.8 5.2 3.3 3.3v1.8h-11V12l3.3-3.3z"/><path d="M12 13.8v6.7"/>',
  container: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  lambda: '<path d="M5 20l6.2-10.5M7.5 4h2.8L18.5 20"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  table: '<rect x="4" y="4.5" width="16" height="15" rx="2"/><path d="M4 9.5h16M4 14.5h16M10 9.5v10"/>',
  megaphone: '<path d="M4 10v4h3l7 4V6L7 10z"/><path d="M17.5 9a4 4 0 0 1 0 6"/>',
  dollar: '<circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.3c-.4-.9-1.5-1.5-2.8-1.5-1.6 0-2.8.8-2.8 2s1.2 1.7 2.8 2 2.8.9 2.8 2.1-1.2 2-2.8 2c-1.4 0-2.5-.6-2.9-1.6M12 6.3v1.5M12 16.2v1.5"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.5 3.6-5.5 7-5.5s6.2 2 7 5.5"/>',
  skull: '<path d="M12 3.5a7.5 7.5 0 0 0-4.5 13.5v3h9v-3A7.5 7.5 0 0 0 12 3.5z"/><circle cx="9.3" cy="11.5" r="1.4"/><circle cx="14.7" cy="11.5" r="1.4"/><path d="M10.5 20v-2M13.5 20v-2"/>',
};

const icon = (name, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

const ALARM_STATES = {
  ALARM: { label: 'In alarm', tone: 'critical', icon: 'xCircle', rank: 0 },
  INSUFFICIENT_DATA: { label: 'Insufficient data', tone: 'muted', icon: 'clock', rank: 1 },
  OK: { label: 'OK', tone: 'good', icon: 'checkCircle', rank: 2 },
};
const alarmState = (a) => ALARM_STATES[a.state] || { label: a.state || 'Unknown', tone: 'muted', icon: 'clock', rank: 3 };

const badge = (h) => `<span class="badge tone-${h.tone}">${icon(h.icon)}<span>${esc(h.label)}</span></span>`;
const mark = (h) => `<span class="mark tone-${h.tone}" role="img" aria-label="${esc(h.label)}">${icon(h.icon)}</span>`;
const svc = (tone, ic) => `<span class="svc tone-${tone}">${icon(ic)}</span>`;

// ---------------------------------------------------------------------------
// App state

const app = {
  region: store.get('region', 'ap-southeast-1'),
  advanced: store.get('advanced', false),
  identity: null,
  keyInfo: null,
};

// What the IAM user may use, found by one harmless read per service (cached 10 minutes).
async function loadAccess(region) {
  return memo(`access:${region}`, 600e3, async () => aws.checkAccess(region, aws.principalOf((await ensureIdentity()).arn)));
}

async function ensureIdentity() {
  if (!app.identity) app.identity = await memo('identity', 3600e3, () => aws.whoAmI());
  return app.identity;
}

// ---------------------------------------------------------------------------
// Shared view pieces

function skelList(n = 4) {
  return `<div class="list" aria-busy="true">${Array.from({ length: n }, () => '<div class="row"><span class="row-main"><span class="skel w60"></span><span class="skel w40"></span></span></div>').join('')}</div>`;
}

function emptyState(title, body = '', action = '', ic = 'inbox', tone = 'muted') {
  return `<div class="state"><span class="state-ic tone-${tone}">${icon(ic)}</span><h3>${esc(title)}</h3>${body ? `<p>${body}</p>` : ''}${action}</div>`;
}

function errorState(err) {
  const denied = err.denied;
  return `<div class="state"><span class="state-ic tone-${denied ? 'warning' : 'critical'}">${icon(denied ? 'lock' : 'alert')}</span>
    <h3>${denied ? 'No permission' : 'This did not load'}</h3><p>${esc(err.message)}</p>
    <button class="btn" type="button" data-retry>${icon('refresh')}Try again</button></div>`;
}

const inlineError = (err) => `<div class="inline-err">${icon(err.denied ? 'lock' : 'alert')}<span>${esc(err.message)}</span></div>`;
const sectionHead = (title, link = '') => `<div class="section-head"><h3>${esc(title)}</h3>${link}</div>`;

function kvTable(rows) {
  const list = rows.filter(Boolean);
  if (!list.length) return '';
  return `<div class="list"><table class="kv"><tbody>${list.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`).join('')}</tbody></table></div>`;
}

const facts = (rows) => `<dl class="facts">${rows.filter(Boolean).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;

function chips(items, current, attr) {
  return `<div class="chips" role="group">${items.map(([value, label, n]) =>
    `<button class="chip" type="button" ${attr}="${esc(value)}" aria-pressed="${value === current}">${esc(label)}${n !== undefined ? `<span class="n">${esc(num(n))}</span>` : ''}</button>`).join('')}</div>`;
}

function bindChips(root, attr, fn) {
  const key = attr.replace(/^data-/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
  $$(`[${attr}]`, root).forEach((b) => b.addEventListener('click', () => {
    $$(`[${attr}]`, root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    fn(b.dataset[key]);
  }));
}

function searchBox(id, placeholder, value = '') {
  return `<label class="search">${icon('search')}<input id="${id}" type="search" placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"></label>`;
}

function pretty(text) {
  const t = String(text ?? '');
  const s = t.trim();
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try {
      return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
      // Not JSON after all.
    }
  }
  return t;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older WebViews: fall back to a temporary text area.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

async function copyWithToast(text, what = 'Copied') {
  toast((await copyText(text)) ? what : 'Could not copy on this device.');
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 2800);
}

function openSheet(html, onClick) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', close);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) return close();
    return onClick?.(e, close);
  });
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', close);
  document.body.append(wrap);
  return close;
}

function confirmSheet({ title, body, confirm, danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    openSheet(`<h2>${esc(title)}</h2><p>${body}</p>
      <div class="sheet-actions"><button class="btn" type="button" data-answer="no">Cancel</button>
      <button class="btn ${danger ? 'danger-solid' : 'primary'}" type="button" data-answer="yes">${esc(confirm)}</button></div>`, (e, close) => {
      const b = e.target.closest('[data-answer]');
      if (!b) return;
      answered = true;
      close();
      resolve(b.dataset.answer === 'yes');
    });
    // Resolve false if dismissed another way.
    const obs = new MutationObserver(() => {
      if (!document.querySelector('.sheet-wrap')) {
        obs.disconnect();
        if (!answered) resolve(false);
      }
    });
    obs.observe(document.body, { childList: true });
  });
}

function regionSheet() {
  const close = openSheet(`<h2>Region</h2>
    <div class="region-list">${REGIONS.map(([code, name]) => `<button class="region-opt" type="button" data-region="${code}" aria-pressed="${code === app.region}">
      <span class="mono">${code}</span><span>${esc(name)}</span>${code === app.region ? icon('check') : ''}</button>`).join('')}</div>`, (e) => {
    const b = e.target.closest('[data-region]');
    if (!b) return;
    setRegion(b.dataset.region);
    close();
  });
  setTimeout(() => $('.region-opt[aria-pressed="true"]')?.scrollIntoView({ block: 'center' }), 30);
}

function setRegion(code) {
  if (code === app.region) return;
  app.region = code;
  store.set('region', code);
  renderRegionPill();
  render();
}

function renderRegionPill() {
  $('#region-btn').innerHTML = `${icon('globe')}${esc(app.region)}`;
}

// ---------------------------------------------------------------------------
// Shell

function setHeader({ title, crumb = '', back = '' }) {
  $('#title').textContent = title;
  $('#crumb').textContent = crumb;
  $('#crumb').hidden = !crumb;
  const backBtn = $('#back-btn');
  backBtn.hidden = !back;
  if (back) backBtn.setAttribute('href', back);
  $('#menu-btn').hidden = !app.advanced || Boolean(back);
  document.title = `${title} · cloudBoard`;
}

// ---------------------------------------------------------------------------
// Advanced mode menu

const MENU = [
  ['Core', [
    ['#/', 'home', 'Home', 'home', null],
    ['#/s3', 'bucket', 'S3', 's3', 's3'],
    ['#/sqs', 'queue', 'SQS', 'sqs', 'sqs'],
    ['#/cw', 'watch', 'CloudWatch', 'cw', 'cloudwatch'],
  ]],
  ['Compute', [
    ['#/x/ecs', 'container', 'ECS', 'ecs', 'ecs'],
    ['#/x/ec2', 'server', 'EC2', 'ec2', 'ec2'],
    ['#/x/lambda', 'lambda', 'Lambda', 'lambda', 'lambda'],
  ]],
  ['Data and messaging', [
    ['#/x/dynamodb', 'table', 'DynamoDB', 'dynamodb', 'dynamodb'],
    ['#/x/rds', 'database', 'RDS', 'rds', 'rds'],
    ['#/x/sns', 'megaphone', 'SNS', 'sns', 'sns'],
  ]],
  ['Account', [
    ['#/x/cost', 'dollar', 'Cost', 'cost', 'ce'],
    ['#/x/iam', 'user', 'My permissions', 'iam', null],
    ['#/settings', 'settings', 'Settings', 'settings', null],
  ]],
];

function renderDrawer(access = null) {
  const dot = (key) => {
    if (!key) return '';
    const st = access ? access[key] : 'checking';
    if (st === 'denied') return `<span class="nav-access tone-critical" title="Not allowed">${icon('lock', 'ic sm')}</span>`;
    if (st === 'allowed') return '<span class="nav-access"><span class="dot tone-good"></span></span>';
    if (st === 'error') return '<span class="nav-access"><span class="dot tone-warning"></span></span>';
    if (st === 'unchecked') return '<span class="nav-access muted">$</span>';
    return '<span class="nav-access"><span class="dot tone-muted pulse-soft"></span></span>';
  };
  $('#drawer').innerHTML = `
    <div class="brand"><img class="brand-logo" src="/logo.svg" alt=""><span>cloud<b>Board</b></span><span class="tag orange" style="margin-left:auto">Advanced</span></div>
    ${MENU.map(([group, items]) => `<div class="nav-group"><div class="nav-head">${esc(group)}</div>
      ${items.map(([href, ic, label, key, svcKey]) => `<a class="nav-item ${access && access[svcKey] === 'denied' ? 'is-denied' : ''}" href="${href}" data-nav="${key}">${icon(ic)}<span>${esc(label)}</span>${dot(svcKey)}</a>`).join('')}
    </div>`).join('')}
`;
  markActiveNav();
}

function openDrawer() {
  renderDrawer(null);
  $('#drawer').classList.add('open');
  $('#scrim').hidden = false;
  loadAccess(app.region).then((res) => { if ($('#drawer').classList.contains('open')) renderDrawer(res); }).catch(() => renderDrawer({}));
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#scrim').hidden = true;
}

// Helpers handed to the advanced views (built on first use so every helper is defined).
let helpers = null;
function H() {
  if (!helpers) {
    helpers = {
      $, $$, esc, enc, icon, svc, mark, badge, skelList, emptyState, errorState, inlineError, sectionHead, kvTable, facts,
      chips, bindChips, searchBox, tile, chartPanel, drawMetricPanels, rangeChips, rangeMs, setHeader, ago, fmtDate, bytes,
      num, plural, debounce, memo, copyWithToast, toast, store, app, ensureIdentity, aws, formatSeconds, formatValue,
      lineChart, mapLimit, regionName, loadAccess, forget: (k) => memoStore.delete(k),
    };
  }
  return helpers;
}

function navKey(path) {
  if (path === '/') return 'home';
  if (path.startsWith('/s3')) return 's3';
  if (path.startsWith('/sqs')) return 'sqs';
  if (path.startsWith('/cw')) return 'cw';
  if (path.startsWith('/settings')) return 'settings';
  const m = /^\/x\/([^/]+)/.exec(path);
  return m ? m[1] : '';
}

function renderTabbar() {
  const tab = (href, ic, label, key) => `<a class="tab" href="${href}" data-nav="${key}"><span class="tab-ic">${icon(ic)}</span><span>${esc(label)}</span></a>`;
  $('#tabbar').innerHTML = `
    ${tab('#/', 'home', 'Home', 'home')}
    ${tab('#/s3', 'bucket', 'S3', 's3')}
    ${tab('#/sqs', 'queue', 'SQS', 'sqs')}
    ${tab('#/cw', 'watch', 'CloudWatch', 'cw')}`;
  markActiveNav();
}

function markActiveNav() {
  const key = navKey(currentPath());
  for (const a of $$('[data-nav]')) {
    if (a.dataset.nav === key) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

// Theme: 'system' (default) follows the phone; 'light' and 'dark' force one.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(choice = store.get('theme', 'system')) {
  const dark = choice === 'dark' || (choice !== 'light' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#f2f3f3');
  // Status bar icons: light icons on the dark theme, dark icons on the light one.
  if (NATIVE) SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => {});
}

darkQuery.addEventListener('change', () => applyTheme());

// ---------------------------------------------------------------------------
// Pins. Buckets are global; everything in CloudWatch is per region.

const pins = {
  key: (kind, region) => (kind.startsWith('s3') ? `pins:${kind}` : `pins:${kind}:${region}`),
  list: (kind, region) => store.get(pins.key(kind, region), []),
  has: (kind, region, id) => pins.list(kind, region).includes(id),
  toggle(kind, region, id) {
    const list = pins.list(kind, region);
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    else list.unshift(id);
    store.set(pins.key(kind, region), list);
    return i < 0;
  },
};

/** Splits items into pinned (in pin order) and the rest. */
function pinSplit(items, idOf, kind, region) {
  const order = pins.list(kind, region);
  const byId = new Map(items.map((x) => [idOf(x), x]));
  const pinned = order.map((id) => byId.get(id)).filter(Boolean);
  const set = new Set(order);
  return { pinned, rest: items.filter((x) => !set.has(idOf(x))) };
}

/** Marks a row as pinnable: a long press on it opens the pin sheet. */
function pinRow(rowHtml, kind, region, id) {
  return rowHtml.replace('<a class="row"', `<a class="row" data-pin-kind="${esc(kind)}" data-pin-region="${esc(region)}" data-pin-id="${esc(id)}"`);
}

function pinSheet(row) {
  const { pinKind: kind, pinRegion: region, pinId: id } = row.dataset;
  const label = row.querySelector('.row-title')?.textContent.trim() || id;
  const on = pins.has(kind, region, id);
  const close = openSheet(`<h2 class="sheet-title">${esc(label)}</h2>
    <div class="sheet-opts">
      <button class="sheet-opt" type="button" data-opt="pin">${icon('pin')}<span>${on ? 'Unpin' : 'Pin to top'}</span></button>
      <button class="sheet-opt" type="button" data-opt="copy">${icon('copy')}<span>Copy name</span></button>
    </div>`, (e) => {
    const b = e.target.closest('[data-opt]');
    if (!b) return;
    close();
    if (b.dataset.opt === 'pin') {
      toast(pins.toggle(kind, region, id) ? 'Pinned' : 'Unpinned');
      current.onPins?.();
    } else {
      copyWithToast(id.startsWith('[') ? label : id, 'Copied');
    }
  });
}

// One set of listeners on the view for the whole app (views re-render inside it).
function bindLongPress() {
  const view = $('#view');
  let timer = 0;
  let start = [0, 0];
  let held = null; // the row under a press that is still down
  let fired = false;
  const clear = () => {
    clearTimeout(timer);
    timer = 0;
  };
  const fire = (row) => {
    clear();
    if (fired) return;
    fired = true;
    navigator.vibrate?.(12);
    pinSheet(row);
  };
  view.addEventListener('pointerdown', (e) => {
    held = e.target.closest('[data-pin-kind]');
    fired = false;
    if (!held) return;
    start = [e.clientX, e.clientY];
    timer = setTimeout(() => fire(held), 450);
  });
  view.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 10) clear();
  });
  // By the time the finger lifts it is over the sheet, so these listen on the document.
  ['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, () => {
    clear();
    held = null;
  }));
  // Android starts a text selection, then sends contextmenu, during the hold, after the sheet
  // has opened under the finger. Left alone, the WebView selects text in the sheet.
  document.addEventListener('selectstart', (e) => {
    if (held) e.preventDefault();
  });
  document.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('[data-pin-kind]') || held;
    if (!row) return;
    e.preventDefault();
    fire(row);
  });
  // The tap that ends a long press must not open the row.
  view.addEventListener('click', (e) => {
    if (fired && e.target.closest('[data-pin-kind]')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

const listBlock = (rows) => (rows.length ? `<div class="list">${rows.join('')}</div>` : '');

// ---------------------------------------------------------------------------
// Router

const ROUTES = [
  ['/', viewHome],
  ['/s3', viewBuckets],
  ['/s3/b/:bucket', viewBucket],
  ['/s3/o/:bucket', viewObject],
  ['/sqs', viewQueues],
  ['/sqs/q/:queue', viewQueue],
  ['/cw', viewAlarms],
  ['/cw/alarm/:name', viewAlarm],
  ['/cw/metrics', viewNamespaces],
  ['/cw/ns/:ns', viewNamespace],
  ['/cw/m', viewMetric],
  ['/cw/logs', viewLogGroups],
  ['/cw/group', viewLogGroup],
  ['/cw/stream', viewLogStream],
  ['/settings', viewSettings],
  ['/x/ecs', 'viewEcs'],
  ['/x/ecs/c/:cluster', 'viewEcsCluster'],
  ['/x/ecs/s/:cluster/:service', 'viewEcsService'],
  ['/x/ec2', 'viewEc2'],
  ['/x/ec2/:id', 'viewEc2Instance'],
  ['/x/lambda', 'viewLambda'],
  ['/x/lambda/:name', 'viewLambdaFn'],
  ['/x/dynamodb', 'viewDynamo'],
  ['/x/dynamodb/:table', 'viewDynamoTable'],
  ['/x/rds', 'viewRds'],
  ['/x/rds/c/:id', 'viewRdsCluster'],
  ['/x/rds/:id', 'viewRdsInstance'],
  ['/x/sns', 'viewSns'],
  ['/x/sns/:topic', 'viewSnsTopic'],
  ['/x/cost', 'viewCost'],
  ['/x/iam', 'viewIam'],
].map(([pattern, v]) => {
  const view = typeof v === 'string' ? (ctx) => adv[v](ctx, H()) : v;
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  return { re, keys, view };
});

function currentPath() {
  const raw = location.hash.replace(/^#/, '') || '/';
  return raw.split('?')[0].replace(/\/+$/, '') || '/';
}

let current = { id: 0, cleanups: [] };

async function render() {
  closeDrawer();
  for (const fn of current.cleanups) {
    try {
      fn();
    } catch {
      // Ignore cleanup errors from a view that is going away.
    }
  }
  const id = current.id + 1;
  current = { id, cleanups: [], onPins: null };

  const raw = location.hash.replace(/^#/, '') || '/';
  const query = new URLSearchParams(raw.split('?')[1] || '');
  const path = currentPath();
  let match = null;
  const params = {};
  for (const r of ROUTES) {
    const m = r.re.exec(path);
    if (m) {
      match = r;
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      break;
    }
  }

  const root = $('#view');
  root.innerHTML = '';
  window.scrollTo(0, 0);
  markActiveNav();

  const ctx = {
    params,
    query,
    root,
    path,
    region: app.region,
    stale: () => current.id !== id,
    cleanup: (fn) => current.cleanups.push(fn),
    onPins(fn) {
      if (current.id === id) current.onPins = fn;
    },
    every(ms, fn) {
      const t = setInterval(() => { if (!document.hidden && current.id === id) fn(); }, ms);
      current.cleanups.push(() => clearInterval(t));
    },
    replaceQuery(next) {
      const qs = new URLSearchParams(next);
      for (const [k, v] of [...qs]) if (!v) qs.delete(k);
      const s = qs.toString();
      history.replaceState(null, '', `#${path}${s ? `?${s}` : ''}`);
    },
  };

  if (!match) {
    setHeader({ title: 'Not found' });
    root.innerHTML = emptyState('This page does not exist.', '', '<a class="btn" href="#/">Go home</a>');
    return;
  }
  const refresh = $('#refresh-btn');
  refresh.classList.add('spin');
  try {
    await match.view(ctx);
  } catch (err) {
    if (ctx.stale() || err.code === 'no_credentials') return;
    console.error(err);
    if (err.auth) {
      showLogin(err.message);
      return;
    }
    root.innerHTML = errorState(err);
    $('[data-retry]', root)?.addEventListener('click', () => {
      memoStore.clear();
      render();
    });
  } finally {
    if (!ctx.stale()) refresh.classList.remove('spin');
  }
}

// ---------------------------------------------------------------------------
// Charts backed by CloudWatch metrics

const RANGES = [['1h', 1], ['3h', 3], ['12h', 12], ['1d', 24], ['1w', 168], ['4w', 672]].map(([k, h]) => [k, h * 3600e3]);
const rangeMs = (key, fallback = '3h') => (RANGES.find(([k]) => k === key) || RANGES.find(([k]) => k === fallback))[1];
const rangeChips = (current, keys = ['1h', '3h', '12h', '1d', '1w']) => chips(RANGES.filter(([k]) => keys.includes(k)).map(([k]) => [k, k]), current, 'data-range');

const FORMATS = {
  count: { value: (v) => formatValue(v), axis: undefined },
  bytes: { value: (v) => bytes(v), axis: (v) => bytes(v) },
  seconds: { value: (v) => formatSeconds(v), axis: (v) => formatSeconds(v) },
};

function chartPanel(id, title) {
  return `<div class="panel"><div class="chart-head"><span class="chart-title">${esc(title)}</span><span class="chart-last" data-last="${id}"></span></div>
    <div class="chart-box" id="${id}"><span class="skel chart-skel"></span></div></div>`;
}

/**
 * panels: [{ id, format?, threshold?, series: [{ name, namespace, metric, dims, stat } | { name, expression }] }]
 * Loads every series in one GetMetricData call, then draws each panel.
 */
async function drawMetricPanels(ctx, region, panels, range, minPeriod = 60) {
  const end = Date.now();
  const start = end - range;
  const period = aws.periodFor(range, minPeriod);
  const queries = [];
  panels.forEach((p, i) => p.series.forEach((s, j) => {
    const { name, ...q } = s;
    queries.push({ id: `q${i}_${j}`, label: name, period, ...q });
  }));
  let results;
  try {
    results = await aws.getMetricData(region, queries, start, end);
  } catch (err) {
    if (ctx.stale()) return;
    for (const p of panels) {
      const el = document.getElementById(p.id);
      if (el) el.innerHTML = inlineError(err);
    }
    return;
  }
  if (ctx.stale()) return;
  const byId = new Map(results.map((r) => [r.id, r]));
  panels.forEach((p, i) => {
    const el = document.getElementById(p.id);
    if (!el) return;
    const fmt = FORMATS[p.format || 'count'];
    const series = p.series.map((s, j) => ({ name: s.name, color: s.color, points: byId.get(`q${i}_${j}`)?.points || [] }));
    el.innerHTML = '';
    const chart = lineChart(el, {
      series,
      time: true,
      xMin: start,
      xMax: end,
      valueFormat: fmt.value,
      yFormat: fmt.axis,
      threshold: p.threshold,
      label: p.id,
    });
    ctx.cleanup(() => chart.destroy());
    const first = series[0]?.points;
    const lastEl = $(`[data-last="${p.id}"]`, ctx.root);
    if (lastEl && first?.length && series.length === 1) lastEl.textContent = fmt.value(first[first.length - 1][1]);
  });
}

// ---------------------------------------------------------------------------
// Data shared by several views

const loadBuckets = () => memo('buckets', 120e3, () => aws.listBuckets());
const loadAlarms = (region) => memo(`alarms:${region}`, 30e3, () => aws.describeAlarms(region));

function loadQueues(region) {
  return memo(`queues:${region}`, 30e3, async () => {
    const urls = await aws.listQueues(region);
    const attrs = await mapLimit(urls, 6, (u) => aws.queueAttributes(region, u));
    const queues = urls.map((url, i) => {
      const a = attrs[i].ok ? attrs[i].value : null;
      return {
        url,
        name: aws.queueName(url),
        attrs: a,
        error: attrs[i].ok ? null : attrs[i].error,
        fifo: aws.queueName(url).endsWith('.fifo'),
        visible: Number(a?.ApproximateNumberOfMessages || 0),
        inflight: Number(a?.ApproximateNumberOfMessagesNotVisible || 0),
        delayed: Number(a?.ApproximateNumberOfMessagesDelayed || 0),
      };
    });
    const dlqs = new Set();
    for (const q of queues) {
      const rp = parseJSON(q.attrs?.RedrivePolicy);
      if (rp?.deadLetterTargetArn) dlqs.add(String(rp.deadLetterTargetArn).split(':').pop());
    }
    for (const q of queues) q.isDlq = dlqs.has(q.name);
    return queues;
  });
}

function queueRow(q) {
  const tags = `${q.fifo ? '<span class="tag">FIFO</span>' : ''}${q.isDlq ? '<span class="tag red">DLQ</span>' : ''}`;
  const meta = q.error
    ? `<span>${icon('lock', 'ic sm')}No access to attributes</span>`
    : `<span>${num(q.inflight)} in flight</span>${q.delayed ? `<span>${num(q.delayed)} delayed</span>` : ''}${tags ? `<span>${tags}</span>` : ''}`;
  const cls = q.visible ? (q.isDlq ? 'bad' : 'hot') : '';
  return `<a class="row" href="#/sqs/q/${enc(q.name)}">
    ${svc(q.isDlq ? 'critical' : 'sqs', q.isDlq ? 'skull' : 'queue')}
    <span class="row-main"><span class="row-title">${esc(q.name)}</span><span class="row-meta">${meta}</span></span>
    <span class="row-side"><span class="side-val ${cls}">${q.error ? '-' : esc(num(q.visible))}</span><span class="side-key">available</span></span>
  </a>`;
}

function alarmRow(a) {
  const h = alarmState(a);
  const what = a.kind === 'composite' ? 'Composite alarm' : a.metric ? `${a.metric}${a.namespace ? ` · ${a.namespace}` : ''}` : 'Metric math';
  return `<a class="row" href="#/cw/alarm/${enc(a.name)}">
    ${mark(h)}
    <span class="row-main"><span class="row-title">${esc(a.name)}</span>
      <span class="row-meta"><span class="clip">${esc(what)}</span><span>${esc(h.label.toLowerCase())} ${esc(ago(a.updated))}</span></span></span>
    ${icon('chevron', 'ic chev')}
  </a>`;
}

// ---------------------------------------------------------------------------
// Home

function heroTrace(alarm, animate) {
  const d = 'M0 24 H92 l6 -4 l5 4 H124 l5 -18 l7 34 l6 -24 l5 8 H204 l5 -6 l5 6 H320';
  return `<svg class="ekg ${alarm ? 'ekg-alarm' : ''} ${animate ? 'draw' : ''}" viewBox="0 0 320 48" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" pathLength="1"/></svg>`;
}

function tile({ href = '', tone, ic, label, n, unit = '', sub = '' }) {
  const tag = href ? 'a' : 'div';
  return `<${tag} class="tile" ${href ? `href="${href}"` : ''} style="--tone:var(--${tone})">
    <span class="tile-top"><span>${esc(label)}</span>${icon(ic)}</span>
    <span class="tile-n">${n}${unit ? `<small>${esc(unit)}</small>` : ''}</span>
    ${sub ? `<span class="tile-sub">${esc(sub)}</span>` : ''}
  </${tag}>`;
}

async function viewHome(ctx) {
  setHeader({ title: 'Home', crumb: regionName(ctx.region) });
  ctx.root.innerHTML = `<section class="hero" id="hero"><span class="skel tall w80"></span><span class="skel w60"></span></section>
    <div class="tiles" id="tiles">${'<span class="skel block"></span>'.repeat(4)}</div><div id="home-lists"></div>`;
  let painted = false;

  const load = async () => {
    const [ident, alarms, queues, buckets] = await Promise.allSettled([
      ensureIdentity(), loadAlarms(ctx.region), loadQueues(ctx.region), loadBuckets(),
    ]);
    if (ident.status === 'rejected' && ident.reason?.auth) throw ident.reason;
    return { alarms, queues, buckets };
  };

  const paint = ({ alarms, queues, buckets }) => {
    const A = alarms.status === 'fulfilled' ? alarms.value : null;
    const Q = queues.status === 'fulfilled' ? queues.value : null;
    const B = buckets.status === 'fulfilled' ? buckets.value : null;
    const firing = A ? A.filter((a) => a.state === 'ALARM') : [];
    const waiting = Q ? Q.reduce((s, q) => s + q.visible, 0) : 0;
    const inflight = Q ? Q.reduce((s, q) => s + q.inflight, 0) : 0;
    const dlqHot = Q ? Q.filter((q) => q.isDlq && q.visible > 0) : [];

    let lead;
    if (!A) lead = `Your AWS at a glance.`;
    else if (firing.length) lead = `<em class="bad">${esc(plural(firing.length, 'alarm'))}</em> firing in ${esc(regionName(ctx.region))}.`;
    else lead = `All clear in <em>${esc(regionName(ctx.region))}</em>.`;
    const sub = [];
    if (Q) sub.push(Q.length ? `${plural(waiting, 'message')} waiting across ${plural(Q.length, 'queue')}.` : 'No SQS queues in this region.');
    if (dlqHot.length) sub.push(`${plural(dlqHot.length, 'dead-letter queue')} ${dlqHot.length === 1 ? 'has' : 'have'} messages.`);
    const time = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    $('#hero', ctx.root).innerHTML = `${heroTrace(firing.length > 0, !painted)}
      <h2>${lead}</h2>${sub.length ? `<p>${esc(sub.join(' '))}</p>` : ''}
      <p class="stamp">Updated ${esc(time)}</p>`;
    painted = true;

    const dash = '-';
    $('#tiles', ctx.root).innerHTML = [
      tile({ href: '#/cw', tone: firing.length ? 'critical' : 'good', ic: 'bell', label: 'Alarms', n: A ? num(firing.length) : dash, unit: A ? ` / ${num(A.length)}` : '', sub: A ? (firing.length ? 'firing now' : 'none firing') : 'no access' }),
      tile({ href: '#/sqs', tone: 'smile', ic: 'inbox', label: 'Messages', n: Q ? num(waiting) : dash, sub: Q ? `${num(inflight)} in flight` : 'no access' }),
      tile({ href: '#/sqs', tone: 'sqs', ic: 'queue', label: 'Queues', n: Q ? num(Q.length) : dash, sub: Q ? `${num(Q.filter((q) => q.isDlq).length)} dead-letter` : 'no access' }),
      tile({ href: '#/s3', tone: 's3', ic: 'bucket', label: 'Buckets', n: B ? num(B.length) : dash, sub: B ? `${new Set(B.map((b) => b.region).filter(Boolean)).size || 1} regions` : 'no access' }),
    ].join('');

    const busiest = Q ? Q.filter((q) => q.visible > 0 && !q.isDlq).sort((a, b) => b.visible - a.visible).slice(0, 5) : [];
    const errs = [
      [alarms, 'CloudWatch alarms'], [queues, 'SQS'], [buckets, 'S3'],
    ].filter(([r]) => r.status === 'rejected');
    $('#home-lists', ctx.root).innerHTML = `
      ${firing.length ? `${sectionHead('Firing alarms', '<a href="#/cw">All alarms</a>')}<div class="list">${firing.map(alarmRow).join('')}</div>` : ''}
      ${dlqHot.length ? `${sectionHead('Needs a look')}<div class="list">${dlqHot.map(queueRow).join('')}</div>` : ''}
      ${Q ? `${sectionHead('Busiest queues', '<a href="#/sqs">All queues</a>')}${busiest.length ? `<div class="list">${busiest.map(queueRow).join('')}</div>` : `<p class="note">${Q.length ? 'Every queue is empty.' : 'No queues in this region.'}</p>`}` : ''}
      ${errs.map(([r, label]) => `${sectionHead(label)}${inlineError(r.reason)}`).join('')}`;
  };

  const refresh = async (fresh) => {
    if (fresh) ['alarms', 'queues'].forEach((k) => memoStore.delete(`${k}:${ctx.region}`));
    const data = await load();
    if (!ctx.stale()) paint(data);
  };
  await refresh(false);
  ctx.every(60000, () => refresh(true).catch((err) => console.warn('Home refresh failed', err)));
}

// ---------------------------------------------------------------------------
// S3

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico']);
const TEXT_EXT = new Set(['txt', 'log', 'json', 'jsonl', 'ndjson', 'csv', 'tsv', 'md', 'yml', 'yaml', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'conf', 'cfg', 'ini', 'toml', 'env', 'sql', 'java', 'kt', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'properties', 'gradle', 'tf', 'hcl', 'out', 'err', 'srt', 'vtt', 'gitignore', 'dockerfile', 'lock']);
const ARCHIVE_EXT = new Set(['zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar', 'zst', 'parquet', 'avro', 'orc']);
const extOf = (key) => {
  const name = key.split('/').pop().toLowerCase();
  return name.includes('.') ? name.split('.').pop() : name;
};
const fileIcon = (key) => {
  const e = extOf(key);
  if (IMAGE_EXT.has(e)) return 'image';
  if (TEXT_EXT.has(e)) return 'fileText';
  if (ARCHIVE_EXT.has(e)) return 'archive';
  return 'file';
};
const bucketHref = (bucket, prefix = '') => `#/s3/b/${enc(bucket)}${prefix ? `?p=${enc(prefix)}` : ''}`;
const objectHref = (bucket, key) => `#/s3/o/${enc(bucket)}?k=${enc(key)}`;

async function viewBuckets(ctx) {
  setHeader({ title: 'S3', crumb: 'Buckets in every region' });
  ctx.root.innerHTML = skelList(6);
  const buckets = await loadBuckets();
  if (ctx.stale()) return;
  if (!buckets.length) {
    ctx.root.innerHTML = emptyState('No buckets', 'This account has no S3 buckets yet.', '', 'bucket', 's3');
    return;
  }
  const counts = new Map();
  for (const b of buckets) counts.set(b.region || 'unknown', (counts.get(b.region || 'unknown') || 0) + 1);
  const regions = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  let filter = ctx.query.get('r') || 'all';
  let q = ctx.query.get('q') || '';

  ctx.root.innerHTML = `
    <div class="toolbar">${searchBox('bq', 'Search buckets', q)}</div>
    ${regions.length > 1 ? chips([['all', 'All', buckets.length], ...regions.map(([r, n]) => [r, r, n])], filter, 'data-r') : ''}
    <p class="count" id="bcount"></p><div id="blist"></div>`;

  const row = (b) => pinRow(`<a class="row" href="${bucketHref(b.name)}">
      ${svc('s3', 'bucket')}
      <span class="row-main"><span class="row-title">${esc(b.name)}</span>
        <span class="row-meta">${b.region ? `<span>${icon('globe', 'ic sm')}${esc(b.region)}</span>` : ''}<span>created ${esc(ago(b.created))}</span></span></span>${icon('chevron', 'ic chev')}</a>`, 's3bucket', '', b.name);
  const paint = () => {
    const needle = q.trim().toLowerCase();
    const matches = buckets.filter((b) => !needle || b.name.toLowerCase().includes(needle)).sort((a, b) => a.name.localeCompare(b.name));
    const { pinned, rest } = pinSplit(matches, (b) => b.name, 's3bucket', '');
    const list = rest.filter((b) => filter === 'all' || (b.region || 'unknown') === filter);
    $('#bcount', ctx.root).textContent = plural(pinned.length + list.length, 'bucket');
    $('#blist', ctx.root).innerHTML = `
      ${pinned.length ? `${sectionHead('Pinned')}${listBlock(pinned.map(row))}${sectionHead('All buckets')}` : ''}
      ${list.length ? listBlock(list.map(row)) : `<p class="note">${pinned.length ? 'No other buckets match.' : 'No buckets match.'}</p>`}`;
    ctx.replaceQuery({ q, r: filter === 'all' ? '' : filter });
  };
  paint();
  ctx.onPins(paint);
  bindChips(ctx.root, 'data-r', (v) => { filter = v; paint(); });
  $('#bq', ctx.root).addEventListener('input', debounce((e) => { q = e.target.value; paint(); }, 120));
}

function pathBar(bucket, prefix) {
  const parts = prefix.split('/').filter(Boolean);
  let acc = '';
  const segs = parts.map((p) => {
    acc += `${p}/`;
    return `<span class="sep">/</span><a href="${bucketHref(bucket, acc)}">${esc(p)}</a>`;
  });
  return `<nav class="pathbar" aria-label="Folder path"><a href="${bucketHref(bucket)}">${esc(bucket)}</a>${segs.join('')}</nav>`;
}

async function viewBucket(ctx) {
  const bucket = ctx.params.bucket;
  const prefix = ctx.query.get('p') || '';
  const parts = prefix.split('/').filter(Boolean);
  const parent = parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '';
  setHeader({
    title: parts.length ? parts[parts.length - 1] : bucket,
    crumb: parts.length ? bucket : 'S3 bucket',
    back: parts.length ? bucketHref(bucket, parent) : '#/s3',
  });
  const objKind = `s3obj:${bucket}`;
  ctx.root.innerHTML = `${pathBar(bucket, prefix)}<div id="binfo"></div>
    <div class="toolbar">${searchBox('oq', 'Filter this folder')}</div>
    <p class="count" id="ocount"></p><div id="olist">${skelList(6)}</div><div class="more" id="omore"></div>`;

  if (!prefix) loadBucketInfo(ctx, bucket);

  const folders = [];
  const objects = [];
  let next = '';
  let q = '';
  let loaded = false;
  const folderRow = (f, label) => pinRow(`<a class="row" href="${bucketHref(bucket, f)}">${svc('s3', 'folder')}
    <span class="row-main"><span class="row-title">${esc(label)}</span></span>${icon('chevron', 'ic chev')}</a>`, objKind, '', f);
  const fileRow = (key, label, o = null) => pinRow(`<a class="row" href="${objectHref(bucket, key)}">${svc('muted', fileIcon(key))}
    <span class="row-main"><span class="row-title">${esc(label)}</span>
      ${o ? `<span class="row-meta"><span>${esc(bytes(o.size))}</span><span>${esc(ago(o.modified))}</span>${o.storageClass && o.storageClass !== 'STANDARD' ? `<span class="tag">${esc(o.storageClass)}</span>` : ''}</span>` : ''}</span></a>`, objKind, '', key);
  const paint = () => {
    const needle = q.trim().toLowerCase();
    const pinnedSet = new Set(pins.list(objKind, ''));
    // Pinned items anywhere below this folder float to the top, shown with their relative path.
    const pinnedHere = pins.list(objKind, '').filter((k) => k !== prefix && k.startsWith(prefix) && (!needle || k.toLowerCase().includes(needle)));
    const fs = folders.filter((f) => !pinnedSet.has(f) && (!needle || f.toLowerCase().includes(needle)));
    const os = objects.filter((o) => o.key !== prefix && !pinnedSet.has(o.key) && (!needle || o.key.toLowerCase().includes(needle)));
    const byKey = new Map(objects.map((o) => [o.key, o]));
    $('#ocount', ctx.root).textContent = `${plural(fs.length, 'folder')}, ${plural(os.length, 'file')}${next ? ' loaded so far' : ''}`;
    const rows = [
      ...fs.map((f) => folderRow(f, f.slice(prefix.length).replace(/\/$/, ''))),
      ...os.map((o) => fileRow(o.key, o.key.slice(prefix.length), o)),
    ];
    const pinnedRows = pinnedHere.map((k) => (k.endsWith('/') ? folderRow(k, k.slice(prefix.length).replace(/\/$/, '')) : fileRow(k, k.slice(prefix.length), byKey.get(k))));
    $('#olist', ctx.root).innerHTML = `
      ${pinnedRows.length ? `${sectionHead('Pinned')}${listBlock(pinnedRows)}${rows.length ? sectionHead(prefix ? 'In this folder' : 'In this bucket') : ''}` : ''}
      ${rows.length ? listBlock(rows) : pinnedRows.length ? '' : needle ? '<p class="note">Nothing here matches.</p>' : emptyState('This folder is empty', '', '', 'folder', 's3')}`;
    $('#omore', ctx.root).innerHTML = next ? '<button class="btn" type="button" id="loadmore">Load more</button>' : '';
    $('#loadmore', ctx.root)?.addEventListener('click', (e) => {
      e.target.disabled = true;
      loadPage().catch((err) => toast(err.message));
    });
  };
  const loadPage = async () => {
    const page = await aws.listObjects(bucket, prefix, next);
    if (ctx.stale()) return;
    folders.push(...page.folders);
    objects.push(...page.objects);
    next = page.next;
    loaded = true;
    paint();
  };
  $('#oq', ctx.root).addEventListener('input', debounce((e) => { q = e.target.value; paint(); }, 120));
  ctx.onPins(() => { if (loaded) paint(); });
  await loadPage();
}

async function loadBucketInfo(ctx, bucket) {
  const el = $('#binfo', ctx.root);
  el.innerHTML = '<span class="skel block"></span>';
  try {
    const info = await aws.bucketInfo(bucket);
    if (ctx.stale()) return;
    const show = (v) => (v && typeof v === 'object' && v.error ? '<span class="muted">no access</span>' : esc(v));
    const fourDays = 4 * 86400e3;
    let size = '<span class="skel w60"></span>';
    let count = '<span class="skel w40"></span>';
    const draw = () => {
      el.innerHTML = facts([
        ['Region', `<span class="mono">${esc(info.region)}</span>`],
        ['Size', size],
        ['Objects', count],
        ['Versioning', show(info.versioning)],
        ['Encryption', show(info.encryption)],
        ['Public access', show(info.publicAccess)],
      ]);
    };
    draw();
    try {
      const [s, n] = await aws.getMetricData(info.region, [
        { id: 'size', expression: `SUM(SEARCH('{AWS/S3,BucketName,StorageType} MetricName="BucketSizeBytes" BucketName="${bucket}"', 'Average', 86400))`, period: 86400 },
        { id: 'count', namespace: 'AWS/S3', metric: 'NumberOfObjects', dims: [{ name: 'BucketName', value: bucket }, { name: 'StorageType', value: 'AllStorageTypes' }], stat: 'Average', period: 86400 },
      ], Date.now() - fourDays, Date.now());
      const last = (r) => (r?.points?.length ? r.points[r.points.length - 1][1] : null);
      size = last(s) === null ? '<span class="muted">not reported yet</span>' : esc(bytes(last(s)));
      count = last(n) === null ? '<span class="muted">not reported yet</span>' : esc(num(Math.round(last(n))));
    } catch {
      size = '<span class="muted">no access</span>';
      count = '<span class="muted">no access</span>';
    }
    if (!ctx.stale()) draw();
  } catch (err) {
    if (!ctx.stale()) el.innerHTML = '';
  }
}

const isTextType = (ct) => /^text\/|json|xml|javascript|yaml|x-sh|csv|x-www-form/i.test(ct || '');

async function viewObject(ctx) {
  const bucket = ctx.params.bucket;
  const key = ctx.query.get('k') || '';
  const name = key.split('/').pop() || key;
  const prefix = key.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : '';
  setHeader({ title: name, crumb: bucket, back: bucketHref(bucket, prefix) });
  ctx.root.innerHTML = `${pathBar(bucket, prefix)}${skelList(3)}`;
  const h = await aws.headObject(bucket, key);
  if (ctx.stale()) return;

  const size = Number(h['content-length'] || 0);
  const type = h['content-type'] || '';
  const ext = extOf(key);
  const isImage = (IMAGE_EXT.has(ext) || /^image\//.test(type)) && size <= 8 * 1024 * 1024;
  const isText = !h['content-encoding']?.includes('gzip') && (TEXT_EXT.has(ext) || isTextType(type));
  const meta = Object.entries(h).filter(([k]) => k.startsWith('x-amz-meta-')).map(([k, v]) => [k.slice(11), esc(v)]);
  const s3uri = `s3://${bucket}/${key}`;

  ctx.root.innerHTML = `
    ${pathBar(bucket, prefix)}
    <section class="head">
      <div class="head-line">${svc('s3', fileIcon(key))}${type ? `<span class="tag">${esc(type)}</span>` : ''}</div>
      <h2 class="head-name">${esc(name)}</h2>
      <p class="head-sub mono">${esc(s3uri)}</p>
      ${facts([
        ['Size', esc(bytes(size))],
        ['Modified', esc(fmtDate(h['last-modified']))],
        ['Storage class', esc(h['x-amz-storage-class'] || 'STANDARD')],
        ['Encryption', esc(h['x-amz-server-side-encryption'] || 'None')],
      ])}
      <div class="actions">
        <button class="btn primary" type="button" data-act="open">${icon('external')}Open</button>
        <button class="btn" type="button" data-act="download">${icon('download')}Download</button>
        <button class="btn" type="button" data-act="link">${icon('link')}Copy link</button>
        <button class="btn ghost" type="button" data-act="uri">${icon('copy')}S3 URI</button>
      </div>
    </section>
    ${sectionHead('Preview')}<div id="preview"></div>
    ${sectionHead('Details')}
    ${kvTable([
      ['ETag', `<span class="mono">${esc((h.etag || '').replace(/"/g, ''))}</span>`],
      h['x-amz-version-id'] ? ['Version', `<span class="mono">${esc(h['x-amz-version-id'])}</span>`] : null,
      h['cache-control'] ? ['Cache-Control', esc(h['cache-control'])] : null,
      h['content-encoding'] ? ['Content-Encoding', esc(h['content-encoding'])] : null,
      h['content-disposition'] ? ['Content-Disposition', esc(h['content-disposition'])] : null,
      h['x-amz-server-side-encryption-aws-kms-key-id'] ? ['KMS key', `<span class="mono">${esc(h['x-amz-server-side-encryption-aws-kms-key-id'])}</span>`] : null,
    ])}
    ${meta.length ? `${sectionHead('Metadata')}${kvTable(meta)}` : ''}`;

  $$('[data-act]', ctx.root).forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.act;
    if (act === 'uri') return copyWithToast(s3uri, 'S3 URI copied');
    b.disabled = true;
    try {
      const url = await aws.presignObject(bucket, key, { download: act === 'download' });
      if (act === 'link') await copyWithToast(url, 'Link copied (valid 15 min)');
      else await aws.openExternal(url);
    } catch (err) {
      toast(err.message);
    } finally {
      b.disabled = false;
    }
    return undefined;
  }));

  const pv = $('#preview', ctx.root);
  if (!size) {
    pv.innerHTML = '<p class="note">This file is empty.</p>';
  } else if (isImage) {
    pv.innerHTML = '<span class="skel block"></span>';
    try {
      const r = await aws.readObject(bucket, key, size, 'base64');
      if (ctx.stale()) return;
      const mime = /^image\//.test(type) ? type : ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      pv.innerHTML = `<img class="preview-img" alt="${esc(name)}" src="data:${esc(mime)};base64,${r.body}">`;
    } catch (err) {
      pv.innerHTML = inlineError(err);
    }
  } else if (isText) {
    pv.innerHTML = '<span class="skel block"></span>';
    const LIMIT = 256 * 1024;
    try {
      const r = await aws.readObject(bucket, key, Math.min(size, LIMIT));
      if (ctx.stale()) return;
      const cut = size > LIMIT;
      pv.innerHTML = `<pre class="code">${esc(cut ? r.body : pretty(r.body))}</pre>${cut ? `<p class="note">Showing the first ${bytes(LIMIT)} of ${bytes(size)}.</p>` : ''}`;
    } catch (err) {
      pv.innerHTML = inlineError(err);
    }
  } else {
    pv.innerHTML = `<p class="note">${size > 8 * 1024 * 1024 && IMAGE_EXT.has(ext) ? 'Too large to preview.' : 'No preview for this file type.'}</p>`;
  }
}

// ---------------------------------------------------------------------------
// SQS

async function viewQueues(ctx) {
  setHeader({ title: 'SQS', crumb: `Queues in ${regionName(ctx.region)}` });
  ctx.root.innerHTML = skelList(6);
  const queues = await loadQueues(ctx.region);
  if (ctx.stale()) return;
  if (!queues.length) {
    ctx.root.innerHTML = emptyState('No queues here', `There are no SQS queues in <b>${esc(ctx.region)}</b>. Try another region from the button at the top.`, '<button class="btn" type="button" id="pick">Change region</button>', 'queue', 'sqs');
    $('#pick', ctx.root).addEventListener('click', regionSheet);
    return;
  }
  let filter = ctx.query.get('f') || 'all';
  let q = ctx.query.get('q') || '';
  const n = {
    all: queues.length,
    busy: queues.filter((x) => x.visible > 0).length,
    dlq: queues.filter((x) => x.isDlq).length,
    fifo: queues.filter((x) => x.fifo).length,
  };
  const total = queues.reduce((s, x) => s + x.visible, 0);
  const inflight = queues.reduce((s, x) => s + x.inflight, 0);
  ctx.root.innerHTML = `
    <div class="tiles three" style="margin-top:4px">
      ${tile({ tone: 'smile', ic: 'inbox', label: 'Available', n: num(total) })}
      ${tile({ tone: 'info', ic: 'clock', label: 'In flight', n: num(inflight) })}
      ${tile({ tone: 'sqs', ic: 'queue', label: 'Queues', n: num(queues.length) })}
    </div>
    <div class="toolbar" style="margin-top:14px">${searchBox('qq', 'Search queues', q)}</div>
    ${chips([['all', 'All', n.all], ['busy', 'With messages', n.busy], ['dlq', 'Dead-letter', n.dlq], ...(n.fifo ? [['fifo', 'FIFO', n.fifo]] : [])], filter, 'data-f')}
    <div id="qlist"></div>`;
  const paint = () => {
    const needle = q.trim().toLowerCase();
    const list = queues
      .filter((x) => filter === 'all' || (filter === 'busy' && x.visible > 0) || (filter === 'dlq' && x.isDlq) || (filter === 'fifo' && x.fifo))
      .filter((x) => !needle || x.name.toLowerCase().includes(needle))
      .sort((a, b) => (filter === 'busy' ? b.visible - a.visible : a.name.localeCompare(b.name)));
    $('#qlist', ctx.root).innerHTML = list.length ? `<div class="list">${list.map(queueRow).join('')}</div>` : '<p class="note">No queues match.</p>';
    ctx.replaceQuery({ q, f: filter === 'all' ? '' : filter });
  };
  paint();
  bindChips(ctx.root, 'data-f', (v) => { filter = v; paint(); });
  $('#qq', ctx.root).addEventListener('input', debounce((e) => { q = e.target.value; paint(); }, 120));
}

async function viewQueue(ctx) {
  const name = ctx.params.queue;
  setHeader({ title: name, crumb: `SQS · ${ctx.region}`, back: '#/sqs' });
  ctx.root.innerHTML = skelList(4);
  const ident = await ensureIdentity();
  const listed = (await loadQueues(ctx.region).catch(() => [])).find((x) => x.name === name);
  const url = listed?.url || aws.queueUrl(ctx.region, ident.account, name);
  const a = await aws.queueAttributes(ctx.region, url);
  if (ctx.stale()) return;

  const fifo = name.endsWith('.fifo');
  const rp = parseJSON(a.RedrivePolicy);
  const dlqName = rp?.deadLetterTargetArn ? String(rp.deadLetterTargetArn).split(':').pop() : '';
  const sse = a.KmsMasterKeyId ? 'KMS' : a.SqsManagedSseEnabled === 'true' ? 'SQS managed' : 'None';
  let range = ctx.query.get('r') || '3h';

  ctx.root.innerHTML = `
    <section class="head">
      <div class="head-line">${svc('sqs', 'queue')}<span class="tag pink">${fifo ? 'FIFO' : 'Standard'}</span>${listed?.isDlq ? '<span class="tag red">Dead-letter queue</span>' : ''}<span class="tag">${icon('lock', 'ic sm')} ${esc(sse)}</span></div>
      <h2 class="head-name">${esc(name)}</h2>
      <p class="head-sub mono">${esc(a.QueueArn || url)}</p>
    </section>
    <div class="tiles three">
      ${tile({ tone: 'smile', ic: 'inbox', label: 'Available', n: num(a.ApproximateNumberOfMessages) })}
      ${tile({ tone: 'info', ic: 'clock', label: 'In flight', n: num(a.ApproximateNumberOfMessagesNotVisible) })}
      ${tile({ tone: 'ink-3', ic: 'pause', label: 'Delayed', n: num(a.ApproximateNumberOfMessagesDelayed) })}
    </div>
    ${facts([
      ['Retention', esc(formatSeconds(Number(a.MessageRetentionPeriod)))],
      ['Visibility timeout', esc(formatSeconds(Number(a.VisibilityTimeout)))],
      ['Delivery delay', esc(formatSeconds(Number(a.DelaySeconds || 0)))],
      ['Receive wait', esc(formatSeconds(Number(a.ReceiveMessageWaitTimeSeconds || 0)))],
      ['Max message', esc(bytes(Number(a.MaximumMessageSize)))],
      ['Created', esc(fmtDate(a.CreatedTimestamp))],
      ['Updated', esc(ago(a.LastModifiedTimestamp))],
      fifo ? ['Deduplication', a.ContentBasedDeduplication === 'true' ? 'Content based' : 'By ID'] : null,
    ])}
    ${dlqName || listed?.isDlq ? sectionHead('Dead-letter routing') : ''}
    ${dlqName ? `<div class="list"><a class="row" href="#/sqs/q/${enc(dlqName)}">${svc('critical', 'skull')}<span class="row-main"><span class="row-title">${esc(dlqName)}</span>
      <span class="row-meta"><span>Receives messages after ${esc(plural(Number(rp.maxReceiveCount), 'failed receive'))}</span></span></span>${icon('chevron', 'ic chev')}</a></div>` : ''}
    <div id="sources"></div>
    ${sectionHead('Activity')}
    ${rangeChips(range)}
    <div class="chart-grid">
      ${chartPanel('c-visible', 'Messages available')}
      ${chartPanel('c-flow', 'Sent and received')}
      ${chartPanel('c-age', 'Age of oldest message')}
      ${chartPanel('c-flight', 'Messages in flight')}
    </div>
    <div id="peek">${sectionHead('Messages')}
      <button class="btn" type="button" id="peek-btn">${icon('eye')}Peek at messages</button>
      <div id="msgs" style="margin-top:12px"></div></div>`;

  const dims = [{ name: 'QueueName', value: name }];
  const m = (metric, stat, label, color) => ({ name: label, namespace: 'AWS/SQS', metric, dims, stat, color });
  const draw = () => drawMetricPanels(ctx, ctx.region, [
    { id: 'c-visible', series: [m('ApproximateNumberOfMessagesVisible', 'Maximum', 'Available')] },
    { id: 'c-flow', series: [m('NumberOfMessagesSent', 'Sum', 'Sent', 'var(--series-1)'), m('NumberOfMessagesReceived', 'Sum', 'Received', 'var(--series-2)')] },
    { id: 'c-age', format: 'seconds', series: [m('ApproximateAgeOfOldestMessage', 'Maximum', 'Oldest', 'var(--series-4)')] },
    { id: 'c-flight', series: [m('ApproximateNumberOfMessagesNotVisible', 'Maximum', 'In flight', 'var(--series-2)')] },
  ], rangeMs(range));
  draw();
  bindChips(ctx.root, 'data-range', (v) => {
    range = v;
    ctx.replaceQuery({ r: v });
    $$('.chart-box', ctx.root).forEach((el) => { el.innerHTML = '<span class="skel chart-skel"></span>'; });
    draw();
  });

  if (listed?.isDlq || !dlqName) {
    aws.deadLetterSources(ctx.region, url).then((urls) => {
      if (ctx.stale() || !urls.length) return;
      $('#sources', ctx.root).innerHTML = `<p class="count">Dead-letter queue for</p><div class="list">${urls.map((u) => `<a class="row" href="#/sqs/q/${enc(aws.queueName(u))}">${svc('sqs', 'queue')}
        <span class="row-main"><span class="row-title">${esc(aws.queueName(u))}</span></span>${icon('chevron', 'ic chev')}</a>`).join('')}</div>`;
    }).catch(() => {});
  }

  $('#peek-btn', ctx.root).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const yes = await confirmSheet({
      title: 'Peek at messages?',
      body: `Each peek counts as a receive${rp?.maxReceiveCount ? `. After ${esc(rp.maxReceiveCount)} receives, messages move to <b>${esc(dlqName)}</b>` : ''}.`,
      confirm: 'Peek',
    });
    if (!yes) return;
    btn.disabled = true;
    const out = $('#msgs', ctx.root);
    out.innerHTML = skelList(3);
    try {
      const msgs = await aws.peekMessages(ctx.region, url);
      if (ctx.stale()) return;
      out.innerHTML = msgs.length ? `<div class="list">${msgs.map(messageRow).join('')}</div>` : '<p class="note">No messages.</p>';
      $$('[data-copy-body]', out).forEach((b) => b.addEventListener('click', () => copyWithToast(msgs[Number(b.dataset.copyBody)].Body, 'Message body copied')));
    } catch (err) {
      out.innerHTML = inlineError(err);
    } finally {
      btn.disabled = false;
    }
  });
}

function messageRow(msg, i) {
  const at = msg.Attributes || {};
  const preview = String(msg.Body || '').replace(/\s+/g, ' ').slice(0, 90);
  const attrs = Object.entries(msg.MessageAttributes || {}).map(([k, v]) => [k, esc(v.StringValue ?? (v.BinaryValue ? '(binary)' : ''))]);
  return `<details class="row-details"><summary class="row">${svc('sqs', 'inbox')}
      <span class="row-main"><span class="row-title">${esc(preview || '(empty body)')}</span>
        <span class="row-meta"><span>sent ${esc(ago(Number(at.SentTimestamp)))}</span><span>received ${esc(plural(Number(at.ApproximateReceiveCount || 0), 'time'))}</span>${at.MessageGroupId ? `<span class="tag">${esc(at.MessageGroupId)}</span>` : ''}</span></span>
      ${icon('chevron', 'ic chev')}</summary>
    <div class="details-body">
      <pre class="code">${esc(pretty(msg.Body))}</pre>
      ${kvTable([
        ['Message ID', `<span class="mono">${esc(msg.MessageId)}</span>`],
        ['Sent', esc(fmtDate(Number(at.SentTimestamp)))],
        at.ApproximateFirstReceiveTimestamp ? ['First received', esc(fmtDate(Number(at.ApproximateFirstReceiveTimestamp)))] : null,
        at.SenderId ? ['Sender', `<span class="mono">${esc(at.SenderId)}</span>`] : null,
        ...attrs,
      ])}
      <button class="btn sm" type="button" data-copy-body="${i}">${icon('copy')}Copy body</button>
    </div></details>`;
}

// ---------------------------------------------------------------------------
// CloudWatch

function cwSeg(active) {
  const a = (href, ic, label, key) => `<a href="${href}" ${key === active ? 'aria-current="page"' : ''}>${icon(ic)}${esc(label)}</a>`;
  return `<nav class="seg" aria-label="CloudWatch">${a('#/cw', 'bell', 'Alarms', 'alarms')}${a('#/cw/metrics', 'chart', 'Metrics', 'metrics')}${a('#/cw/logs', 'logs', 'Logs', 'logs')}</nav>`;
}

async function viewAlarms(ctx) {
  setHeader({ title: 'CloudWatch', crumb: regionName(ctx.region) });
  ctx.root.innerHTML = `${cwSeg('alarms')}${skelList(5)}`;
  const alarms = await loadAlarms(ctx.region);
  if (ctx.stale()) return;
  if (!alarms.length) {
    ctx.root.innerHTML = `${cwSeg('alarms')}${emptyState('No alarms', `No CloudWatch alarms in <b>${esc(ctx.region)}</b>.`, '', 'bell', 'cw')}`;
    return;
  }
  const count = (s) => alarms.filter((a) => a.state === s).length;
  let filter = ctx.query.get('f') || (count('ALARM') ? 'ALARM' : 'all');
  let q = ctx.query.get('q') || '';
  ctx.root.innerHTML = `${cwSeg('alarms')}
    <div class="toolbar">${searchBox('aq', 'Search alarms', q)}</div>
    ${chips([['all', 'All', alarms.length], ['ALARM', 'In alarm', count('ALARM')], ['INSUFFICIENT_DATA', 'Insufficient', count('INSUFFICIENT_DATA')], ['OK', 'OK', count('OK')]], filter, 'data-f')}
    <div id="alist"></div>`;
  const row = (a) => pinRow(alarmRow(a), 'alarm', ctx.region, a.name);
  const paint = () => {
    const needle = q.trim().toLowerCase();
    const matches = alarms
      .filter((a) => !needle || `${a.name} ${a.metric || ''} ${a.namespace || ''}`.toLowerCase().includes(needle))
      .sort((x, y) => alarmState(x).rank - alarmState(y).rank || (toDate(y.updated) || 0) - (toDate(x.updated) || 0));
    // Pinned alarms stay on top whatever state filter is chosen.
    const { pinned, rest } = pinSplit(matches, (a) => a.name, 'alarm', ctx.region);
    const list = rest.filter((a) => filter === 'all' || a.state === filter);
    $('#alist', ctx.root).innerHTML = `
      ${pinned.length ? `${sectionHead('Pinned')}${listBlock(pinned.map(row))}${sectionHead(filter === 'all' ? 'All alarms' : alarmState({ state: filter }).label)}` : ''}
      ${list.length ? listBlock(list.map(row)) : `<p class="note">${filter === 'ALARM' ? 'Nothing else is firing.' : 'No alarms match.'}</p>`}`;
    ctx.replaceQuery({ q, f: filter });
  };
  paint();
  ctx.onPins(paint);
  bindChips(ctx.root, 'data-f', (v) => { filter = v; paint(); });
  $('#aq', ctx.root).addEventListener('input', debounce((e) => { q = e.target.value; paint(); }, 120));
}

const OPS = {
  GreaterThanThreshold: '>',
  GreaterThanOrEqualToThreshold: '≥',
  LessThanThreshold: '<',
  LessThanOrEqualToThreshold: '≤',
  LessThanLowerOrGreaterThanUpperThreshold: 'outside the band',
  LessThanLowerThreshold: 'below the band',
  GreaterThanUpperThreshold: 'above the band',
};

async function viewAlarm(ctx) {
  const name = ctx.params.name;
  setHeader({ title: name, crumb: `Alarm · ${ctx.region}`, back: '#/cw' });
  ctx.root.innerHTML = skelList(3);
  const a = (await loadAlarms(ctx.region)).find((x) => x.name === name);
  if (ctx.stale()) return;
  if (!a) {
    ctx.root.innerHTML = emptyState('Alarm not found', `There is no alarm called <b>${esc(name)}</b> in ${esc(ctx.region)}.`, '<a class="btn" href="#/cw">All alarms</a>', 'bell');
    return;
  }
  const h = alarmState(a);
  const needed = a.datapointsToAlarm || a.evaluationPeriods;
  const condition = a.threshold !== null && a.comparison
    ? `${a.stat || 'Value'} ${OPS[a.comparison] || a.comparison} ${formatValue(a.threshold)}${a.unit ? ` ${a.unit}` : ''}, ${needed} of ${a.evaluationPeriods} × ${formatSeconds(a.period || a.queries.find((q) => q.period)?.period || 60)}`
    : '';
  let range = ctx.query.get('r') || '3h';

  ctx.root.innerHTML = `
    <section class="head">
      <div class="head-line">${badge(h)}${a.kind === 'composite' ? '<span class="tag">Composite</span>' : ''}${!a.actionsEnabled ? '<span class="tag">Actions off</span>' : ''}</div>
      <h2 class="head-name">${esc(a.name)}</h2>
      ${a.description ? `<p class="head-sub">${esc(a.description)}</p>` : ''}
      <p class="reason">${esc(a.reason)}<br><span class="muted">Changed ${esc(ago(a.updated))} · ${esc(fmtDate(a.updated))}</span></p>
      ${a.kind === 'metric' ? facts([
        a.metric ? ['Metric', esc(a.metric)] : ['Metric', 'Metric math'],
        a.namespace ? ['Namespace', esc(a.namespace)] : null,
        condition ? ['Condition', esc(condition)] : null,
        a.treatMissing ? ['Missing data', esc(a.treatMissing)] : null,
        ...(a.dims || []).map((d) => [d.name, `<span class="mono">${esc(d.value)}</span>`]),
      ]) : ''}
    </section>
    ${a.kind === 'composite' ? `${sectionHead('Rule')}<pre class="code">${esc(a.rule)}</pre>` : `
      ${sectionHead('Metric')}${rangeChips(range)}
      <div class="panel"><div class="chart-box" id="c-alarm"><span class="skel chart-skel"></span></div></div>`}
    ${sectionHead('History')}<div id="hist">${skelList(3)}</div>`;

  const draw = async () => {
    const el = $('#c-alarm', ctx.root);
    if (!el) return;
    const span = rangeMs(range);
    const end = Date.now();
    const start = end - span;
    const queries = a.queries.length
      ? a.queries.map((q) => ({ ...q, period: q.expression ? q.period || undefined : q.period }))
      : [{ id: 'm', label: a.metric, namespace: a.namespace, metric: a.metric, dims: a.dims, stat: a.stat, period: Math.max(a.period || 60, aws.periodFor(span)) }];
    try {
      const res = await aws.getMetricData(ctx.region, queries, start, end);
      if (ctx.stale()) return;
      el.innerHTML = '';
      const chart = lineChart(el, {
        series: res.map((r, i) => ({ name: r.label || r.id, points: r.points, color: i === 0 ? 'var(--series-1)' : undefined })),
        time: true,
        xMin: start,
        xMax: end,
        height: 210,
        threshold: Number.isFinite(a.threshold) ? a.threshold : null,
      });
      ctx.cleanup(() => chart.destroy());
    } catch (err) {
      if (!ctx.stale()) el.innerHTML = inlineError(err);
    }
  };
  draw();
  bindChips(ctx.root, 'data-range', (v) => {
    range = v;
    ctx.replaceQuery({ r: v });
    $('#c-alarm', ctx.root).innerHTML = '<span class="skel chart-skel"></span>';
    draw();
  });

  try {
    const hist = await aws.alarmHistory(ctx.region, a.name);
    if (ctx.stale()) return;
    $('#hist', ctx.root).innerHTML = hist.length ? `<div class="list">${hist.map((x) => {
      const st = alarmState({ state: x.to });
      return `<div class="row">${mark(st)}<span class="row-main"><span class="row-title wrap">${esc(x.summary)}</span>
        <span class="row-meta"><span>${esc(fmtDate(x.at))}</span><span>${esc(ago(x.at))}</span></span></span></div>`;
    }).join('')}</div>` : '<p class="note">No state changes recorded in the last two weeks.</p>';
  } catch (err) {
    if (!ctx.stale()) $('#hist', ctx.root).innerHTML = inlineError(err);
  }
}

const dimsText = (dims) => dims.map((d) => `${d.name}: ${d.value}`).join(' · ');
const metricHref = (m) => `#/cw/m?ns=${enc(m.namespace)}&m=${enc(m.metric)}&d=${enc(JSON.stringify(m.dims.map((d) => [d.name, d.value])))}`;
const metricId = (m) => JSON.stringify([m.namespace, m.metric, m.dims.map((d) => [d.name, d.value])]);
const metricFromId = (id) => {
  const [namespace, metric, dims] = parseJSON(id, ['', '', []]);
  return { namespace, metric, dims: (dims || []).map(([name, value]) => ({ name, value })) };
};
const metricRow = (m, region, { showNs = false } = {}) => pinRow(`<a class="row" href="${metricHref(m)}">
  ${showNs ? svc('cw', 'chart') : ''}
  <span class="row-main"><span class="row-title">${esc(m.metric)}</span>
    ${m.dims.length || showNs ? `<span class="row-meta">${showNs ? `<span>${esc(m.namespace)}</span>` : ''}${m.dims.length ? `<span class="clip">${esc(dimsText(m.dims))}</span>` : ''}</span>` : ''}</span>${icon('chevron', 'ic chev')}</a>`, 'metric', region, metricId(m));

async function viewNamespaces(ctx) {
  setHeader({ title: 'CloudWatch', crumb: regionName(ctx.region) });
  ctx.root.innerHTML = `${cwSeg('metrics')}${skelList(6)}`;
  const { metrics, truncated } = await memo(`metrics:${ctx.region}`, 120e3, () => aws.listMetrics(ctx.region, { maxPages: 6 }));
  if (ctx.stale()) return;
  const groups = new Map();
  for (const m of metrics) groups.set(m.namespace, (groups.get(m.namespace) || 0) + 1);
  const list = [...groups.entries()].sort((a, b) => {
    const aw = a[0].startsWith('AWS/') ? 0 : 1;
    const bw = b[0].startsWith('AWS/') ? 0 : 1;
    return aw - bw || a[0].localeCompare(b[0]);
  });
  if (!list.length) {
    ctx.root.innerHTML = `${cwSeg('metrics')}${emptyState('No recent metrics', `Nothing reported metrics in <b>${esc(ctx.region)}</b> in the last 3 hours.`, '', 'chart', 'cw')}`;
    return;
  }
  ctx.root.innerHTML = `${cwSeg('metrics')}
    <div class="toolbar">${searchBox('nq', 'Search namespaces')}</div>
    ${truncated ? '<p class="count">First 3,000 metrics</p>' : ''}<div id="nlist"></div>`;
  let q = '';
  const paint = () => {
    const needle = q.trim().toLowerCase();
    const pinned = pins.list('metric', ctx.region).map(metricFromId)
      .filter((m) => m.metric && (!needle || `${m.namespace} ${m.metric} ${dimsText(m.dims)}`.toLowerCase().includes(needle)));
    const rows = list.filter(([ns]) => !needle || ns.toLowerCase().includes(needle));
    $('#nlist', ctx.root).innerHTML = `
      ${pinned.length ? `${sectionHead('Pinned metrics')}${listBlock(pinned.map((m) => metricRow(m, ctx.region, { showNs: true })))}${sectionHead('Namespaces')}` : ''}
      ${rows.length ? `<div class="list">${rows.map(([ns, n]) => `<a class="row" href="#/cw/ns/${enc(ns)}">
      ${svc(ns.startsWith('AWS/') ? 'cw' : 'info', 'chart')}
      <span class="row-main"><span class="row-title">${esc(ns)}</span><span class="row-meta"><span>${esc(plural(n, 'metric'))}</span></span></span>
      ${icon('chevron', 'ic chev')}</a>`).join('')}</div>` : '<p class="note">No namespaces match.</p>'}`;
  };
  paint();
  ctx.onPins(paint);
  $('#nq', ctx.root).addEventListener('input', debounce((e) => { q = e.target.value; paint(); }, 120));
}

async function viewNamespace(ctx) {
  const ns = ctx.params.ns;
  setHeader({ title: ns, crumb: `Metrics · ${ctx.region}`, back: '#/cw/metrics' });
  ctx.root.innerHTML = skelList(6);
  const { metrics, truncated } = await memo(`metrics:${ctx.region}:${ns}`, 120e3, () => aws.listMetrics(ctx.region, { namespace: ns, maxPages: 10 }));
  if (ctx.stale()) return;
  const sorted = metrics.slice().sort((a, b) => a.metric.localeCompare(b.metric) || dimsText(a.dims).localeCompare(dimsText(b.dims)));
  let q = ctx.query.get('q') || '';
  let shown = 200;
  ctx.root.innerHTML = `<div class="toolbar">${searchBox('mq', 'Search metrics or dimensions', q)}</div><p class="count" id="mcount"></p><div id="mlist"></div><div class="more" id="mmore"></div>`;
  const paint = () => {
    const needle = q.trim().toLowerCase();
    const matches = sorted.filter((m) => !needle || `${m.metric} ${dimsText(m.dims)}`.toLowerCase().includes(needle));
    const { pinned, rest: list } = pinSplit(matches, metricId, 'metric', ctx.region);
    $('#mcount', ctx.root).textContent = `${plural(matches.length, 'metric')}${truncated ? ' (list cut at 5,000)' : ''}`;
    $('#mlist', ctx.root).innerHTML = `
      ${pinned.length ? `${sectionHead('Pinned')}${listBlock(pinned.map((m) => metricRow(m, ctx.region)))}${list.length ? sectionHead('All metrics') : ''}` : ''}
      ${list.length ? listBlock(list.slice(0, shown).map((m) => metricRow(m, ctx.region))) : pinned.length ? '' : '<p class="note">No metrics match.</p>'}`;
    $('#mmore', ctx.root).innerHTML = list.length > shown ? `<button class="btn" type="button" id="showmore">Show ${num(Math.min(200, list.length - shown))} more</button>` : '';
    $('#showmore', ctx.root)?.addEventListener('click', () => { shown += 200; paint(); });
    ctx.replaceQuery({ q });
  };
  paint();
  ctx.onPins(paint);
  $('#mq', ctx.root).addEventListener('input', debounce((e) => { q = e.target.value; shown = 200; paint(); }, 150));
}

const STATS = [['Average', 'Average'], ['Sum', 'Sum'], ['Maximum', 'Max'], ['Minimum', 'Min'], ['SampleCount', 'Count'], ['p99', 'p99']];

async function viewMetric(ctx) {
  const ns = ctx.query.get('ns') || '';
  const metric = ctx.query.get('m') || '';
  const dims = (parseJSON(ctx.query.get('d'), []) || []).map(([name, value]) => ({ name, value }));
  setHeader({ title: metric, crumb: ns, back: `#/cw/ns/${enc(ns)}` });
  let range = ctx.query.get('r') || '3h';
  let stat = ctx.query.get('s') || (/Count$|Bytes$|Errors$|Invocations$|Requests$|NumberOf/.test(metric) ? 'Sum' : 'Average');
  const fmt = /Bytes/.test(metric) ? 'bytes' : 'count';

  ctx.root.innerHTML = `
    <section class="head">
      <div class="head-line">${svc('cw', 'chart')}<span class="tag">${esc(ns)}</span></div>
      <h2 class="head-name">${esc(metric)}</h2>
      ${dims.length ? facts(dims.map((d) => [d.name, `<span class="mono">${esc(d.value)}</span>`])) : ''}
    </section>
    ${rangeChips(range, ['1h', '3h', '12h', '1d', '1w', '4w'])}
    ${chips(STATS, stat, 'data-stat')}
    <div class="panel"><div class="chart-head"><span class="chart-title" id="mtitle"></span><span class="chart-last" data-last="c-metric"></span></div>
      <div class="chart-box" id="c-metric"><span class="skel chart-skel"></span></div></div>
    <div class="tiles" id="mstats"></div>`;

  const draw = async () => {
    const span = rangeMs(range);
    const end = Date.now();
    const start = end - span;
    const el = $('#c-metric', ctx.root);
    el.innerHTML = '<span class="skel chart-skel"></span>';
    $('#mtitle', ctx.root).textContent = `${STATS.find(([k]) => k === stat)?.[1] || stat} per ${formatSeconds(aws.periodFor(span))}`;
    try {
      const [r] = await aws.getMetricData(ctx.region, [{ id: 'm', label: metric, namespace: ns, metric, dims, stat, period: aws.periodFor(span) }], start, end);
      if (ctx.stale()) return;
      const f = FORMATS[fmt];
      el.innerHTML = '';
      const chart = lineChart(el, { series: [{ name: stat, points: r.points }], time: true, xMin: start, xMax: end, height: 240, valueFormat: f.value, yFormat: f.axis });
      ctx.cleanup(() => chart.destroy());
      const vals = r.points.map((p) => p[1]);
      $('[data-last="c-metric"]', ctx.root).textContent = vals.length ? f.value(vals[vals.length - 1]) : '';
      $('#mstats', ctx.root).innerHTML = vals.length ? [
        ['Latest', vals[vals.length - 1]], ['Lowest', Math.min(...vals)], ['Highest', Math.max(...vals)], ['Mean', vals.reduce((s, v) => s + v, 0) / vals.length],
      ].map(([k, v]) => `<div class="tile"><span class="tile-top"><span>${k}</span></span><span class="tile-n" style="font-size:22px">${esc(f.value(v))}</span></div>`).join('') : '';
    } catch (err) {
      if (!ctx.stale()) el.innerHTML = inlineError(err);
    }
  };
  draw();
  bindChips(ctx.root, 'data-range', (v) => { range = v; ctx.replaceQuery({ ns, m: metric, d: ctx.query.get('d'), r: v, s: stat }); draw(); });
  bindChips(ctx.root, 'data-stat', (v) => { stat = v; ctx.replaceQuery({ ns, m: metric, d: ctx.query.get('d'), r: range, s: v }); draw(); });
}

async function viewLogGroups(ctx) {
  setHeader({ title: 'CloudWatch', crumb: regionName(ctx.region) });
  let q = ctx.query.get('q') || '';
  ctx.root.innerHTML = `${cwSeg('logs')}<div class="toolbar">${searchBox('lq', 'Search log groups', q)}</div><div id="glist">${skelList(6)}</div><div class="more" id="gmore"></div>`;
  let groups = [];
  let next = '';
  let seq = 0;
  const known = new Map();
  const row = (name) => {
    const g = known.get(name);
    return pinRow(`<a class="row" href="#/cw/group?g=${enc(name)}">
      ${svc('cw', 'logs')}
      <span class="row-main"><span class="row-title">${esc(name)}</span>
        ${g ? `<span class="row-meta"><span>${esc(bytes(g.storedBytes || 0))}</span><span>${g.retentionInDays ? `kept ${esc(g.retentionInDays)}d` : 'kept forever'}</span>${g.logGroupClass && g.logGroupClass !== 'STANDARD' ? `<span class="tag">${esc(g.logGroupClass)}</span>` : ''}</span>` : ''}</span>${icon('chevron', 'ic chev')}</a>`, 'loggroup', ctx.region, name);
  };
  const paint = () => {
    const needle = q.trim().toLowerCase();
    const pinnedNames = pins.list('loggroup', ctx.region).filter((n) => !needle || n.toLowerCase().includes(needle));
    const pinnedSet = new Set(pins.list('loggroup', ctx.region));
    const rest = groups.map((g) => g.logGroupName).filter((n) => !pinnedSet.has(n));
    $('#glist', ctx.root).innerHTML = `
      ${pinnedNames.length ? `${sectionHead('Pinned')}${listBlock(pinnedNames.map(row))}${rest.length ? sectionHead('All log groups') : ''}` : ''}
      ${rest.length ? listBlock(rest.map(row)) : pinnedNames.length ? ''
        : emptyState(q ? 'No log groups match' : 'No log groups', q ? '' : `No CloudWatch log groups in <b>${esc(ctx.region)}</b>.`, '', 'logs', 'cw')}`;
    $('#gmore', ctx.root).innerHTML = next ? '<button class="btn" type="button" id="gload">Load more</button>' : '';
    $('#gload', ctx.root)?.addEventListener('click', (e) => { e.target.disabled = true; load(true).catch((err) => toast(err.message)); });
  };
  const load = async (more = false) => {
    const mine = ++seq;
    const r = await aws.describeLogGroups(ctx.region, { pattern: q.trim(), token: more ? next : undefined });
    if (ctx.stale() || mine !== seq) return;
    groups = more ? groups.concat(r.groups) : r.groups;
    for (const g of r.groups) known.set(g.logGroupName, g);
    next = r.next;
    paint();
  };
  ctx.onPins(() => { if (seq) paint(); });
  $('#lq', ctx.root).addEventListener('input', debounce((e) => {
    q = e.target.value;
    ctx.replaceQuery({ q });
    load().catch((err) => { $('#glist', ctx.root).innerHTML = inlineError(err); });
  }, 400));
  await load();
}

const LOG_RANGES = [['15m', 15], ['1h', 60], ['6h', 360], ['1d', 1440], ['1w', 10080]];
const ERR_RE = /\b(error|exception|fatal|panic|traceback|fail(ed|ure)?)\b/i;
const WARN_RE = /\b(warn(ing)?|timeout|timed out|retry)\b/i;

function logLine(ev, withStream = false) {
  const t = new Date(ev.timestamp).toLocaleTimeString(undefined, { hour12: false });
  const msg = String(ev.message || '').replace(/\n$/, '');
  const cls = ERR_RE.test(msg) ? 'err' : WARN_RE.test(msg) ? 'warn' : '';
  return `<span class="t">${esc(t)}</span> ${withStream ? `<span class="s">${esc(String(ev.logStreamName).slice(-12))}</span> ` : ''}${cls ? `<span class="${cls}">${esc(msg)}</span>` : esc(msg)}`;
}

function logTerminal(id) {
  const wrap = store.get('logWrap', true);
  return `<div class="log-box"><pre class="log ${wrap ? 'wrap' : ''}" id="${id}" tabindex="0"></pre>
    <button class="icon-btn sm log-copy" type="button" data-copy-log="${id}" aria-label="Copy log">${icon('copy')}</button></div>`;
}

function bindTerminal(ctx, id, getText) {
  $(`[data-copy-log="${id}"]`, ctx.root)?.addEventListener('click', () => copyWithToast(getText(), 'Log copied'));
}

async function viewLogGroup(ctx) {
  const group = ctx.query.get('g') || '';
  const short = group.split('/').filter(Boolean).pop() || group;
  setHeader({ title: short, crumb: group, back: '#/cw/logs' });
  let pattern = ctx.query.get('q') || '';
  let since = ctx.query.get('t') || '1h';
  ctx.root.innerHTML = `
   <form class="toolbar" id="lsearch">${searchBox('fp', 'Search all streams, e.g. ERROR', pattern)}<button class="btn primary" type="submit">Search</button></form>
    ${chips(LOG_RANGES.map(([k]) => [k, `Last ${k}`]), since, 'data-t')}
    <div id="results"></div>
    ${sectionHead('Streams')}<div id="slist">${skelList(5)}</div><div class="more" id="smore"></div>`;

  let events = [];
  let nextEv = '';
  const search = async (more = false) => {
    const out = $('#results', ctx.root);
    if (!more) {
      out.innerHTML = '<span class="skel block"></span>';
      events = [];
    }
    const minutes = LOG_RANGES.find(([k]) => k === since)[1];
    try {
      const r = await aws.filterLogEvents(ctx.region, group, { pattern: pattern.trim(), startTime: Date.now() - minutes * 60e3, token: more ? nextEv : undefined });
      if (ctx.stale()) return;
      events = events.concat(r.events || []);
      nextEv = r.nextToken || '';
      out.innerHTML = `${sectionHead(pattern.trim() ? `Matches for “${pattern.trim()}”` : 'Recent events', `<span class="muted">${esc(num(events.length))}${nextEv ? '+' : ''}</span>`)}
        ${events.length ? logTerminal('flog') : '<p class="note">No events in this time range.</p>'}
        ${nextEv ? '<div class="more"><button class="btn" type="button" id="evmore">Load more</button></div>' : ''}`;
      const el = $('#flog', ctx.root);
      if (el) el.innerHTML = events.map((e) => logLine(e, true)).join('\n');
      bindTerminal(ctx, 'flog', () => events.map((e) => `${new Date(e.timestamp).toISOString()} ${e.logStreamName} ${e.message}`).join('\n'));
      $('#evmore', ctx.root)?.addEventListener('click', (e) => { e.target.disabled = true; search(true); });
    } catch (err) {
      if (!ctx.stale()) out.innerHTML = inlineError(err);
    }
  };
  $('#lsearch', ctx.root).addEventListener('submit', (e) => {
    e.preventDefault();
    pattern = $('#fp', ctx.root).value;
    ctx.replaceQuery({ g: group, q: pattern, t: since });
    $('#fp', ctx.root).blur();
    search();
  });
  bindChips(ctx.root, 'data-t', (v) => {
    since = v;
    ctx.replaceQuery({ g: group, q: pattern, t: since });
    if (pattern.trim() || $('#flog', ctx.root)) search();
  });
  if (pattern.trim()) search();

  let streams = [];
  let next = '';
  const loadStreams = async (more = false) => {
    const r = await aws.describeLogStreams(ctx.region, group, more ? next : undefined);
    if (ctx.stale()) return;
    streams = streams.concat(r.streams);
    next = r.next;
    $('#slist', ctx.root).innerHTML = streams.length ? `<div class="list">${streams.map((s) => `<a class="row" href="#/cw/stream?g=${enc(group)}&s=${enc(s.logStreamName)}">
      <span class="row-main"><span class="row-title">${esc(s.logStreamName)}</span>
        <span class="row-meta"><span>${s.lastEventTimestamp ? `last event ${esc(ago(s.lastEventTimestamp))}` : 'no events'}</span>${s.firstEventTimestamp ? `<span>since ${esc(fmtDate(s.firstEventTimestamp))}</span>` : ''}</span></span>
      ${icon('chevron', 'ic chev')}</a>`).join('')}</div>` : '<p class="note">This log group has no streams.</p>';
    $('#smore', ctx.root).innerHTML = next ? '<button class="btn" type="button" id="sload">Load more</button>' : '';
    $('#sload', ctx.root)?.addEventListener('click', (e) => { e.target.disabled = true; loadStreams(true).catch((err) => toast(err.message)); });
  };
  await loadStreams();
}

async function viewLogStream(ctx) {
  const group = ctx.query.get('g') || '';
  const stream = ctx.query.get('s') || '';
  setHeader({ title: stream.split('/').pop() || stream, crumb: group, back: `#/cw/group?g=${enc(group)}` });
  let wrap = store.get('logWrap', true);
  let follow = false;
  ctx.root.innerHTML = `
    <div class="toolbar">
      <button class="btn sm" type="button" id="follow">${icon('play')}Follow</button>
      <button class="btn sm ghost" type="button" id="wrap" aria-pressed="${wrap}">${icon('wrap')}${wrap ? 'Wrapped' : 'No wrap'}</button>
      <span class="muted" id="lcount" style="margin-left:auto;font-size:13px"></span>
    </div>
    <button class="btn sm ghost log-older" type="button" id="older">Load older</button>
    ${logTerminal('slog')}
    <p class="note mono" style="font-size:12px;overflow-wrap:anywhere">${esc(stream)}</p>`;
  const el = $('#slog', ctx.root);
  el.innerHTML = '<span class="muted">Loading…</span>';

  let events = [];
  let back = '';
  let fwd = '';
  const paint = (keepBottom) => {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = events.length ? events.map((e) => logLine(e)).join('\n') : '<span class="muted">No events in this stream.</span>';
    $('#lcount', ctx.root).textContent = plural(events.length, 'event');
    if (keepBottom === true || (keepBottom === 'auto' && atBottom)) el.scrollTop = el.scrollHeight;
  };
  bindTerminal(ctx, 'slog', () => events.map((e) => `${new Date(e.timestamp).toISOString()} ${e.message}`).join('\n'));

  const first = await aws.getLogEvents(ctx.region, group, stream, { limit: 400 });
  if (ctx.stale()) return;
  events = first.events || [];
  back = first.nextBackwardToken;
  fwd = first.nextForwardToken;
  paint(true);

  $('#older', ctx.root).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await aws.getLogEvents(ctx.region, group, stream, { token: back, limit: 400 });
      if (ctx.stale()) return;
      const older = r.events || [];
      if (!older.length || r.nextBackwardToken === back) {
        btn.textContent = 'Start of stream';
        return;
      }
      const prevHeight = el.scrollHeight;
      events = older.concat(events);
      back = r.nextBackwardToken;
      paint(false);
      el.scrollTop = el.scrollHeight - prevHeight;
      btn.disabled = false;
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });
  $('#wrap', ctx.root).addEventListener('click', (e) => {
    wrap = !wrap;
    store.set('logWrap', wrap);
    el.classList.toggle('wrap', wrap);
    e.currentTarget.innerHTML = `${icon('wrap')}${wrap ? 'Wrapped' : 'No wrap'}`;
  });
  $('#follow', ctx.root).addEventListener('click', (e) => {
    follow = !follow;
    e.currentTarget.classList.toggle('primary', follow);
    e.currentTarget.innerHTML = `${icon(follow ? 'pause' : 'play')}${follow ? 'Following' : 'Follow'}`;
    if (follow) el.scrollTop = el.scrollHeight;
  });
  ctx.every(5000, async () => {
    if (!follow) return;
    try {
      const r = await aws.getLogEvents(ctx.region, group, stream, { token: fwd, fromHead: true, limit: 400 });
      if (ctx.stale()) return;
      fwd = r.nextForwardToken || fwd;
      if (r.events?.length) {
        events = events.concat(r.events).slice(-5000);
        paint('auto');
      }
    } catch (err) {
      console.warn('Follow failed', err);
    }
  });
}

// ---------------------------------------------------------------------------
// Settings

async function viewSettings(ctx) {
  setHeader({ title: 'Settings', back: '#/' });
  ctx.root.innerHTML = skelList(3);
  const [ident, key] = await Promise.all([ensureIdentity(), aws.creds.status()]);
  if (ctx.stale()) return;
  const arnParts = ident.arn.split(':');
  const principal = arnParts.slice(5).join(':');
  const policy = JSON.stringify(IAM_POLICY, null, 2);
  ctx.root.innerHTML = `
    ${sectionHead('Account')}
    ${kvTable([
      ['Account ID', `<span class="mono">${esc(ident.account)}</span>`],
      ['Signed in as', esc(principal)],
      ['ARN', `<span class="mono">${esc(ident.arn)}</span>`],
    ])}
    ${sectionHead('Access key')}
    ${kvTable([
      ['Access key ID', `<span class="mono">${esc(key.accessKeyId || '')}</span>`],
      ['Type', key.temporary ? 'Temporary (session token)' : 'Long-term IAM key'],
    ])}
    <details class="row-details list" style="margin-top:10px"><summary class="row">${svc('info', 'key')}<span class="row-main"><span class="row-title">IAM policy</span></span>${icon('chevron', 'ic chev')}</summary>
      <div class="details-body"><pre class="code">${esc(policy)}</pre><button class="btn sm" type="button" id="copy-policy">${icon('copy')}Copy policy</button></div></details>
    ${sectionHead('Region')}
    <div class="list"><button class="row" type="button" id="region-row">${svc('live', 'globe')}
      <span class="row-main"><span class="row-title">${esc(regionName(app.region))}</span><span class="row-meta"><span class="mono">${esc(app.region)}</span></span></span>${icon('chevron', 'ic chev')}</button></div>
    ${sectionHead('Appearance')}
    ${chips([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], store.get('theme', 'system'), 'data-theme-choice')}
    ${sectionHead('Advanced mode')}
    ${chips([['off', 'Off'], ['on', 'On']], app.advanced ? 'on' : 'off', 'data-adv')}
    ${sectionHead('This phone')}
    <button class="btn danger" type="button" id="sign-out">${icon('logout')}Remove AWS keys from this phone</button>
    <p class="note muted">cloudBoard ${VERSION}</p>`;

  $('#region-row', ctx.root).addEventListener('click', regionSheet);
  bindChips(ctx.root, 'data-theme-choice', (v) => {
    store.set('theme', v);
    applyTheme(v);
  });
  bindChips(ctx.root, 'data-adv', (v) => {
    app.advanced = v === 'on';
    store.set('advanced', app.advanced);
    toast(app.advanced ? 'Advanced mode on' : 'Advanced mode off');
  });
  $('#copy-policy', ctx.root).addEventListener('click', () => copyWithToast(policy, 'Policy copied'));
  $('#sign-out', ctx.root).addEventListener('click', async () => {
    const yes = await confirmSheet({
      title: 'Remove your AWS keys?',
      body: 'You will need to enter them again to connect.',
      confirm: 'Remove keys',
      danger: true,
    });
    if (!yes) return;
    await aws.creds.clear().catch(() => {});
    app.identity = null;
    memoStore.clear();
    showLogin('Keys removed. Add keys to connect again.');
  });
}

// ---------------------------------------------------------------------------
// Login and boot

function renderLoginForm() {
  const region = app.region;
  $('#login-fields').innerHTML = `
    <h1>Connect your<br>AWS account</h1>
    <div class="field"><label for="akid">Access key ID</label>
      <input id="akid" type="text" placeholder="AKIA…" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" required></div>
    <div class="field"><label for="secret">Secret access key</label>
      <input id="secret" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required></div>
    <div class="field"><label for="region">Region</label>
      <select id="region">${REGIONS.map(([c, n]) => `<option value="${c}" ${c === region ? 'selected' : ''}>${esc(n)} · ${c}</option>`).join('')}</select></div>
    <details class="login-adv"><summary>Using temporary credentials?</summary>
      <div class="field"><label for="token">Session token</label>
      <input id="token" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></div></details>`;
}

function showLogin(message = '') {
  renderLoginForm();
  $('#boot').hidden = true;
  $('#shell').hidden = true;
  $('#login').hidden = false;
  $('#login-error').textContent = message || (!NATIVE && !DEMO ? 'cloudBoard signs requests inside the Android app. Open it on your phone, or add ?demo to this page to look around.' : '');
}

async function start() {
  $('#boot').hidden = true;
  $('#login').hidden = true;
  $('#shell').hidden = false;
  renderTabbar();
  renderRegionPill();
  if (!routerStarted) {
    window.addEventListener('hashchange', render);
    routerStarted = true;
  }
  await render();
}

let routerStarted = false;

function bindShell() {
  bindLongPress();
  $('#menu-btn').innerHTML = icon('menu');
  $('#menu-btn').addEventListener('click', openDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  $('#back-btn').innerHTML = icon('back');
  $('#refresh-btn').innerHTML = icon('refresh');
  $('#settings-btn').innerHTML = icon('settings');
  $('#region-btn').addEventListener('click', regionSheet);
  $('#refresh-btn').addEventListener('click', () => {
    const keep = memoStore.get('identity');
    memoStore.clear();
    if (keep) memoStore.set('identity', keep);
    render();
  });
  const topbar = $('.topbar');
  window.addEventListener('scroll', () => topbar.classList.toggle('scrolled', window.scrollY > 4), { passive: true });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-submit');
    btn.disabled = true;
    btn.textContent = 'Checking keys…';
    $('#login-error').textContent = '';
    try {
      await aws.creds.save($('#akid').value.trim(), $('#secret').value.trim(), $('#token')?.value.trim() || undefined);
      try {
        app.identity = await aws.whoAmI();
      } catch (err) {
        await aws.creds.clear().catch(() => {});
        throw err;
      }
      memoStore.clear();
      memoStore.set('identity', { at: Date.now(), p: Promise.resolve(app.identity) });
      app.region = $('#region').value;
      store.set('region', app.region);
      location.hash = '#/';
      await start();
    } catch (err) {
      $('#login-error').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  });
}

async function boot() {
  applyTheme();
  bindShell();
  realAws.setAuthLostHandler(() => showLogin('Add your AWS keys to continue.'));
  let status;
  try {
    status = await aws.creds.status();
  } catch {
    status = { hasCredentials: false };
  }
  if (!status.hasCredentials) return showLogin();
  try {
    await start();
  } catch (err) {
    $('#boot').hidden = false;
    $('#boot').innerHTML = errorState(err);
    $('[data-retry]')?.addEventListener('click', () => location.reload());
  }
  return undefined;
}

window.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof AwsError && e.reason.code === 'no_credentials') e.preventDefault();
});

boot();
