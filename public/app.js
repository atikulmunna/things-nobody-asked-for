import { Capacitor, registerPlugin, SystemBars, SystemBarsStyle } from './vendor/capacitor.js';
import {
  Q, F, dashProjectsQuery, dashRunsQuery, sparkQuery, STOP_RUN, SWEEP_STATE,
  wandbUrls, weaveQueryBody, parseJsonl, weaveErrorReason,
} from './queries.js';
import { lineChart, sparkline, formatValue, formatSeconds, SERIES_SLOTS } from './charts.js';

const VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Helpers

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const enc = encodeURIComponent;
const edges = (conn) => (conn?.edges || []).map((e) => e.node).filter(Boolean);
const unique = (list) => [...new Set(list.filter(Boolean))];

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`rw:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`rw:${key}`, JSON.stringify(value));
    } catch {
      // Private mode or storage full: preferences just won't persist.
    }
  },
};

function parseJSON(v, fallback = {}) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

// W&B timestamps usually come without a zone and are UTC.
function toDate(s) {
  if (!s) return null;
  const str = String(s);
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(str) ? str : `${str}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ago(s) {
  const d = toDate(s);
  if (!d) return '';
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDate(s) {
  const d = toDate(s);
  return d ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

function bytes(n) {
  let v = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function plural(n, word, many = `${word}s`) {
  return `${Number(n).toLocaleString()} ${n === 1 ? word : many}`;
}

function joinAnd(parts) {
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Icons (24px grid, stroked)

const ICONS = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.4L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.6 4.4l1.4-1.9M20 20v-4.5h-4.5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  dashboard: '<path d="M4 4h6v9H4zM14 4h6v5h-6zM14 13h6v7h-6zM4 17h6v3H4z"/>',
  pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6h5"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  overview: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  sweeps: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9"/>',
  registry: '<path d="M6 3.5h12v17l-6-4-6 4z"/>',
  report: '<path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6"/>',
  traces: '<path d="M5 4v12a3 3 0 0 0 3 3h3M5 9h6"/><rect x="13" y="6" width="7" height="6" rx="1.5"/><rect x="13" y="15" width="7" height="6" rx="1.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.3l2.4 2.4 4.6-4.9"/>',
  xCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/>',
  bolt: '<path d="M13 3L5.5 13.5h5.5L10 21l7.5-10.5H12z"/>',
  alert: '<path d="M12 4l9 16H3zM12 10v4.5M12 17.5v.1"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="M8 5.5l11 6.5-11 6.5z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  star: '<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.7l-5.1 2.7 1-5.6-4.1-4 5.7-.8z"/>',
  logout: '<path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10"/>',
};

const icon = (name, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ---------------------------------------------------------------------------
// Status vocabulary

const STALE_SEC = 10 * 60;

const RUN_STATES = {
  finished: { label: 'Finished', tone: 'good', icon: 'checkCircle' },
  crashed: { label: 'Crashed', tone: 'serious', icon: 'bolt' },
  failed: { label: 'Failed', tone: 'critical', icon: 'xCircle' },
  killed: { label: 'Stopped', tone: 'muted', icon: 'stop' },
  preempting: { label: 'Preempting', tone: 'warning', icon: 'clock' },
  preempted: { label: 'Preempted', tone: 'warning', icon: 'clock' },
  pending: { label: 'Pending', tone: 'warning', icon: 'clock' },
};

function runHealth(run) {
  const st = String(run.state || '').toLowerCase();
  if (st === 'running') {
    const hb = toDate(run.heartbeatAt);
    const age = hb ? (Date.now() - hb.getTime()) / 1000 : 0;
    if (age > STALE_SEC) return { key: 'stale', label: 'No heartbeat', tone: 'warning', icon: 'alert', age };
    return { key: 'running', label: 'Running', tone: 'live', age };
  }
  return { key: st, ...(RUN_STATES[st] || { label: st ? st[0].toUpperCase() + st.slice(1) : 'Unknown', tone: 'muted', icon: 'clock' }) };
}

const SWEEP_STATES = {
  RUNNING: { label: 'Running', tone: 'live' },
  PAUSED: { label: 'Paused', tone: 'warning', icon: 'pause' },
  PENDING: { label: 'Pending', tone: 'warning', icon: 'clock' },
  FINISHED: { label: 'Finished', tone: 'good', icon: 'checkCircle' },
  CANCELED: { label: 'Canceled', tone: 'muted', icon: 'stop' },
  CRASHED: { label: 'Crashed', tone: 'serious', icon: 'bolt' },
  FAILED: { label: 'Failed', tone: 'critical', icon: 'xCircle' },
};

const sweepHealth = (s) => SWEEP_STATES[String(s.state || '').toUpperCase()] || { label: s.state || 'Unknown', tone: 'muted', icon: 'clock' };

function markInner(h) {
  return h.tone === 'live' ? '<span class="pulse" aria-hidden="true"></span>' : icon(h.icon);
}

function badge(h) {
  return `<span class="badge tone-${h.tone}">${markInner(h)}<span>${esc(h.label)}</span></span>`;
}

function mark(h) {
  return `<span class="mark tone-${h.tone}" role="img" aria-label="${esc(h.label)}" title="${esc(h.label)}">${markInner(h)}</span>`;
}

// ---------------------------------------------------------------------------
// App state and API access

const app = {
  config: null,
  viewer: null,
  entities: [],
  scope: store.get('scope', null),
};

class ApiError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

async function api(path, body) {
  const init = { credentials: 'same-origin', headers: { 'X-Requested-With': 'watchboard' } };
  if (body !== undefined) {
    init.method = 'POST';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('Cannot reach the watchBoard server. Check that it is still running and that your phone is on the same network.', 'network');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON error page.
  }
  if (res.status === 401 && data?.error === 'auth') {
    showLogin('Your session ended. Enter the passcode again.');
    throw new ApiError('Sign in to continue.', 'auth');
  }
  if (!res.ok) throw new ApiError(data?.message || `Request failed with HTTP ${res.status}.`, data?.error || 'http');
  return data;
}

// ---------------------------------------------------------------------------
// Transport. The Android app talks to W&B directly through its RawHttp plugin
// (native HTTP is not bound by browser CORS rules, and returns bodies untouched).
// In a desktop browser the app talks to server.js, which holds the key.

const NATIVE = Capacitor.isNativePlatform();
const DIRECT = NATIVE || store.get('mode', '') === 'direct';
const RawHttp = NATIVE ? registerPlugin('RawHttp') : null;

const basicAuth = (key) => `Basic ${btoa(`api:${key}`)}`;
const getConn = () => store.get('conn', null);

async function rawRequest({ url, method = 'GET', headers = {}, body = null }) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Keep the raw string for the message.
  }
  if (RawHttp) {
    try {
      const res = await RawHttp.request({ url, method, headers, body, timeoutMs: 45000 });
      return { status: res.status, text: res.body || '' };
    } catch (err) {
      throw new ApiError(`Could not reach ${host}. Check your internet connection. ${err?.message || ''}`.trim(), 'network');
    }
  }
  try {
    const res = await fetch(url, { method, headers, body: body ?? undefined });
    return { status: res.status, text: await res.text() };
  } catch {
    throw new ApiError(`Could not reach ${host}. Check your internet connection.`, 'network');
  }
}

async function directGraphQL(query, variables = {}, conn = getConn()) {
  if (!conn?.apiKey) {
    showLogin();
    throw new ApiError('Add your W&B API key to continue.', 'auth');
  }
  const { status, text } = await rawRequest({
    url: `${conn.baseUrl}/graphql`,
    method: 'POST',
    headers: { Authorization: basicAuth(conn.apiKey), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Handled below.
  }
  if (status === 401 || status === 403) {
    throw new ApiError('W&B rejected this API key. Open Settings, remove the key, then add a current one.', 'wandb_auth');
  }
  if (status === 429) throw new ApiError('W&B is rate limiting requests. Wait a minute, then refresh.', 'rate_limited');
  if (!data || status >= 500 || (data.data === undefined && !Array.isArray(data.errors))) {
    throw new ApiError(`W&B returned HTTP ${status}. ${text.replace(/\s+/g, ' ').slice(0, 200)}`.trim(), 'upstream');
  }
  return data;
}

async function directMutation(query, variables) {
  if (!store.get('actions', true)) throw new ApiError('Actions are turned off in Settings.', 'actions_off');
  const d = await directGraphQL(query, variables);
  if (d.errors?.length) throw new ApiError(d.errors.map((e) => e.message).join('; '), 'graphql');
  return d.data || {};
}

const BAD_KEY = 'W&B did not accept this API key. Copy it again from wandb.ai/authorize.';

const directTransport = {
  credential: 'key',
  async session() {
    const c = getConn();
    return { authed: Boolean(c?.apiKey), hasKey: Boolean(c?.apiKey) };
  },
  async config() {
    const c = getConn() || wandbUrls();
    return { appUrl: c.appUrl, baseUrl: c.baseUrl, traceUrl: c.traceUrl, actions: store.get('actions', true), version: VERSION };
  },
  async login({ secret, host }) {
    const conn = { apiKey: String(secret || '').trim(), ...wandbUrls(host) };
    if (!conn.apiKey) throw new ApiError('Paste your API key first.', 'bad_key');
    if (!/^https:\/\//i.test(conn.baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?$/i.test(conn.baseUrl)) {
      throw new ApiError('The API host must start with https://', 'bad_host');
    }
    let d;
    try {
      d = await directGraphQL(Q.viewer, {}, conn);
    } catch (err) {
      throw err.kind === 'wandb_auth' ? new ApiError(BAD_KEY, 'wandb_auth') : err;
    }
    if (!d.data?.viewer) throw new ApiError(BAD_KEY, 'wandb_auth');
    store.set('conn', conn);
    return { ok: true, hasKey: true };
  },
  async logout() {
    store.set('conn', null);
  },
  graphql: (query, variables) => directGraphQL(query, variables),
  async weaveCalls(req) {
    const conn = getConn();
    let body;
    try {
      body = weaveQueryBody(req);
    } catch (err) {
      throw new ApiError(err.message, 'bad_request');
    }
    const send = () => rawRequest({
      url: `${conn.traceUrl}/calls/stream_query`,
      method: 'POST',
      headers: { Authorization: basicAuth(conn.apiKey), 'Content-Type': 'application/json', Accept: 'application/jsonl' },
      body: JSON.stringify(body),
    });
    let res = await send();
    if (res.status === 422 && body.columns) {
      // The server rejected a column name; ask for whole rows instead.
      delete body.columns;
      res = await send();
    }
    if (res.status === 401) throw new ApiError('W&B rejected this API key for Weave.', 'wandb_auth');
    if (res.status === 403) throw new ApiError('This API key cannot read Weave traces for this project.', 'weave');
    if (res.status >= 400) {
      throw new ApiError(`The Weave trace server returned HTTP ${res.status}. ${weaveErrorReason(res.text).slice(0, 240)}`, 'weave');
    }
    return { calls: parseJsonl(res.text) };
  },
  stopRun: (id) => directMutation(STOP_RUN, { id }),
  sweepState: (id, state) => directMutation(SWEEP_STATE, { id, state }),
};

const serverTransport = {
  credential: 'passcode',
  async session() {
    const res = await fetch('/api/session', { credentials: 'same-origin' });
    return res.json();
  },
  config: () => api('/api/config'),
  login: ({ secret }) => api('/api/login', { passcode: secret }),
  logout: () => api('/api/logout', {}),
  graphql: (query, variables) => api('/api/graphql', { query, variables }),
  weaveCalls: (req) => api('/api/weave/calls', req),
  stopRun: (id) => api('/api/action/stop-run', { id }),
  sweepState: (id, state) => api('/api/action/sweep-state', { id, state }),
};

const transport = DIRECT ? directTransport : serverTransport;

async function gql(query, variables = {}) {
  const res = await transport.graphql(query, variables);
  if (res.errors?.length && !res.data) throw new ApiError(res.errors.map((e) => e.message).join('; '), 'graphql');
  if (res.errors?.length) console.warn('W&B returned partial errors', res.errors);
  return res.data || {};
}

async function ensureViewer() {
  if (!app.viewer) {
    const d = await gql(Q.viewer);
    if (!d.viewer) throw new ApiError('W&B did not return an account for this API key.', 'graphql');
    app.viewer = d.viewer;
    app.entities = unique([d.viewer.entity, ...edges(d.viewer.teams).map((t) => t.name)]);
  }
  return app.viewer;
}

function projectBase(entity, project) {
  return `#/p/${enc(entity)}/${enc(project)}`;
}

function webUrl(...parts) {
  return [app.config?.appUrl || 'https://wandb.ai', ...parts.map((p) => enc(p))].join('/');
}

function setScope(entity, project) {
  if (!entity || !project || project.startsWith('wandb-registry-')) return;
  if (app.scope?.entity === entity && app.scope?.project === project) return;
  app.scope = { entity, project };
  store.set('scope', app.scope);
  renderDrawer();
  renderTabbar();
}

// Project-level preference: pinned chart keys. The first pin is the headline metric.
const pinsKey = (entity, project) => `pins:${entity}/${project}`;
const getPins = (entity, project) => store.get(pinsKey(entity, project), []);

// Object detection runs (Ultralytics YOLO and RT-DETR log metrics/mAP50(B) and
// metrics/mAP50-95(B)). Box metrics win over mask metrics for segmentation runs.
const squash = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

function detectionKeys(summary) {
  if (!summary) return null;
  const keys = Object.keys(summary).filter((k) => typeof summary[k] === 'number');
  const rank = (k) => (/\(B\)$/.test(k) ? 0 : /\(M\)$/.test(k) ? 2 : 1);
  const pick = (test) => keys.filter((k) => test(squash(k))).sort((a, b) => rank(a) - rank(b) || a.length - b.length)[0];
  const m5095 = pick((n) => n.includes('map5095'));
  const m50 = pick((n) => n.includes('map50') && !n.includes('map5095'));
  return m50 && m5095 ? { m50, m5095 } : null;
}

function metricLabel(key) {
  const n = squash(key);
  const mask = /\(M\)$/.test(key) ? ' mask' : '';
  if (n.includes('map5095')) return `mAP50-95${mask}`;
  if (n.includes('map50')) return `mAP50${mask}`;
  return key;
}

const configValue = (config, key) => {
  const v = config?.[key];
  return v && typeof v === 'object' && 'value' in v ? v.value : v;
};

// How many times a training loss was logged. Ultralytics logs train/* once per epoch, but
// after training it also logs a final best.pt validation and plots, each at a new step, so
// a finished run's last step (50) runs ahead of the epochs actually trained (48).
function trainedEpochs(historyKeys) {
  let most = 0;
  for (const [k, v] of Object.entries(historyKeys?.keys || {})) {
    if (!k.startsWith('train/')) continue;
    const n = (v?.typeCounts || []).reduce((sum, t) => sum + (t.type === 'number' ? t.count : 0), 0);
    if (n > most) most = n;
  }
  return most;
}

// Runs that log an `epoch` metric use it. Ultralytics runs (one history row per epoch) use
// the training-loss count, falling back to the step when the history keys are not loaded.
function epochInfo(r) {
  const s = r.summary || {};
  const totalRaw = Number(configValue(r.config, 'epochs'));
  const total = Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : null;
  if (typeof s.epoch === 'number') return { epoch: Math.round(s.epoch), total };
  const ultralytics = Object.keys(s).some((k) => /^metrics\/(mAP|precision|recall)/.test(k)) || configValue(r.config, 'imgsz') !== undefined;
  if (!ultralytics) return null;
  const trained = trainedEpochs(r.historyKeys);
  if (trained) return { epoch: trained, total };
  return typeof s._step === 'number' ? { epoch: s._step, total } : null;
}

const fmtMetric = (v) => (typeof v !== 'number' ? '' : Math.abs(v) <= 1 ? v.toFixed(3) : formatValue(v));

function pickMetric(summary, entity, project) {
  if (!summary) return null;
  for (const k of getPins(entity, project)) if (typeof summary[k] === 'number') return k;
  const det = detectionKeys(summary);
  if (det) return det.m5095;
  const keys = Object.keys(summary).filter((k) => !k.startsWith('_') && typeof summary[k] === 'number' && !k.startsWith('system'));
  const score = (k) => (/(^|\/)loss$/i.test(k) ? 0 : /loss/i.test(k) ? 1 : /acc|reward|score|f1|auc|map|bleu|rouge|perplexity/i.test(k) ? 2 : 3);
  keys.sort((a, b) => score(a) - score(b) || a.length - b.length || a.localeCompare(b));
  return keys[0] || null;
}

function enrichRun(run, entity, project) {
  return { ...run, entity, project, summary: parseJSON(run.summaryMetrics), config: parseJSON(run.config), historyKeys: parseJSON(run.historyKeys) };
}

function runtimeSec(r) {
  const created = toDate(r.createdAt);
  if (String(r.state).toLowerCase() === 'running' && created) return (Date.now() - created.getTime()) / 1000;
  const fromSummary = r.summary?._runtime;
  if (typeof fromSummary === 'number' && fromSummary > 0) return fromSummary;
  const end = toDate(r.heartbeatAt);
  return created && end ? Math.max(0, (end - created) / 1000) : null;
}

const runHref = (r) => `${projectBase(r.entity, r.project)}/runs/${enc(r.name)}`;

// ---------------------------------------------------------------------------
// Shared view pieces

function skelList(n = 4) {
  return `<div class="list" aria-busy="true">${Array.from({ length: n }, () => '<div class="row"><span class="row-main"><span class="skel w60"></span><span class="skel w40"></span></span></div>').join('')}</div>`;
}

function emptyState(title, body = '', action = '') {
  return `<div class="state"><h3>${esc(title)}</h3>${body ? `<p>${body}</p>` : ''}${action}</div>`;
}

function errorState(err) {
  return `<div class="state"><span class="state-ic tone-critical">${icon('alert')}</span><h3>This did not load</h3><p>${esc(err.message)}</p><button class="btn" type="button" data-retry>Try again</button></div>`;
}

function sectionHead(title, link = '') {
  return `<div class="section-head"><h3>${esc(title)}</h3>${link}</div>`;
}

function runRow(r, { showProject = false } = {}) {
  const h = runHealth(r);
  const key = pickMetric(r.summary, r.entity, r.project);
  const val = key ? r.summary[key] : undefined;
  const rt = runtimeSec(r);
  const meta = [
    showProject ? `<span>${esc(r.project)}</span>` : '',
    h.key === 'running' || h.key === 'stale' ? `<span>${icon('pulse', 'ic sm')}${esc(ago(r.heartbeatAt))}</span>` : `<span>${esc(ago(r.createdAt))}</span>`,
    rt ? `<span>${esc(formatSeconds(rt))}</span>` : '',
    !showProject && r.user?.username ? `<span>${esc(r.user.username)}</span>` : '',
  ].join('');
  return `<a class="row" href="${runHref(r)}">
    ${mark(h)}
    <span class="row-main">
      <span class="row-title">${esc(r.displayName || r.name)}</span>
      <span class="row-meta">${meta}</span>
    </span>
    ${typeof val === 'number' ? `<span class="row-side"><span class="metric-key">${esc(metricLabel(key))}</span><span class="metric-val">${esc(fmtMetric(val))}</span></span>` : ''}
  </a>`;
}

// Training now card for detection runs: epoch progress, then mAP50 and mAP50-95 tiles
// whose change and sparkline are filled in by fillSparklines.
function detectionCard(r, det) {
  const h = runHealth(r);
  const ep = epochInfo(r);
  const rt = runtimeSec(r);
  const pct = ep?.total ? Math.min(100, (ep.epoch / ep.total) * 100) : null;
  const tile = (key, slot) => `<span class="mtile">
      <span class="mtile-label"><i class="swatch" style="background:var(--series-${slot})"></i>${esc(metricLabel(key))}</span>
      <span class="mtile-row"><span class="mtile-val">${esc(fmtMetric(r.summary[key]))}</span><span class="delta" data-delta="${esc(key)}"></span></span>
      <span class="mtile-spark" data-spark-key="${esc(key)}"></span>
    </span>`;
  return `<a class="row live-card" href="${runHref(r)}" data-live="${esc(r.id)}">
    ${mark(h)}
    <span class="row-main">
      <span class="live-top"><span class="row-title">${esc(r.displayName || r.name)}</span>
        ${ep ? `<span class="epoch">Epoch ${esc(ep.epoch.toLocaleString())}${ep.total ? ` of ${esc(ep.total.toLocaleString())}` : ''}</span>` : ''}</span>
      <span class="row-meta"><span>${esc(r.project)}</span>${rt ? `<span>${esc(formatSeconds(rt))}</span>` : ''}<span>${icon('pulse', 'ic sm')}${esc(ago(r.heartbeatAt))}</span></span>
      ${pct !== null ? `<span class="progress" role="progressbar" aria-label="Epochs done" aria-valuemin="0" aria-valuemax="${ep.total}" aria-valuenow="${ep.epoch}"><span style="width:${pct.toFixed(1)}%"></span></span>` : ''}
      <span class="mtiles">${tile(det.m50, 1)}${tile(det.m5095, 2)}</span>
    </span>
  </a>`;
}

function liveRow(r) {
  const det = detectionKeys(r.summary);
  if (det) return detectionCard(r, det);
  const h = runHealth(r);
  const key = pickMetric(r.summary, r.entity, r.project);
  const val = key ? r.summary[key] : undefined;
  const step = r.summary?._step;
  const rt = runtimeSec(r);
  return `<a class="row live-row" href="${runHref(r)}">
    ${mark(h)}
    <span class="row-main">
      <span class="row-title">${esc(r.displayName || r.name)}</span>
      <span class="row-meta"><span>${esc(r.project)}</span>${typeof step === 'number' ? `<span>step ${esc(step.toLocaleString())}</span>` : ''}${rt ? `<span>${esc(formatSeconds(rt))}</span>` : ''}<span>${icon('pulse', 'ic sm')}${esc(ago(r.heartbeatAt))}</span></span>
    </span>
    <span class="row-side">
      <span class="spark-slot" data-spark="${esc(r.id)}"></span>
      ${typeof val === 'number' ? `<span class="metric-key">${esc(metricLabel(key))}</span><span class="metric-val">${esc(fmtMetric(val))}</span>` : ''}
    </span>
  </a>`;
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

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 3200);
}

function confirmSheet({ title, body, confirm, danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <h2 id="sheet-title">${esc(title)}</h2><p>${esc(body)}</p>
      <div class="sheet-actions"><button class="btn" type="button" data-answer="no">Cancel</button>
      <button class="btn ${danger ? 'danger-solid' : 'primary'}" type="button" data-answer="yes">${esc(confirm)}</button></div></div>`;
    const done = (yes) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(yes);
    };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-answer]');
      if (b) done(b.dataset.answer === 'yes');
      else if (e.target === wrap) done(false);
    });
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    $('[data-answer="yes"]', wrap).focus();
  });
}

function kvTable(rows) {
  if (!rows.length) return '';
  return `<div class="list"><table class="kv"><tbody>${rows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`).join('')}</tbody></table></div>`;
}

function displayValue(v) {
  if (typeof v === 'number') return esc(formatValue(v));
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null || v === undefined) return '<span class="muted">none</span>';
  if (typeof v === 'string') return esc(v.length > 160 ? `${v.slice(0, 160)}...` : v);
  if (Array.isArray(v)) return esc(v.length <= 6 && v.every((x) => typeof x !== 'object') ? `[${v.join(', ')}]` : `[${v.length} items]`);
  if (typeof v === 'object' && v._type) return `<span class="muted">${esc(v._type)}</span>`;
  return esc(JSON.stringify(v).slice(0, 160));
}

function flatten(obj, prefix = '', out = [], depth = 0) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !v._type && depth < 3) flatten(v, key, out, depth + 1);
    else out.push([key, v]);
  }
  return out;
}

function chips(items, current, attr) {
  return `<div class="chips" role="group">${items.map(([value, label]) =>
    `<button class="chip" type="button" ${attr}="${esc(value)}" aria-pressed="${value === current}">${esc(label)}</button>`).join('')}</div>`;
}

function searchBox(id, placeholder, value = '') {
  return `<label class="search">${icon('search')}<input id="${id}" type="search" placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`;
}

function jsonBlock(value, limit = 20000) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = 'null';
  const cut = text.length > limit;
  return `<pre class="code">${esc(cut ? text.slice(0, limit) : text)}</pre>${cut ? `<p class="note">Showing the first ${limit.toLocaleString()} characters. Open in W&B for the full value.</p>` : ''}`;
}

// ---------------------------------------------------------------------------
// Shell: header, drawer, tab bar

function setHeader({ title, crumb = '', back = '' }) {
  $('#title').textContent = title;
  $('#crumb').textContent = crumb;
  $('#crumb').hidden = !crumb;
  const backBtn = $('#back-btn');
  backBtn.hidden = !back;
  if (back) backBtn.setAttribute('href', back);
  $('#menu-btn').hidden = Boolean(back);
  document.title = title === 'watchBoard' ? 'watchBoard' : `${title} | watchBoard`;
}

function navKey(path) {
  if (path === '/') return 'dashboard';
  if (path.startsWith('/projects')) return 'projects';
  if (path.startsWith('/registry')) return 'registry';
  if (path.startsWith('/settings')) return 'settings';
  const m = /^\/p\/[^/]+\/[^/]+(?:\/([^/]+))?/.exec(path);
  if (m) return m[1] || 'overview';
  return '';
}

function renderDrawer() {
  const s = app.scope;
  const base = s ? projectBase(s.entity, s.project) : '';
  const item = (href, ic, label, key) => `<a class="nav-item" href="${href}" data-nav="${key}">${icon(ic)}<span>${esc(label)}</span></a>`;
  const ext = (href, label) => `<a class="nav-item" href="${esc(href)}" target="_blank" rel="noopener">${icon('external')}<span>${esc(label)}</span></a>`;
  $('#drawer').innerHTML = `
    <div class="brand"><img class="brand-logo" src="/logo.svg" alt="">watchBoard</div>
    <div class="nav-group">
      ${item('#/', 'dashboard', 'Dashboard', 'dashboard')}
      ${item('#/projects', 'folder', 'Projects', 'projects')}
    </div>
    <div class="nav-group">
      ${s ? `<div class="nav-head"><span class="nav-scope"><span>${esc(s.entity)}/</span>${esc(s.project)}</span><a class="nav-switch" href="#/projects">Switch</a></div>
        ${item(base, 'overview', 'Overview', 'overview')}
        ${item(`${base}/runs`, 'pulse', 'Runs', 'runs')}
        ${item(`${base}/sweeps`, 'sweeps', 'Sweeps', 'sweeps')}
        ${item(`${base}/artifacts`, 'box', 'Artifacts', 'artifacts')}
        ${item(`${base}/reports`, 'report', 'Reports', 'reports')}
        ${item(`${base}/weave`, 'traces', 'Weave traces', 'weave')}`
      : '<p class="nav-hint">Pick a project to open its runs, sweeps, artifacts, reports and Weave traces.</p>'}
    </div>
    <div class="nav-group">
      ${item('#/registry', 'registry', 'Registry', 'registry')}
      ${item('#/settings', 'settings', 'Settings', 'settings')}
    </div>
    <div class="nav-group">
      <div class="nav-head"><span>Open in W&B</span></div>
      ${s ? ext(webUrl(s.entity, s.project), 'This project') : ''}
      ${ext(webUrl('launch'), 'Launch')}
      ${ext(webUrl('home'), 'W&B home')}
    </div>`;
  markActiveNav();
}

function renderTabbar() {
  const s = app.scope;
  const base = s ? projectBase(s.entity, s.project) : '';
  const tab = (href, ic, label, key) => `<a class="tab" href="${href}" data-nav="${key}">${icon(ic)}<span>${esc(label)}</span></a>`;
  $('#tabbar').innerHTML = `
    ${tab('#/', 'dashboard', 'Dashboard', 'dashboard')}
    ${tab(s ? `${base}/runs` : '#/projects?next=runs', 'pulse', 'Runs', 'runs')}
    ${tab(s ? `${base}/weave` : '#/projects?next=weave', 'traces', 'Traces', 'weave')}
    <button class="tab" type="button" data-open-menu>${icon('more')}<span>Menu</span></button>`;
  markActiveNav();
}

function markActiveNav() {
  const key = navKey(currentPath());
  for (const a of $$('[data-nav]')) {
    if (a.dataset.nav === key) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function openDrawer() {
  $('#drawer').classList.add('open');
  $('#scrim').hidden = false;
  $('#menu-btn').setAttribute('aria-expanded', 'true');
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#scrim').hidden = true;
  $('#menu-btn').setAttribute('aria-expanded', 'false');
}

// AMOLED black unless the viewer picks Light or Match device in Settings.
const DEFAULT_THEME = 'dark';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  if (NATIVE) {
    // Keep the Android status bar icons readable against the app background.
    const dark = theme === 'dark' || (theme !== 'light' && darkQuery.matches);
    SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => {});
  }
}

darkQuery.addEventListener('change', () => applyTheme(store.get('theme', DEFAULT_THEME)));

// ---------------------------------------------------------------------------
// Router

const ROUTES = [
  ['/', viewDashboard],
  ['/projects', viewProjects],
  ['/p/:entity/:project', viewProject],
  ['/p/:entity/:project/runs', viewRuns],
  ['/p/:entity/:project/runs/:run', viewRun],
  ['/p/:entity/:project/sweeps', viewSweeps],
  ['/p/:entity/:project/sweeps/:sweep', viewSweep],
  ['/p/:entity/:project/artifacts', viewArtifacts],
  ['/p/:entity/:project/artifacts/:type/:collection', viewArtifactVersions],
  ['/p/:entity/:project/reports', viewReports],
  ['/p/:entity/:project/weave', viewTraces],
  ['/p/:entity/:project/weave/:call', viewTrace],
  ['/registry', viewRegistries],
  ['/registry/:entity/:project', viewRegistry],
  ['/settings', viewSettings],
].map(([pattern, view]) => {
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
  current = { id, cleanups: [] };

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
  if (params.entity && params.project && path.startsWith('/p/')) setScope(params.entity, params.project);
  markActiveNav();

  const ctx = {
    params,
    query,
    root,
    path,
    stale: () => current.id !== id,
    cleanup: (fn) => current.cleanups.push(fn),
    every(ms, fn) {
      const t = setInterval(() => { if (!document.hidden && current.id === id) fn(); }, ms);
      current.cleanups.push(() => clearInterval(t));
    },
    // Keeps the URL in sync with in-page filters without re-rendering.
    replaceQuery(next) {
      const qs = new URLSearchParams(next);
      for (const [k, v] of [...qs]) if (!v) qs.delete(k);
      const s = qs.toString();
      history.replaceState(null, '', `#${path}${s ? `?${s}` : ''}`);
    },
  };

  if (!match) {
    setHeader({ title: 'Not found' });
    root.innerHTML = emptyState('This page does not exist.', '', '<a class="btn" href="#/">Go to the dashboard</a>');
    return;
  }
  try {
    await match.view(ctx);
  } catch (err) {
    if (ctx.stale() || err.kind === 'auth') return;
    console.error(err);
    root.innerHTML = errorState(err);
    $('[data-retry]', root)?.addEventListener('click', render);
  }
}

// ---------------------------------------------------------------------------
// Dashboard

function heroTrace(mode, animate) {
  // A heartbeat when something is training, a flat line when nothing is.
  const d = mode === 'flat'
    ? 'M0 24 H320'
    : 'M0 24 H96 l6 -4 l5 4 H128 l5 -18 l7 34 l6 -24 l5 8 H206 l5 -6 l5 6 H320';
  return `<svg class="ekg ekg-${mode}${animate ? ' draw' : ''}" viewBox="0 0 320 48" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" pathLength="1"/></svg>`;
}

async function viewDashboard(ctx) {
  setHeader({ title: 'Dashboard' });
  ctx.root.innerHTML = `<section class="hero" id="hero"><span class="skel w80 tall"></span><span class="skel w60"></span></section><div id="dash">${skelList(3)}</div>`;

  const cache = { projects: null, at: 0 };
  let painted = false;

  const load = async () => {
    await ensureViewer();
    if (!cache.projects || Date.now() - cache.at > 10 * 60e3) {
      const d = await gql(dashProjectsQuery(app.entities));
      const all = Object.values(d).flatMap(edges);
      all.sort((a, b) => (toDate(b.updatedAt) || 0) - (toDate(a.updatedAt) || 0));
      cache.projects = all;
      cache.at = Date.now();
    }
    const top = cache.projects.slice(0, 8);
    const live = [];
    const recent = [];
    if (top.length) {
      const d = await gql(dashRunsQuery(top), { running: F.state('running') });
      top.forEach((p, i) => {
        const node = d[`p${i}`];
        if (!node) return;
        for (const r of edges(node.live)) live.push(enrichRun(r, p.entityName, p.name));
        for (const r of edges(node.recent)) recent.push(enrichRun(r, p.entityName, p.name));
      });
    }
    return { top, live, recent };
  };

  const paint = ({ top, live, recent }) => {
    const now = Date.now();
    const endedWithin = (r, hours) => {
      const d = toDate(r.heartbeatAt) || toDate(r.createdAt);
      return d && now - d.getTime() < hours * 3600e3;
    };
    const healthy = live.filter((r) => runHealth(r).key === 'running');
    const stale = live.filter((r) => runHealth(r).key === 'stale');
    const ended = recent.filter((r) => String(r.state).toLowerCase() !== 'running');
    ended.sort((a, b) => (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0));
    const broke = ended.filter((r) => ['crashed', 'failed'].includes(String(r.state).toLowerCase()));
    const broke24 = broke.filter((r) => endedWithin(r, 24));
    const fin24 = ended.filter((r) => String(r.state).toLowerCase() === 'finished' && endedWithin(r, 24));
    const attention = [...stale, ...broke.filter((r) => endedWithin(r, 48))];

    let lead;
    if (!top.length) lead = 'No projects yet.';
    else if (healthy.length) lead = `${plural(healthy.length, 'run')} training right now.`;
    else lead = 'Nothing is training right now.';
    const sub = [];
    if (stale.length) sub.push(`${plural(stale.length, 'run')} stopped sending heartbeats.`);
    const parts = [];
    if (fin24.length) parts.push(`${fin24.length} finished`);
    if (broke24.length) parts.push(`${broke24.length} crashed or failed`);
    if (top.length) sub.push(parts.length ? `${joinAnd(parts)} in the last 24 hours.` : 'No runs ended in the last 24 hours.');
    const mode = healthy.length ? 'live' : stale.length ? 'stale' : 'flat';
    const time = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

    $('#hero', ctx.root).innerHTML = `
      ${heroTrace(mode, !painted)}
      <h2>${esc(lead)}</h2>
      ${sub.length ? `<p>${esc(sub.join(' '))}</p>` : ''}
      <p class="stamp">Updated at ${esc(time)}. Refreshes every 30 seconds.</p>`;
    painted = true;

    if (!top.length) {
      $('#dash', ctx.root).innerHTML = emptyState('No projects found', `Runs you log with <code>wandb.init()</code> under ${esc(app.viewer.entity)} or your teams show up here.`);
      return;
    }

    const recentOthers = ended.slice(0, 10);
    $('#dash', ctx.root).innerHTML = `
      ${healthy.length ? `${sectionHead('Training now')}<div class="list">${healthy.map(liveRow).join('')}</div>` : ''}
      ${attention.length ? `${sectionHead('Needs a look')}<div class="list">${attention.map((r) => runRow(r, { showProject: true })).join('')}</div>` : ''}
      ${sectionHead('Recent runs')}
      ${recentOthers.length ? `<div class="list">${recentOthers.map((r) => runRow(r, { showProject: true })).join('')}</div>` : '<p class="note">No finished runs in your active projects yet.</p>'}
      ${sectionHead('Active projects', '<a href="#/projects">All projects</a>')}
      <div class="list">${top.slice(0, 6).map((p) => `<a class="row" href="${projectBase(p.entityName, p.name)}">
        <span class="mark tone-muted">${icon('folder')}</span>
        <span class="row-main"><span class="row-title">${esc(p.name)}</span><span class="row-meta"><span>${esc(p.entityName)}</span><span>updated ${esc(ago(p.updatedAt))}</span></span></span>
        ${icon('chevron', 'ic chev')}</a>`).join('')}</div>`;

    fillSparklines(ctx, healthy.slice(0, 12));
  };

  const refresh = async () => {
    const data = await load();
    if (!ctx.stale()) paint(data);
  };

  await refresh();
  ctx.every(30000, () => refresh().catch((err) => console.warn('Dashboard refresh failed', err)));
}

function fillSparklines(ctx, runs) {
  const items = runs
    .map((r) => {
      const det = detectionKeys(r.summary);
      const keys = det ? [det.m50, det.m5095] : [pickMetric(r.summary, r.entity, r.project)].filter(Boolean);
      return { id: r.id, entity: r.entity, project: r.project, run: r.name, det: Boolean(det), keys };
    })
    .filter((it) => it.keys.length);
  if (!items.length) return;
  const vars = {};
  items.forEach((it, i) => { vars[`s${i}`] = [JSON.stringify({ keys: ['_step', ...it.keys], samples: 200 })]; });
  gql(sparkQuery(items), vars)
    .then((d) => {
      if (ctx.stale()) return;
      items.forEach((it, i) => {
        const rows = d[`r${i}`]?.run?.sampledHistory?.[0] || [];
        if (!it.det) {
          const slot = ctx.root.querySelector(`[data-spark="${CSS.escape(it.id)}"]`);
          if (slot) slot.innerHTML = sparkline(rows.map((o) => [o._step, o[it.keys[0]]]));
          return;
        }
        const card = ctx.root.querySelector(`[data-live="${CSS.escape(it.id)}"]`);
        if (!card) return;
        it.keys.forEach((key, k) => {
          const pts = rows.map((o) => [o._step, o[key]]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
          const slot = card.querySelector(`[data-spark-key="${CSS.escape(key)}"]`);
          if (slot) slot.innerHTML = sparkline(pts, { width: 128, height: 32, color: `var(--series-${k + 1})` });
          // Change since the previous epoch; higher mAP is better.
          const delta = card.querySelector(`[data-delta="${CSS.escape(key)}"]`);
          if (delta && pts.length >= 2) {
            const diff = pts[pts.length - 1][1] - pts[pts.length - 2][1];
            const dir = Math.abs(diff) < 5e-4 ? 'flat' : diff > 0 ? 'up' : 'down';
            delta.innerHTML = dir === 'flat'
              ? 'no change'
              : `<i class="${dir}" aria-hidden="true">${dir === 'up' ? '▲' : '▼'}</i><span class="sr-only">${dir === 'up' ? 'up' : 'down'} </span>${esc(Math.abs(diff).toFixed(3))}`;
          }
        });
      });
    })
    .catch((err) => console.warn('Sparklines failed', err));
}

// ---------------------------------------------------------------------------
// Projects

async function viewProjects(ctx) {
  setHeader({ title: 'Projects' });
  ctx.root.innerHTML = skelList(6);
  await ensureViewer();
  const next = ctx.query.get('next');
  let entity = ctx.query.get('entity') || app.scope?.entity || app.viewer.entity;
  if (!app.entities.includes(entity)) entity = app.viewer.entity;

  ctx.root.innerHTML = `
    ${next ? `<p class="note">Pick a project to open its ${next === 'weave' ? 'Weave traces' : 'runs'}.</p>` : ''}
    ${app.entities.length > 1 ? chips(app.entities.map((e) => [e, e]), entity, 'data-entity') : ''}
    ${searchBox('project-search', 'Filter projects')}
    <div id="plist">${skelList(6)}</div>`;

  $$('[data-entity]', ctx.root).forEach((b) => b.addEventListener('click', () => {
    const qs = new URLSearchParams({ entity: b.dataset.entity });
    if (next) qs.set('next', next);
    location.hash = `#/projects?${qs}`;
  }));

  const projects = [];
  let cursor = null;
  for (let page = 0; page < 5; page++) {
    const d = await gql(Q.projects, { entity, cursor, perPage: 100 });
    projects.push(...edges(d.models));
    if (!d.models?.pageInfo?.hasNextPage) break;
    cursor = d.models.pageInfo.endCursor;
  }
  if (ctx.stale()) return;
  projects.sort((a, b) => (toDate(b.updatedAt) || 0) - (toDate(a.updatedAt) || 0));

  const list = $('#plist', ctx.root);
  const paint = (term) => {
    const t = term.trim().toLowerCase();
    const shown = t ? projects.filter((p) => p.name.toLowerCase().includes(t)) : projects;
    if (!projects.length) {
      list.innerHTML = emptyState(`No projects in ${entity}`, 'Projects appear here after you log a run to them.');
      return;
    }
    if (!shown.length) {
      list.innerHTML = `<p class="note">No project names contain "${esc(term)}".</p>`;
      return;
    }
    list.innerHTML = `<p class="count">${plural(shown.length, 'project')}</p><div class="list">${shown.map((p) => {
      const base = projectBase(p.entityName, p.name);
      const href = next === 'runs' ? `${base}/runs` : next === 'weave' ? `${base}/weave` : base;
      return `<a class="row" href="${href}">
        <span class="row-main"><span class="row-title">${esc(p.name)}</span>
        <span class="row-meta"><span>updated ${esc(ago(p.updatedAt))}</span>${p.description ? `<span class="clip">${esc(p.description)}</span>` : ''}</span></span>
        ${icon('chevron', 'ic chev')}</a>`;
    }).join('')}</div>`;
  };
  paint('');
  $('#project-search', ctx.root).addEventListener('input', (e) => paint(e.target.value));
}

// ---------------------------------------------------------------------------
// Project overview

async function viewProject(ctx) {
  const { entity, project } = ctx.params;
  const base = projectBase(entity, project);
  setHeader({ title: project, crumb: entity, back: '#/projects' });
  ctx.root.innerHTML = skelList(4);

  const d = await gql(Q.projectOverview, { entity, project, ...F.overviewFilters() });
  const p = d.project;
  if (!p) throw new ApiError(`${entity}/${project} was not found, or this API key cannot see it.`, 'not_found');
  const runs = edges(p.runs).map((r) => enrichRun(r, entity, project));

  const tile = (state, label, n, h) => `<a class="tile" href="${base}/runs${state ? `?state=${state}` : ''}">
    <span class="tile-n">${esc(Number(n || 0).toLocaleString())}</span>
    <span class="tile-l">${h ? mark(h) : ''}${esc(label)}</span></a>`;
  const tool = (href, ic, label, note = '', external = false) => `<a class="row" href="${esc(href)}" ${external ? 'target="_blank" rel="noopener"' : ''}>
    <span class="mark tone-muted">${icon(ic)}</span><span class="row-main"><span class="row-title">${esc(label)}</span>${note ? `<span class="row-meta"><span>${esc(note)}</span></span>` : ''}</span>
    ${icon(external ? 'external' : 'chevron', 'ic chev')}</a>`;

  ctx.root.innerHTML = `
    ${p.description ? `<p class="lede">${esc(p.description)}</p>` : ''}
    <div class="tiles">
      ${tile('running', 'Running', p.running, { tone: 'live', label: 'Running' })}
      ${tile('finished', 'Finished', p.finished, RUN_STATES.finished)}
      ${tile('crashed', 'Crashed', p.crashed, RUN_STATES.crashed)}
      ${tile('failed', 'Failed', p.failed, RUN_STATES.failed)}
      ${tile('', 'All runs', p.total)}
    </div>
    ${sectionHead('Tools')}
    <div class="list">
      ${tool(`${base}/runs`, 'pulse', 'Runs', plural(p.total || 0, 'run'))}
      ${tool(`${base}/sweeps`, 'sweeps', 'Sweeps', plural(p.totalSweeps || 0, 'sweep'))}
      ${tool(`${base}/artifacts`, 'box', 'Artifacts', 'Datasets, models and other versioned files')}
      ${tool(`${base}/reports`, 'report', 'Reports')}
      ${tool(`${base}/weave`, 'traces', 'Weave traces', 'LLM calls and evaluations')}
      ${tool(webUrl(entity, project), 'external', 'Open in W&B', 'Full workspace in the browser', true)}
    </div>
    ${sectionHead('Latest runs', `<a href="${base}/runs">All runs</a>`)}
    ${runs.length ? `<div class="list">${runs.map((r) => runRow(r)).join('')}</div>` : '<p class="note">No runs in this project yet.</p>'}
    <p class="note">Created ${esc(fmtDate(p.createdAt))}. Last updated ${esc(ago(p.updatedAt))}.</p>`;
}

// ---------------------------------------------------------------------------
// Runs list

const RUN_FILTERS = [['all', 'All'], ['running', 'Running'], ['finished', 'Finished'], ['crashed', 'Crashed'], ['failed', 'Failed'], ['killed', 'Stopped']];
const RUN_ORDERS = [['-created_at', 'Newest first'], ['+created_at', 'Oldest first'], ['-heartbeat_at', 'Recently active']];

async function viewRuns(ctx) {
  const { entity, project } = ctx.params;
  const base = projectBase(entity, project);
  const sweep = ctx.query.get('sweep') || '';
  setHeader({ title: sweep ? `Sweep ${sweep} runs` : 'Runs', crumb: `${entity}/${project}`, back: sweep ? `${base}/sweeps/${enc(sweep)}` : base });

  const st = { state: ctx.query.get('state') || 'all', order: ctx.query.get('order') || '-created_at', q: ctx.query.get('q') || '' };
  ctx.root.innerHTML = `
    ${chips(RUN_FILTERS, st.state, 'data-state')}
    <div class="toolbar">${searchBox('run-search', 'Search run names', st.q)}
      <label class="select"><span class="sr-only">Sort runs</span><select id="run-order">${RUN_ORDERS.map(([v, l]) => `<option value="${v}" ${v === st.order ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <p class="count" id="run-count"></p>
    <div id="run-list">${skelList(6)}</div>
    <div class="more"><button class="btn" type="button" id="run-more" hidden>Load more runs</button></div>`;

  const listEl = $('#run-list', ctx.root);
  const moreBtn = $('#run-more', ctx.root);
  let cursor = null;
  let seq = 0;

  const filters = () => {
    const conds = [];
    if (st.state !== 'all') conds.push({ state: st.state });
    if (st.q.trim()) conds.push({ display_name: { $regex: escapeRegex(st.q.trim()) } });
    if (sweep) conds.push({ sweep });
    return conds.length ? JSON.stringify({ $and: conds }) : null;
  };

  const load = async (append) => {
    const mySeq = ++seq;
    if (!append) {
      cursor = null;
      listEl.innerHTML = skelList(6);
    }
    moreBtn.disabled = true;
    try {
      const d = await gql(Q.runs, { entity, project, perPage: 25, order: st.order, filters: filters(), cursor });
      if (ctx.stale() || mySeq !== seq) return;
      const conn = d.project?.runs;
      if (!d.project) throw new ApiError(`${entity}/${project} was not found, or this API key cannot see it.`, 'not_found');
      const runs = edges(conn).map((r) => enrichRun(r, entity, project));
      $('#run-count', ctx.root).textContent = plural(d.project.runCount ?? runs.length, 'run');
      const html = runs.map((r) => runRow(r)).join('');
      if (append) $('.list', listEl)?.insertAdjacentHTML('beforeend', html);
      else listEl.innerHTML = runs.length ? `<div class="list">${html}</div>` : emptyState('No runs match', 'Try another state or search term.');
      cursor = conn?.pageInfo?.endCursor;
      moreBtn.hidden = !conn?.pageInfo?.hasNextPage;
    } catch (err) {
      if (mySeq !== seq) return;
      listEl.innerHTML = errorState(err);
      $('[data-retry]', listEl)?.addEventListener('click', () => load(false));
    } finally {
      moreBtn.disabled = false;
    }
  };

  const sync = () => ctx.replaceQuery({ state: st.state === 'all' ? '' : st.state, order: st.order === '-created_at' ? '' : st.order, q: st.q, sweep });

  $$('[data-state]', ctx.root).forEach((b) => b.addEventListener('click', () => {
    st.state = b.dataset.state;
    $$('[data-state]', ctx.root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    sync();
    load(false);
  }));
  $('#run-order', ctx.root).addEventListener('change', (e) => {
    st.order = e.target.value;
    sync();
    load(false);
  });
  $('#run-search', ctx.root).addEventListener('input', debounce((e) => {
    st.q = e.target.value;
    sync();
    load(false);
  }, 400));
  moreBtn.addEventListener('click', () => load(true));

  await load(false);
}

// ---------------------------------------------------------------------------
// Run detail

const RUN_TABS = [['charts', 'Charts'], ['overview', 'Overview'], ['system', 'System'], ['logs', 'Logs'], ['files', 'Files'], ['artifacts', 'Artifacts']];
const runCache = new Map();

async function fetchRun(entity, project, name, fresh = false) {
  const key = `${entity}/${project}/${name}`;
  const hit = runCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 20000) return hit.run;
  const d = await gql(Q.run, { entity, project, name });
  const run = d.project?.run;
  if (!run) throw new ApiError(`Run ${name} was not found in ${entity}/${project}.`, 'not_found');
  const r = { ...enrichRun(run, entity, project), config: parseJSON(run.config), historyKeys: parseJSON(run.historyKeys) };
  runCache.set(key, { at: Date.now(), run: r });
  return r;
}

function epochFact(r) {
  const ep = epochInfo(r);
  if (!ep) return '';
  return `<div><dt>Epoch</dt><dd>${esc(ep.epoch.toLocaleString())}${ep.total ? ` of ${esc(ep.total.toLocaleString())}` : ''}</dd></div>`;
}

function runHeadHtml(r) {
  const h = runHealth(r);
  const rt = runtimeSec(r);
  const step = r.historyKeys?.lastStep ?? r.summary?._step;
  const live = h.key === 'running' || h.key === 'stale';
  const canStop = live && app.config?.actions;
  return `
    <div class="head-line">${badge(h)}${live ? `<span class="muted">Last heartbeat ${esc(ago(r.heartbeatAt))}</span>` : ''}</div>
    <h2 class="run-name">${esc(r.displayName || r.name)}</h2>
    <p class="run-id">${esc(r.name)}${r.group ? ` in group ${esc(r.group)}` : ''}</p>
    <dl class="facts">
      <div><dt>Runtime</dt><dd>${rt ? esc(formatSeconds(rt)) : 'n/a'}</dd></div>
      ${epochFact(r) || `<div><dt>Step</dt><dd>${typeof step === 'number' && step >= 0 ? esc(step.toLocaleString()) : 'n/a'}</dd></div>`}
      <div><dt>Started</dt><dd>${esc(fmtDate(r.createdAt))}</dd></div>
      <div><dt>By</dt><dd>${esc(r.user?.username || 'n/a')}</dd></div>
    </dl>
    <div class="actions">
      ${canStop ? `<button class="btn danger" type="button" data-stop>${icon('stop')}Stop run</button>` : ''}
      <a class="btn" href="${esc(webUrl(r.entity, r.project, 'runs', r.name))}" target="_blank" rel="noopener">${icon('external')}Open in W&B</a>
    </div>`;
}

async function viewRun(ctx) {
  const { entity, project, run: name } = ctx.params;
  const base = projectBase(entity, project);
  const tab = RUN_TABS.some(([k]) => k === ctx.query.get('tab')) ? ctx.query.get('tab') : 'charts';
  setHeader({ title: 'Run', crumb: `${entity}/${project}`, back: `${base}/runs` });
  ctx.root.innerHTML = skelList(3);

  let r = await fetchRun(entity, project, name);
  if (ctx.stale()) return;
  setHeader({ title: r.displayName || r.name, crumb: `${entity}/${project}`, back: `${base}/runs` });

  ctx.root.innerHTML = `
    <section class="run-head" id="run-head">${runHeadHtml(r)}</section>
    <nav class="tabs" aria-label="Run sections">${RUN_TABS.map(([k, label]) =>
      `<a href="${base}/runs/${enc(name)}?tab=${k}" ${k === tab ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <div id="tab-body"></div>`;

  const head = $('#run-head', ctx.root);
  head.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-stop]')) return;
    const yes = await confirmSheet({
      title: 'Stop this run?',
      body: 'W&B will tell the training script to stop. It exits the next time it checks in with W&B, usually within a minute, and shows as Stopped.',
      confirm: 'Stop run',
      danger: true,
    });
    if (!yes) return;
    try {
      await transport.stopRun(r.id);
      toast('Stop requested. The run ends the next time it checks in.');
    } catch (err) {
      toast(err.message);
    }
  });

  if (runHealth(r).key === 'running' || runHealth(r).key === 'stale') {
    ctx.every(30000, async () => {
      try {
        r = await fetchRun(entity, project, name, true);
        if (!ctx.stale()) head.innerHTML = runHeadHtml(r);
      } catch (err) {
        console.warn('Run refresh failed', err);
      }
    });
  }

  const body = $('#tab-body', ctx.root);
  const tabs = { charts: tabCharts, overview: tabOverview, system: tabSystem, logs: tabLogs, files: tabFiles, artifacts: tabRunArtifacts };
  await tabs[tab](ctx, r, body);
}

function numericHistoryKeys(r) {
  const keys = r.historyKeys?.keys || {};
  const fromHistory = Object.entries(keys)
    .filter(([k, v]) => !k.startsWith('_') && ((v?.typeCounts || []).some((t) => t.type === 'number') || typeof r.summary[k] === 'number'))
    .map(([k]) => k);
  if (fromHistory.length || Object.keys(keys).length) return fromHistory;
  return Object.keys(r.summary).filter((k) => !k.startsWith('_') && typeof r.summary[k] === 'number');
}

async function tabCharts(ctx, r, body) {
  const allKeys = numericHistoryKeys(r);
  const xLabel = epochInfo(r) ? 'Epoch' : 'Step';
  if (!allKeys.length) {
    body.innerHTML = emptyState('No charts yet', 'Metrics logged with <code>wandb.log()</code> appear here as charts.');
    return;
  }
  let pins = getPins(r.entity, r.project).filter((k) => allKeys.includes(k));
  let smoothing = store.get('smoothing', false);
  const group = (k) => (k.includes('/') ? k.slice(0, k.indexOf('/')) : 'Charts');
  const sorted = [...allKeys].sort((a, b) => group(a).localeCompare(group(b)) || a.localeCompare(b, undefined, { numeric: true }));
  const groups = new Map();
  for (const k of sorted) {
    if (pins.includes(k)) continue;
    const g = group(k);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(k);
  }

  const card = (k) => `<div class="panel chart-card" data-key="${esc(k)}">
    <div class="chart-head"><span class="chart-title">${esc(k)}</span>
      <span class="chart-last">${typeof r.summary[k] === 'number' ? esc(formatValue(r.summary[k])) : ''}</span>
      <button class="icon-btn sm pin" type="button" data-pin="${esc(k)}" aria-pressed="${pins.includes(k)}" aria-label="Pin ${esc(k)}">${icon('star')}</button></div>
    <div class="chart-box" data-chart><span class="skel chart-skel"></span></div></div>`;

  body.innerHTML = `
    <div class="toolbar">${searchBox('chart-search', `Filter ${allKeys.length} charts`)}
      <button class="chip" type="button" id="smooth" aria-pressed="${smoothing}">Smooth</button></div>
    <div id="charts">
      ${pins.length ? `${sectionHead('Pinned')}<div class="chart-grid">${pins.map(card).join('')}</div>` : ''}
      ${[...groups].map(([g, keys]) => `<div class="chart-group">${sectionHead(g)}<div class="chart-grid">${keys.map(card).join('')}</div></div>`).join('')}
    </div>
    <p class="note">Tap and drag across a chart to read values. Pin a chart with the star; the first pinned chart is also the metric shown in run lists for this project.</p>`;

  const data = new Map();
  const handles = new Map();
  const queue = new Set();
  ctx.cleanup(() => handles.forEach((h) => h.destroy()));

  const draw = (k) => {
    const el = $(`.chart-card[data-key="${CSS.escape(k)}"] [data-chart]`, body);
    if (!el || !data.has(k)) return;
    handles.get(k)?.destroy();
    handles.set(k, lineChart(el, { series: [{ name: k, points: data.get(k) }], smoothing: smoothing ? 0.6 : 0, xLabel, label: `${k} by ${xLabel.toLowerCase()}` }));
  };

  const flush = debounce(async () => {
    const keys = [...queue].slice(0, 8);
    keys.forEach((k) => queue.delete(k));
    if (!keys.length) return;
    try {
      const specs = keys.map((k) => JSON.stringify({ keys: ['_step', k], samples: 400 }));
      const d = await gql(Q.sampledHistory, { entity: r.entity, project: r.project, name: r.name, specs });
      if (ctx.stale()) return;
      const sets = d.project?.run?.sampledHistory || [];
      keys.forEach((k, i) => {
        data.set(k, (sets[i] || []).map((o) => [o._step, typeof o[k] === 'number' ? o[k] : Number(o[k])]));
        draw(k);
      });
    } catch (err) {
      keys.forEach((k) => {
        const el = $(`.chart-card[data-key="${CSS.escape(k)}"] [data-chart]`, body);
        if (el) el.innerHTML = `<p class="chart-empty">${esc(err.message)}</p>`;
      });
    }
    if (queue.size) flush();
  }, 60);

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const k = e.target.dataset.key;
      io.unobserve(e.target);
      if (!data.has(k)) {
        queue.add(k);
        flush();
      }
    }
  }, { rootMargin: '300px 0px' });
  $$('.chart-card', body).forEach((c) => io.observe(c));
  ctx.cleanup(() => io.disconnect());

  $('#chart-search', body).addEventListener('input', (e) => {
    const t = e.target.value.trim().toLowerCase();
    $$('.chart-card', body).forEach((c) => { c.hidden = Boolean(t) && !c.dataset.key.toLowerCase().includes(t); });
    $$('.chart-group', body).forEach((g) => { g.hidden = !$$('.chart-card', g).some((c) => !c.hidden); });
  });

  $('#smooth', body).addEventListener('click', (e) => {
    smoothing = !smoothing;
    store.set('smoothing', smoothing);
    e.currentTarget.setAttribute('aria-pressed', String(smoothing));
    for (const k of data.keys()) draw(k);
  });

  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pin]');
    if (!b) return;
    const k = b.dataset.pin;
    const all = getPins(r.entity, r.project);
    const on = !all.includes(k);
    const next = on ? [...all, k] : all.filter((x) => x !== k);
    store.set(pinsKey(r.entity, r.project), next);
    pins = next;
    $$(`[data-pin="${CSS.escape(k)}"]`, body).forEach((x) => x.setAttribute('aria-pressed', String(on)));
    toast(on ? `Pinned ${k}. Pinned charts show first next time.` : `Unpinned ${k}.`);
  });
}

function tabOverview(ctx, r, body) {
  const summary = Object.entries(r.summary).filter(([k]) => !k.startsWith('_')).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  const config = flatten(Object.fromEntries(Object.entries(r.config).filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => [k, v && typeof v === 'object' && 'value' in v ? v.value : v])));
  const details = [
    ['State', esc(runHealth(r).label)],
    ['Run id', esc(r.name)],
    r.group ? ['Group', esc(r.group)] : null,
    r.jobType ? ['Job type', esc(r.jobType)] : null,
    r.sweepName ? ['Sweep', `<a href="${projectBase(r.entity, r.project)}/sweeps/${enc(r.sweepName)}">${esc(r.sweepName)}</a>`] : null,
    r.tags?.length ? ['Tags', r.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')] : null,
    r.commit ? ['Commit', `<code>${esc(String(r.commit).slice(0, 12))}</code>`] : null,
    ['Created', esc(fmtDate(r.createdAt))],
    ['Last heartbeat', esc(fmtDate(r.heartbeatAt))],
    typeof r.historyLineCount === 'number' ? ['History rows', esc(r.historyLineCount.toLocaleString())] : null,
  ].filter(Boolean);

  body.innerHTML = `
    ${r.notes ? `${sectionHead('Notes')}<p class="lede">${esc(r.notes)}</p>` : ''}
    ${sectionHead('Summary metrics')}
    ${summary.length > 12 ? searchBox('sum-search', 'Filter metrics') : ''}
    <div id="sum-table">${summary.length ? kvTable(summary.map(([k, v]) => [k, displayValue(v)])) : '<p class="note">No summary metrics logged.</p>'}</div>
    ${sectionHead('Config')}
    ${config.length ? kvTable(config.map(([k, v]) => [k, displayValue(v)])) : '<p class="note">No config values logged.</p>'}
    ${sectionHead('Details')}
    ${kvTable(details)}`;

  $('#sum-search', body)?.addEventListener('input', (e) => {
    const t = e.target.value.trim().toLowerCase();
    $$('#sum-table tr', body).forEach((tr) => { tr.hidden = Boolean(t) && !tr.querySelector('th').textContent.toLowerCase().includes(t); });
  });
}

const SYS_LABELS = {
  'gpu.gpu': 'GPU utilization (%)',
  'gpu.memory': 'GPU memory access (%)',
  'gpu.memoryAllocated': 'GPU memory allocated (%)',
  'gpu.memoryAllocatedBytes': 'GPU memory allocated (bytes)',
  'gpu.temp': 'GPU temperature (°C)',
  'gpu.powerWatts': 'GPU power (W)',
  'gpu.powerPercent': 'GPU power (% of limit)',
  'gpu.smClock': 'GPU SM clock (MHz)',
  'gpu.memoryClock': 'GPU memory clock (MHz)',
  cpu: 'Process CPU (%)',
  'cpu.cpu_percentage': 'CPU utilization per core (%)',
  memory: 'System memory (%)',
  memory_percent: 'System memory (%)',
  'proc.memory.rssMB': 'Process memory (MB)',
  'proc.memory.percent': 'Process memory (%)',
  'proc.memory.availableMB': 'Available memory (MB)',
  'proc.cpu.threads': 'Process threads',
  disk: 'Disk used (%)',
  'disk./.usagePercent': 'Disk used (%)',
  'disk./.usageGB': 'Disk used (GB)',
  'network.sent': 'Network sent (bytes)',
  'network.recv': 'Network received (bytes)',
};

function sysOrder(family) {
  const order = ['gpu.gpu', 'gpu.memoryAllocated', 'gpu.temp', 'gpu.powerWatts', 'cpu', 'memory', 'memory_percent', 'proc.memory.rssMB'];
  const i = order.indexOf(family);
  if (i >= 0) return i;
  if (family.startsWith('gpu')) return 20;
  if (family.startsWith('cpu') || family.startsWith('proc')) return 30;
  return 40;
}

async function tabSystem(ctx, r, body) {
  body.innerHTML = `<div class="chart-grid">${'<div class="panel chart-card"><span class="skel chart-skel"></span></div>'.repeat(4)}</div>`;
  const d = await gql(Q.systemEvents, { entity: r.entity, project: r.project, name: r.name, samples: 500 });
  if (ctx.stale()) return;
  const rows = (d.project?.run?.events || []).map((l) => parseJSON(l, null)).filter(Boolean);
  if (!rows.length) {
    body.innerHTML = emptyState('No system metrics', 'W&B records GPU, CPU and memory use automatically while a run is active. None were saved for this run.');
    return;
  }

  const t0 = rows.find((o) => typeof o._timestamp === 'number')?._timestamp;
  const families = new Map();
  for (const row of rows) {
    const x = typeof row._runtime === 'number' ? row._runtime : typeof row._timestamp === 'number' && t0 ? row._timestamp - t0 : null;
    if (x === null) continue;
    for (const [k, v] of Object.entries(row)) {
      if (!k.startsWith('system.') || typeof v !== 'number') continue;
      const m = /^system\.(.+?)\.(\d+)\.(.+)$/.exec(k);
      const family = m ? `${m[1]}.${m[3]}` : k.slice(7);
      const series = m ? `${m[1].split('.')[0].toUpperCase()} ${m[2]}` : SYS_LABELS[family] || family;
      if (!families.has(family)) families.set(family, new Map());
      const fam = families.get(family);
      if (!fam.has(series)) fam.set(series, []);
      fam.get(series).push([x, v]);
    }
  }

  const charts = [...families].sort(([a], [b]) => sysOrder(a) - sysOrder(b) || a.localeCompare(b));
  body.innerHTML = `<div class="chart-grid">${charts.map(([family, series], i) => {
    const note = series.size > SERIES_SLOTS ? `<span class="chart-last">Average of ${series.size}</span>` : '';
    return `<div class="panel chart-card"><div class="chart-head"><span class="chart-title">${esc(SYS_LABELS[family] || family)}</span>${note}</div><div class="chart-box" data-sys="${i}"></div></div>`;
  }).join('')}</div>`;

  const handles = [];
  ctx.cleanup(() => handles.forEach((h) => h.destroy()));
  charts.forEach(([family, seriesMap], i) => {
    let series = [...seriesMap].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([name, points]) => ({ name, points }));
    if (series.length > SERIES_SLOTS) {
      // Too many lines to tell apart: plot the mean across all of them instead.
      const byX = new Map();
      for (const s of series) for (const [x, y] of s.points) {
        const a = byX.get(x) || [0, 0];
        a[0] += y;
        a[1] += 1;
        byX.set(x, a);
      }
      series = [{ name: 'Average', points: [...byX].map(([x, [sum, n]]) => [x, sum / n]) }];
    }
    const el = $(`[data-sys="${i}"]`, body);
    handles.push(lineChart(el, { series, xFormat: formatSeconds, xLabel: 'Time', label: SYS_LABELS[family] || family }));
  });
}

function cleanLogLine(line) {
  // Strip terminal colors and keep only the final state of carriage-return progress bars.
  const noAnsi = line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const parts = noAnsi.split('\r').filter((p) => p.length);
  return parts.length ? parts[parts.length - 1] : '';
}

const ERROR_LINE = /(error|exception|traceback|out of memory|segmentation fault|killed)/i;

// How many of the newest lines to fetch; "Load earlier lines" steps through these.
const LOG_TAILS = [500, 2000, 5000];

async function tabLogs(ctx, r, body) {
  const live = ['running', 'stale'].includes(runHealth(r).key);
  let tail = 0;
  let wrap = store.get('logWrap', true);
  let follow = live;
  let lines = [];

  body.innerHTML = `
    <div class="toolbar">${searchBox('log-search', 'Filter lines')}
      <button class="chip" type="button" id="log-wrap" aria-pressed="${wrap}">Wrap</button>
      ${live ? `<button class="chip" type="button" id="log-follow" aria-pressed="${follow}">Follow</button>` : ''}
      <button class="icon-btn" type="button" id="log-refresh" aria-label="Reload log">${icon('refresh')}</button></div>
    <p class="count" id="log-meta"></p>
    <div class="log-box">
      <pre class="log${wrap ? ' wrap' : ''}" id="log" tabindex="0"><span class="muted">Loading console output</span></pre>
      <button class="icon-btn sm log-copy" type="button" id="log-copy" aria-label="Copy log" title="Copy log">${icon('copy')}</button>
    </div>
    <div class="more"><button class="btn" type="button" id="log-more" hidden>Load earlier lines</button></div>`;

  const pre = $('#log', body);
  const meta = $('#log-meta', body);
  const term = () => $('#log-search', body).value.trim().toLowerCase();

  const shownLines = () => {
    const t = term();
    return t ? lines.filter((l) => l.text.toLowerCase().includes(t)) : lines;
  };

  const paint = (scrollEnd) => {
    const t = term();
    const shown = shownLines();
    pre.innerHTML = shown.length
      ? shown.map((l) => (l.err || ERROR_LINE.test(l.text) ? `<span class="err">${esc(l.text)}</span>` : esc(l.text))).join('\n')
      : `<span class="muted">${t ? 'No lines match.' : 'No console output yet. Lines show up here as the run prints them.'}</span>`;
    if (scrollEnd) pre.scrollTop = pre.scrollHeight;
  };

  const load = async (scrollEnd = true) => {
    try {
      const want = LOG_TAILS[tail];
      const d = await gql(Q.consoleLog, { entity: r.entity, project: r.project, runName: r.name, last: want });
      if (ctx.stale()) return;
      const run = d.project?.run;
      const nodes = edges(run?.logLines);
      const total = Math.max(run?.logLineCount ?? 0, nodes.length);
      // Lines from stderr come back with level "error".
      lines = nodes.map((n) => ({
        text: (n.label ? `[${n.label}] ` : '') + cleanLogLine(String(n.line ?? '')),
        err: /err/i.test(n.level || ''),
      }));
      const last = nodes[nodes.length - 1]?.timestamp;
      meta.textContent = [
        nodes.length < total ? `Latest ${plural(nodes.length, 'line')} of ${total.toLocaleString()}.` : nodes.length ? `${plural(nodes.length, 'line')}.` : '',
        last ? `Last line ${ago(last)}.` : '',
      ].filter(Boolean).join(' ');
      // Hide "earlier" once we have everything, or when the server stopped returning more.
      $('#log-more', body).hidden = nodes.length >= total || tail >= LOG_TAILS.length - 1 || nodes.length < want;
      paint(scrollEnd);
    } catch (err) {
      if (ctx.stale()) return;
      meta.textContent = '';
      pre.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
    }
  };

  $('#log-search', body).addEventListener('input', debounce(() => paint(false), 200));
  $('#log-wrap', body).addEventListener('click', (e) => {
    wrap = !wrap;
    store.set('logWrap', wrap);
    e.currentTarget.setAttribute('aria-pressed', String(wrap));
    pre.classList.toggle('wrap', wrap);
  });
  $('#log-follow', body)?.addEventListener('click', (e) => {
    follow = !follow;
    e.currentTarget.setAttribute('aria-pressed', String(follow));
  });
  $('#log-refresh', body).addEventListener('click', () => load(true));
  const copyBtn = $('#log-copy', body);
  let copyReset = 0;
  ctx.cleanup(() => clearTimeout(copyReset));
  copyBtn.addEventListener('click', async () => {
    // Copies what is on screen, so an active filter narrows what gets copied.
    const shown = shownLines();
    if (!shown.length) {
      toast('Nothing to copy yet.');
      return;
    }
    if (!(await copyText(shown.map((l) => l.text).join('\n')))) {
      toast('Copying is not available here. Long-press the log to select text instead.');
      return;
    }
    copyBtn.innerHTML = icon('check');
    copyBtn.setAttribute('aria-label', 'Copied');
    clearTimeout(copyReset);
    copyReset = setTimeout(() => {
      copyBtn.innerHTML = icon('copy');
      copyBtn.setAttribute('aria-label', 'Copy log');
    }, 1600);
    const matching = shown.length === 1 ? ' that matches the filter' : ' that match the filter';
    toast(`Copied ${plural(shown.length, 'line')}${term() ? matching : ''}.`);
  });
  $('#log-more', body).addEventListener('click', () => {
    tail = Math.min(LOG_TAILS.length - 1, tail + 1);
    load(false);
  });
  if (live) ctx.every(20000, () => { if (follow) load(true); });
  await load(true);
}

async function tabFiles(ctx, r, body) {
  body.innerHTML = `<p class="count" id="file-count"></p><div id="file-list">${skelList(5)}</div>
    <div class="more"><button class="btn" type="button" id="file-more" hidden>Load more files</button></div>`;
  let cursor = null;
  const listEl = $('#file-list', body);
  const more = $('#file-more', body);
  const load = async (append) => {
    const d = await gql(Q.runFiles, { entity: r.entity, project: r.project, name: r.name, perPage: 50, cursor });
    if (ctx.stale()) return;
    const run = d.project?.run;
    const files = edges(run?.files);
    $('#file-count', body).textContent = plural(run?.fileCount ?? files.length, 'file');
    // Files open in W&B's own viewer, which uses your browser's W&B sign-in.
    const html = files.map((f) => `<a class="row" href="${esc(webUrl(r.entity, r.project, 'runs', r.name, 'files', ...f.name.split('/')))}" target="_blank" rel="noopener">
      <span class="row-main"><span class="row-title mono">${esc(f.name)}</span><span class="row-meta"><span>${esc(bytes(f.sizeBytes))}</span><span>${esc(ago(f.updatedAt))}</span></span></span>
      ${icon('external', 'ic chev')}</a>`).join('');
    if (append) $('.list', listEl)?.insertAdjacentHTML('beforeend', html);
    else listEl.innerHTML = files.length ? `<div class="list">${html}</div>` : emptyState('No files', 'Files saved with the run, like code, configs and media, show up here.');
    cursor = run?.files?.pageInfo?.endCursor;
    more.hidden = !run?.files?.pageInfo?.hasNextPage;
  };
  more.addEventListener('click', () => load(true).catch((err) => toast(err.message)));
  await load(false);
}

function artifactRow(a, fallbackEntity, fallbackProject) {
  const seq = a.artifactSequence || {};
  const entity = seq.project?.entity?.name || fallbackEntity;
  const project = seq.project?.name || fallbackProject;
  const type = a.artifactType?.name || 'artifact';
  const href = `${projectBase(entity, project)}/artifacts/${enc(type)}/${enc(seq.name || '')}?v=${a.versionIndex}`;
  const aliases = (a.aliases || []).map((x) => x.alias).filter((x) => !/^v\d+$/.test(x));
  return `<a class="row" href="${href}">
    <span class="mark tone-muted">${icon('box')}</span>
    <span class="row-main"><span class="row-title">${esc(seq.name || 'artifact')}<span class="ver">v${esc(a.versionIndex)}</span></span>
    <span class="row-meta"><span>${esc(type)}</span><span>${esc(bytes(a.size))}</span>${aliases.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</span></span>
    ${icon('chevron', 'ic chev')}</a>`;
}

async function tabRunArtifacts(ctx, r, body) {
  body.innerHTML = skelList(3);
  const d = await gql(Q.runArtifacts, { entity: r.entity, project: r.project, run: r.name });
  if (ctx.stale()) return;
  const outs = edges(d.project?.run?.outputs);
  const ins = edges(d.project?.run?.inputs);
  if (!outs.length && !ins.length) {
    body.innerHTML = emptyState('No artifacts', 'Artifacts this run logged or used, like datasets and model checkpoints, show up here.');
    return;
  }
  body.innerHTML = `
    ${sectionHead('Logged by this run')}
    ${outs.length ? `<div class="list">${outs.map((a) => artifactRow(a, r.entity, r.project)).join('')}</div>` : '<p class="note">None.</p>'}
    ${sectionHead('Used by this run')}
    ${ins.length ? `<div class="list">${ins.map((a) => artifactRow(a, r.entity, r.project)).join('')}</div>` : '<p class="note">None.</p>'}`;
}

// ---------------------------------------------------------------------------
// Sweeps

function sweepRow(s, base) {
  const h = sweepHealth(s);
  const runs = s.runCountExpected ? `${s.runCount ?? 0} of ${s.runCountExpected} runs` : plural(s.runCount ?? 0, 'run');
  return `<a class="row" href="${base}/sweeps/${enc(s.name)}">
    ${mark(h)}
    <span class="row-main"><span class="row-title">${esc(s.displayName || s.name)}</span>
    <span class="row-meta"><span>${esc(runs)}</span>${s.method ? `<span>${esc(s.method)}</span>` : ''}<span>${esc(ago(s.createdAt))}</span></span></span>
    ${typeof s.bestLoss === 'number' ? `<span class="row-side"><span class="metric-key">best</span><span class="metric-val">${esc(formatValue(s.bestLoss))}</span></span>` : ''}
  </a>`;
}

async function viewSweeps(ctx) {
  const { entity, project } = ctx.params;
  const base = projectBase(entity, project);
  setHeader({ title: 'Sweeps', crumb: `${entity}/${project}`, back: base });
  ctx.root.innerHTML = skelList(4);
  const d = await gql(Q.sweeps, { entity, project, filters: '{}', perPage: 50 });
  if (ctx.stale()) return;
  const sweeps = edges(d.project?.sweeps);
  if (!sweeps.length) {
    ctx.root.innerHTML = emptyState('No sweeps in this project', 'Start one with <code>wandb sweep config.yaml</code> and it shows up here.');
    return;
  }
  ctx.root.innerHTML = `<p class="count">${plural(d.project.totalSweeps ?? sweeps.length, 'sweep')}</p><div class="list">${sweeps.map((s) => sweepRow(s, base)).join('')}</div>`;
}

function sweepConfigInfo(text) {
  const cfg = parseJSON(text, null);
  if (cfg && typeof cfg === 'object') return { metric: cfg.metric?.name, goal: cfg.metric?.goal, method: cfg.method };
  const src = String(text || '');
  const block = /(?:^|\n)metric:\s*\n((?:[ \t]+.*(?:\n|$))*)/.exec(src)?.[1] || '';
  return {
    metric: /name:\s*['"]?([^'"\n]+)/.exec(block)?.[1]?.trim(),
    goal: /goal:\s*['"]?(\w+)/.exec(block)?.[1],
    method: /(?:^|\n)method:\s*['"]?(\w+)/.exec(src)?.[1],
  };
}

async function viewSweep(ctx) {
  const { entity, project, sweep: name } = ctx.params;
  const base = projectBase(entity, project);
  setHeader({ title: 'Sweep', crumb: `${entity}/${project}`, back: `${base}/sweeps` });
  ctx.root.innerHTML = skelList(3);
  const d = await gql(Q.sweep, { entity, project, name });
  const s = d.project?.sweep;
  if (!s) throw new ApiError(`Sweep ${name} was not found in ${entity}/${project}.`, 'not_found');
  if (ctx.stale()) return;
  setHeader({ title: s.displayName || s.name, crumb: `${entity}/${project}`, back: `${base}/sweeps` });

  const info = sweepConfigInfo(s.config);
  const state = String(s.state || '').toUpperCase();
  const actions = app.config?.actions ? [
    state === 'RUNNING' ? `<button class="btn" type="button" data-sweep="PAUSED">${icon('pause')}Pause</button>` : '',
    state === 'PAUSED' ? `<button class="btn" type="button" data-sweep="RUNNING">${icon('play')}Resume</button>` : '',
    ['RUNNING', 'PAUSED', 'PENDING'].includes(state) ? `<button class="btn danger" type="button" data-sweep="FINISHED">${icon('stop')}Stop sweep</button>` : '',
  ].join('') : '';

  ctx.root.innerHTML = `
    <section class="run-head" id="sweep-head">
      <div class="head-line">${badge(sweepHealth(s))}</div>
      <h2 class="run-name">${esc(s.displayName || s.name)}</h2>
      <p class="run-id">${esc(s.name)}</p>
      <dl class="facts">
        <div><dt>Runs</dt><dd>${esc(s.runCountExpected ? `${s.runCount ?? 0} of ${s.runCountExpected}` : String(s.runCount ?? 0))}</dd></div>
        <div><dt>Method</dt><dd>${esc(info.method || s.method || 'n/a')}</dd></div>
        <div><dt>Best ${esc(info.metric || 'metric')}</dt><dd>${typeof s.bestLoss === 'number' ? esc(formatValue(s.bestLoss)) : 'n/a'}</dd></div>
        <div><dt>Created</dt><dd>${esc(fmtDate(s.createdAt))}</dd></div>
      </dl>
      <div class="actions">${actions}<a class="btn" href="${esc(webUrl(entity, project, 'sweeps', s.name))}" target="_blank" rel="noopener">${icon('external')}Open in W&B</a></div>
    </section>
    ${sectionHead(info.metric ? `Best runs by ${info.metric}` : 'Latest runs', `<a href="${base}/runs?sweep=${enc(s.name)}">All runs</a>`)}
    <div id="sweep-runs">${skelList(4)}</div>
    ${sectionHead('Configuration')}
    ${jsonBlock(s.config || '')}`;

  $('#sweep-head', ctx.root).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sweep]');
    if (!b) return;
    const next = b.dataset.sweep;
    const copy = {
      PAUSED: ['Pause this sweep?', 'Agents stop picking up new runs until you resume. Runs already going keep running.', 'Pause sweep', false],
      RUNNING: ['Resume this sweep?', 'Agents start picking up new runs again.', 'Resume sweep', false],
      FINISHED: ['Stop this sweep?', 'No new runs start. Runs already going keep running until they finish. This cannot be resumed.', 'Stop sweep', true],
    }[next];
    const yes = await confirmSheet({ title: copy[0], body: copy[1], confirm: copy[2], danger: copy[3] });
    if (!yes) return;
    try {
      await transport.sweepState(s.id, next);
      toast(next === 'PAUSED' ? 'Sweep paused.' : next === 'RUNNING' ? 'Sweep resumed.' : 'Sweep stopped.');
      render();
    } catch (err) {
      toast(err.message);
    }
  });

  const order = info.metric ? `${info.goal === 'maximize' ? '-' : '+'}summary_metrics.${info.metric}` : '-created_at';
  const filters = JSON.stringify({ $and: [{ sweep: s.name }] });
  const holder = $('#sweep-runs', ctx.root);
  try {
    const rd = await gql(Q.runs, { entity, project, perPage: 10, order, filters });
    if (ctx.stale()) return;
    const runs = edges(rd.project?.runs).map((r) => enrichRun(r, entity, project));
    holder.innerHTML = runs.length ? `<div class="list">${runs.map((r) => runRow(r)).join('')}</div>` : '<p class="note">No runs in this sweep yet.</p>';
  } catch (err) {
    holder.innerHTML = `<p class="note">${esc(err.message)}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Artifacts and registry

function collectionRow(c, entity, project) {
  const type = c.type?.name || 'artifact';
  return `<a class="row" href="${projectBase(entity, project)}/artifacts/${enc(type)}/${enc(c.name)}">
    <span class="row-main"><span class="row-title">${esc(c.name)}</span>
    <span class="row-meta"><span>${esc(type)}</span><span>updated ${esc(ago(c.updatedAt || c.createdAt))}</span>${c.description ? `<span class="clip">${esc(c.description)}</span>` : ''}</span></span>
    ${icon('chevron', 'ic chev')}</a>`;
}

async function viewArtifacts(ctx) {
  const { entity, project } = ctx.params;
  const base = projectBase(entity, project);
  setHeader({ title: 'Artifacts', crumb: `${entity}/${project}`, back: base });
  ctx.root.innerHTML = skelList(4);
  const d = await gql(Q.artifactTypes, { entity, project });
  if (ctx.stale()) return;
  const types = edges(d.project?.artifactTypes);
  if (!types.length) {
    ctx.root.innerHTML = emptyState('No artifacts in this project', 'Version datasets and models with <code>wandb.log_artifact()</code> and they show up here.');
    return;
  }
  ctx.root.innerHTML = types.map((t, i) => `${sectionHead(t.name)}<div data-type="${i}">${skelList(2)}</div>`).join('');
  await Promise.all(types.map(async (t, i) => {
    const el = $(`[data-type="${i}"]`, ctx.root);
    try {
      const cd = await gql(Q.typeCollections, { entity, project, type: t.name, perPage: 50 });
      if (ctx.stale()) return;
      const cols = edges(cd.project?.artifactType?.artifactCollections).map((c) => ({ ...c, type: c.type || { name: t.name } }));
      el.innerHTML = cols.length ? `<div class="list">${cols.map((c) => collectionRow(c, entity, project)).join('')}</div>` : '<p class="note">No collections of this type.</p>';
    } catch (err) {
      el.innerHTML = `<p class="note">${esc(err.message)}</p>`;
    }
  }));
}

async function viewArtifactVersions(ctx) {
  const { entity, project, type, collection } = ctx.params;
  const isRegistry = project.startsWith('wandb-registry-');
  const back = isRegistry ? `#/registry/${enc(entity)}/${enc(project)}` : `${projectBase(entity, project)}/artifacts`;
  setHeader({ title: collection, crumb: isRegistry ? `Registry ${project.slice('wandb-registry-'.length)}` : `${entity}/${project}`, back });
  ctx.root.innerHTML = skelList(4);
  const d = await gql(Q.artifactVersions, { entity, project, type, collection, perPage: 50 });
  if (ctx.stale()) return;
  const conn = d.project?.artifactType?.artifactCollection?.artifacts;
  if (!conn) throw new ApiError(`${collection} was not found.`, 'not_found');
  const versions = (conn.edges || []).map((e) => ({ ...e.node, label: e.version }));
  const focus = ctx.query.get('v');

  ctx.root.innerHTML = `
    <p class="count">${plural(conn.totalCount ?? versions.length, 'version')} of ${esc(type)}</p>
    <div class="list">${versions.map((a) => {
      const aliases = (a.aliases || []).map((x) => x.alias).filter((x) => !/^v\d+$/.test(x));
      const metaRows = flatten(parseJSON(a.metadata)).slice(0, 40).map(([k, v]) => [k, displayValue(v)]);
      return `<details class="row-details" data-v="${esc(a.versionIndex)}" ${String(a.versionIndex) === focus ? 'open' : ''}>
        <summary class="row"><span class="row-main"><span class="row-title">v${esc(a.versionIndex)}${aliases.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</span>
        <span class="row-meta"><span>${esc(bytes(a.size))}</span><span>${esc(ago(a.createdAt))}</span>${a.state && a.state !== 'COMMITTED' ? `<span>${esc(a.state.toLowerCase())}</span>` : ''}</span></span>
        ${icon('chevron', 'ic chev')}</summary>
        <div class="details-body">
          ${a.description ? `<p>${esc(a.description)}</p>` : ''}
          ${kvTable([
            ['Files', esc(String(a.fileCount ?? 'n/a'))],
            ['Size', esc(bytes(a.size))],
            ['Created', esc(fmtDate(a.createdAt))],
            ['Digest', `<code>${esc(String(a.digest || '').slice(0, 16))}</code>`],
            ...metaRows,
          ])}
          <a class="btn" href="${esc(isRegistry ? webUrl('registry') : webUrl(entity, project, 'artifacts', type, collection, `v${a.versionIndex}`))}" target="_blank" rel="noopener">${icon('external')}Open in W&B</a>
        </div></details>`;
    }).join('')}</div>`;

  if (focus) $(`[data-v="${CSS.escape(focus)}"]`, ctx.root)?.scrollIntoView({ block: 'center' });
}

async function viewRegistries(ctx) {
  setHeader({ title: 'Registry' });
  ctx.root.innerHTML = skelList(3);
  await ensureViewer();
  const d = await gql(Q.orgInfo, { entity: app.viewer.entity });
  const seen = new Set();
  const orgs = [d.entity?.organization, ...(d.entity?.user?.organizations || [])]
    .filter((o) => o && o.orgEntity?.name && !seen.has(o.name) && seen.add(o.name));
  if (ctx.stale()) return;
  if (!orgs.length) {
    ctx.root.innerHTML = emptyState('No registries', 'Registries belong to a W&B organization. This account is not part of one, so there is nothing to show.');
    return;
  }
  ctx.root.innerHTML = orgs.map((o, i) => `${sectionHead(o.name)}<div data-org="${i}">${skelList(2)}</div>`).join('');
  await Promise.all(orgs.map(async (o, i) => {
    const el = $(`[data-org="${i}"]`, ctx.root);
    try {
      const rd = await gql(Q.registries, { organization: o.name, filters: F.registries(), perPage: 50 });
      if (ctx.stale()) return;
      const regs = edges(rd.organization?.orgEntity?.projects).filter((p) => p.name.startsWith('wandb-registry-'));
      el.innerHTML = regs.length ? `<div class="list">${regs.map((p) => {
        const types = edges(p.artifactTypes).map((t) => t.name);
        return `<a class="row" href="#/registry/${enc(o.orgEntity.name)}/${enc(p.name)}">
          <span class="mark tone-muted">${icon('registry')}</span>
          <span class="row-main"><span class="row-title">${esc(p.name.slice('wandb-registry-'.length))}</span>
          <span class="row-meta">${types.length ? `<span>${esc(types.slice(0, 3).join(', '))}${types.length > 3 ? ` and ${types.length - 3} more` : ''}</span>` : ''}${p.description ? `<span class="clip">${esc(p.description)}</span>` : ''}</span></span>
          ${icon('chevron', 'ic chev')}</a>`;
      }).join('')}</div>` : '<p class="note">No registries you can see in this organization.</p>';
    } catch (err) {
      el.innerHTML = `<p class="note">${esc(err.message)}</p>`;
    }
  }));
}

async function viewRegistry(ctx) {
  const { entity, project } = ctx.params;
  setHeader({ title: project.replace(/^wandb-registry-/, ''), crumb: 'Registry', back: '#/registry' });
  ctx.root.innerHTML = skelList(4);
  const d = await gql(Q.projectCollections, { entity, project, perPage: 50 });
  if (ctx.stale()) return;
  const cols = edges(d.project?.artifactCollections);
  ctx.root.innerHTML = cols.length
    ? `<p class="count">${plural(d.project.artifactCollections.totalCount ?? cols.length, 'collection')}</p><div class="list">${cols.map((c) => collectionRow(c, entity, project)).join('')}</div>`
    : emptyState('This registry is empty', 'Link artifact versions to it from W&B and they show up here.');
}

// ---------------------------------------------------------------------------
// Reports

function reportUrl(entity, project, report) {
  const slug = String(report.displayName || 'report').replace(/\W/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${webUrl(entity, project, 'reports')}/${enc(slug)}--${String(report.id).replace(/=/g, '')}`;
}

async function viewReports(ctx) {
  const { entity, project } = ctx.params;
  setHeader({ title: 'Reports', crumb: `${entity}/${project}`, back: projectBase(entity, project) });
  ctx.root.innerHTML = skelList(4);
  const d = await gql(Q.reports, { entity, project, perPage: 50 });
  if (ctx.stale()) return;
  const reports = edges(d.project?.allViews);
  if (!reports.length) {
    ctx.root.innerHTML = emptyState('No reports in this project', 'Reports you write in W&B show up here.');
    return;
  }
  reports.sort((a, b) => (toDate(b.updatedAt) || 0) - (toDate(a.updatedAt) || 0));
  ctx.root.innerHTML = `<p class="note">Reports open in W&B, where their panels render in full.</p>
    <div class="list">${reports.map((rep) => `<a class="row" href="${esc(reportUrl(entity, project, rep))}" target="_blank" rel="noopener">
      <span class="mark tone-muted">${icon('report')}</span>
      <span class="row-main"><span class="row-title">${esc(rep.displayName || rep.name || 'Untitled report')}</span>
      <span class="row-meta"><span>updated ${esc(ago(rep.updatedAt))}</span>${rep.user?.username ? `<span>${esc(rep.user.username)}</span>` : ''}${rep.description ? `<span class="clip">${esc(rep.description)}</span>` : ''}</span></span>
      ${icon('external', 'ic chev')}</a>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Weave traces

function opName(call) {
  if (call.display_name) return call.display_name;
  const m = /\/op\/([^:/]+)/.exec(call.op_name || '');
  return m ? m[1] : call.op_name || 'call';
}

function callHealth(call) {
  const st = call.summary?.weave?.status;
  if (st === 'error' || (!st && call.exception)) return { label: 'Error', tone: 'critical', icon: 'xCircle' };
  if (st === 'descendant_error') return { label: 'Error in a child call', tone: 'serious', icon: 'alert' };
  if (st === 'running' || (!st && !call.ended_at)) return { label: 'Running', tone: 'live' };
  return { label: 'Success', tone: 'good', icon: 'checkCircle' };
}

function callLatency(call) {
  const ms = call.summary?.weave?.latency_ms;
  if (typeof ms === 'number') return ms;
  const a = toDate(call.started_at);
  const b = toDate(call.ended_at);
  return a && b ? b - a : null;
}

const fmtMs = (ms) => (ms === null ? '' : ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : formatSeconds(ms / 1000));

function callTokens(call) {
  let total = 0;
  for (const u of Object.values(call.summary?.usage || {})) {
    if (!u || typeof u !== 'object') continue;
    total += u.total_tokens ?? ((u.prompt_tokens || u.input_tokens || 0) + (u.completion_tokens || u.output_tokens || 0));
  }
  return total;
}

function callCost(call) {
  let total = 0;
  for (const c of Object.values(call.summary?.weave?.costs || {})) {
    if (c && typeof c === 'object') total += (c.prompt_tokens_total_cost || 0) + (c.completion_tokens_total_cost || 0);
  }
  return total;
}

const fmtCost = (c) => (c >= 0.01 ? `$${c.toFixed(2)}` : `$${c.toFixed(4)}`);

function callRow(call, base, depth = 0, current = '') {
  const h = callHealth(call);
  const lat = callLatency(call);
  const tokens = callTokens(call);
  const cost = callCost(call);
  return `<a class="row${call.id === current ? ' is-current' : ''}" href="${base}/weave/${enc(call.id)}" ${depth ? `data-depth="${Math.min(depth, 6)}"` : ''}>
    ${mark(h)}
    <span class="row-main"><span class="row-title">${esc(opName(call))}</span>
    <span class="row-meta"><span>${esc(ago(call.started_at))}</span>${lat !== null ? `<span>${esc(fmtMs(lat))}</span>` : ''}${tokens ? `<span>${esc(tokens.toLocaleString())} tokens</span>` : ''}${cost ? `<span>${esc(fmtCost(cost))}</span>` : ''}</span></span>
    ${icon('chevron', 'ic chev')}</a>`;
}

async function viewTraces(ctx) {
  const { entity, project } = ctx.params;
  const base = projectBase(entity, project);
  setHeader({ title: 'Weave traces', crumb: `${entity}/${project}`, back: base });
  let errorsOnly = ctx.query.get('errors') === '1';
  let offset = 0;
  const calls = [];

  ctx.root.innerHTML = `
    ${chips([['all', 'All traces'], ['errors', 'Errors']], errorsOnly ? 'errors' : 'all', 'data-filter')}
    <p class="count" id="trace-count"></p>
    <div id="trace-list">${skelList(6)}</div>
    <div class="more"><button class="btn" type="button" id="trace-more" hidden>Load older traces</button></div>`;

  const listEl = $('#trace-list', ctx.root);
  const more = $('#trace-more', ctx.root);
  const paint = () => {
    const shown = errorsOnly ? calls.filter((c) => ['critical', 'serious'].includes(callHealth(c).tone)) : calls;
    $('#trace-count', ctx.root).textContent = calls.length
      ? `${errorsOnly ? `${plural(shown.length, 'trace')} with errors among the latest ${calls.length}` : `Latest ${plural(calls.length, 'trace')}`}`
      : '';
    listEl.innerHTML = shown.length
      ? `<div class="list">${shown.map((c) => callRow(c, base)).join('')}</div>`
      : calls.length
        ? '<p class="note">No errors in the traces loaded so far.</p>'
        : emptyState('No traces in this project yet', `Calls appear here after your code runs <code>weave.init("${esc(entity)}/${esc(project)}")</code>.`);
  };

  const load = async () => {
    more.disabled = true;
    try {
      const d = await transport.weaveCalls({ project: `${entity}/${project}`, filter: { trace_roots_only: true }, limit: 40, offset });
      if (ctx.stale()) return;
      calls.push(...d.calls);
      offset += d.calls.length;
      more.hidden = d.calls.length < 40;
      paint();
    } finally {
      more.disabled = false;
    }
  };

  $$('[data-filter]', ctx.root).forEach((b) => b.addEventListener('click', () => {
    errorsOnly = b.dataset.filter === 'errors';
    $$('[data-filter]', ctx.root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    ctx.replaceQuery({ errors: errorsOnly ? '1' : '' });
    paint();
  }));
  more.addEventListener('click', () => load().catch((err) => toast(err.message)));
  await load();
}

async function viewTrace(ctx) {
  const { entity, project, call: callId } = ctx.params;
  const base = projectBase(entity, project);
  const pid = `${entity}/${project}`;
  setHeader({ title: 'Trace', crumb: pid, back: `${base}/weave` });
  ctx.root.innerHTML = skelList(3);
  const d = await transport.weaveCalls({ project: pid, filter: { call_ids: [callId] }, limit: 1, full: true });
  const call = d.calls[0];
  if (!call) throw new ApiError('This call was not found. It may have been deleted.', 'not_found');
  if (ctx.stale()) return;
  setHeader({ title: opName(call), crumb: pid, back: `${base}/weave` });

  const lat = callLatency(call);
  const tokens = callTokens(call);
  const cost = callCost(call);
  ctx.root.innerHTML = `
    <section class="run-head">
      <div class="head-line">${badge(callHealth(call))}</div>
      <h2 class="run-name">${esc(opName(call))}</h2>
      <p class="run-id">${esc(call.op_name || '')}</p>
      <dl class="facts">
        <div><dt>Latency</dt><dd>${lat !== null ? esc(fmtMs(lat)) : 'n/a'}</dd></div>
        <div><dt>Tokens</dt><dd>${tokens ? esc(tokens.toLocaleString()) : 'n/a'}</dd></div>
        <div><dt>Cost</dt><dd>${cost ? esc(fmtCost(cost)) : 'n/a'}</dd></div>
        <div><dt>Started</dt><dd>${esc(fmtDate(call.started_at))}</dd></div>
      </dl>
      <div class="actions">
        ${call.parent_id ? `<a class="btn" href="${base}/weave/${enc(call.parent_id)}">${icon('back')}Parent call</a>` : ''}
        <a class="btn" href="${esc(webUrl(entity, project, 'r', 'call', call.id))}" target="_blank" rel="noopener">${icon('external')}Open in W&B</a>
      </div>
    </section>
    ${call.exception ? `${sectionHead('Exception')}<pre class="code err-block">${esc(call.exception)}</pre>` : ''}
    ${sectionHead('Call tree')}
    <div id="tree">${skelList(2)}</div>
    <details class="block" open><summary>Inputs</summary>${jsonBlock(call.inputs ?? {})}</details>
    <details class="block" open><summary>Output</summary>${jsonBlock(call.output ?? null)}</details>
    ${call.attributes && Object.keys(call.attributes).length ? `<details class="block"><summary>Attributes</summary>${jsonBlock(call.attributes)}</details>` : ''}`;

  try {
    const t = await transport.weaveCalls({ project: pid, filter: { trace_ids: [call.trace_id] }, limit: 250, ascending: true });
    if (ctx.stale()) return;
    const children = new Map();
    for (const c of t.calls) {
      const key = c.parent_id || '';
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(c);
    }
    const ids = new Set(t.calls.map((c) => c.id));
    const roots = t.calls.filter((c) => !c.parent_id || !ids.has(c.parent_id));
    const out = [];
    const walk = (c, depth) => {
      out.push(callRow(c, base, depth, call.id));
      for (const k of children.get(c.id) || []) walk(k, depth + 1);
    };
    roots.forEach((c) => walk(c, 0));
    $('#tree', ctx.root).innerHTML = `<div class="list tree">${out.join('')}</div>${t.calls.length >= 250 ? '<p class="note">Showing the first 250 calls in this trace.</p>' : ''}`;
  } catch (err) {
    $('#tree', ctx.root).innerHTML = `<p class="note">${esc(err.message)}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Settings

async function viewSettings(ctx) {
  setHeader({ title: 'Settings' });
  ctx.root.innerHTML = skelList(3);
  await ensureViewer();
  if (ctx.stale()) return;
  const v = app.viewer;
  const theme = store.get('theme', DEFAULT_THEME);
  const c = app.config || {};
  const keyMode = transport.credential === 'key';
  const hostOf = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };
  ctx.root.innerHTML = `
    ${sectionHead('Account')}
    ${kvTable([
      ['Username', esc(v.username)],
      v.name ? ['Name', esc(v.name)] : null,
      v.email ? ['Email', esc(v.email)] : null,
      ['Default entity', esc(v.entity)],
      ['Teams', esc(app.entities.filter((e) => e !== v.entity).join(', ') || 'none')],
    ].filter(Boolean))}
    ${sectionHead('Appearance')}
    ${chips([['system', 'Match device'], ['light', 'Light'], ['dark', 'Dark']], theme, 'data-theme-choice')}
    ${sectionHead('Connection')}
    ${kvTable([
      ['W&B API', esc(c.baseUrl)],
      ['Weave traces', esc(c.traceUrl)],
      ['Web app links', esc(c.appUrl)],
      keyMode ? null : ['Stop and sweep actions', c.actions ? 'On' : 'Off (ALLOW_ACTIONS=0)'],
      ['watchBoard version', esc(c.version)],
    ].filter(Boolean))}
    <p class="note">${keyMode
      ? `Your API key is kept in this app's private storage on this phone. It is only sent to ${esc(joinAnd(unique([hostOf(c.baseUrl), hostOf(c.traceUrl)])))}.`
      : 'The API key stays on the computer running the server. This device only holds a session cookie.'}</p>
    ${keyMode ? `${sectionHead('Stop and sweep actions')}
      ${chips([['on', 'Allowed'], ['off', 'Turned off']], c.actions ? 'on' : 'off', 'data-actions')}
      <p class="note">When allowed, run pages show a Stop button and sweep pages show Pause, Resume and Stop. Each one asks before it does anything.</p>` : ''}
    ${sectionHead('This device')}
    <button class="btn danger" type="button" id="sign-out">${icon('logout')}${keyMode ? 'Remove API key from this phone' : 'Sign out on this device'}</button>`;

  $$('[data-actions]', ctx.root).forEach((b) => b.addEventListener('click', () => {
    const on = b.dataset.actions === 'on';
    store.set('actions', on);
    app.config.actions = on;
    $$('[data-actions]', ctx.root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));

  $$('[data-theme-choice]', ctx.root).forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.themeChoice;
    store.set('theme', t);
    applyTheme(t);
    $$('[data-theme-choice]', ctx.root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  $('#sign-out', ctx.root).addEventListener('click', async () => {
    if (keyMode) {
      const yes = await confirmSheet({
        title: 'Remove the API key?',
        body: 'watchBoard forgets the key on this phone. You will need to paste it again to connect.',
        confirm: 'Remove key',
        danger: true,
      });
      if (!yes) return;
    }
    await transport.logout().catch(() => {});
    app.viewer = null;
    showLogin(keyMode ? 'API key removed. Paste a key to connect again.' : 'Signed out. Enter the passcode to sign back in.');
  });
}

// ---------------------------------------------------------------------------
// Login and boot

function renderLoginForm() {
  const fields = $('#login-fields');
  if (transport.credential === 'key') {
    const host = getConn()?.baseUrl || 'https://api.wandb.ai';
    fields.innerHTML = `
      <h1>Connect to W&B</h1>
      <p>Paste your API key from <a href="https://wandb.ai/authorize" target="_blank" rel="noopener">wandb.ai/authorize</a>. It is stored only in this app, on this phone.</p>
      <label for="secret">API key</label>
      <input id="secret" class="mono-input" name="secret" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required>
      <details class="login-adv" ${host !== 'https://api.wandb.ai' ? 'open' : ''}>
        <summary>Using W&B Dedicated Cloud or a self-hosted server?</summary>
        <label for="host">API host</label>
        <input id="host" class="mono-input" name="host" type="url" inputmode="url" value="${esc(host)}" autocapitalize="off" autocorrect="off" spellcheck="false">
      </details>`;
    $('#login-submit').textContent = 'Connect';
  } else {
    fields.innerHTML = `
      <h1>Unlock watchBoard</h1>
      <p>Enter the passcode printed in the terminal where the watchBoard server is running.</p>
      <input type="text" name="username" value="watchboard" autocomplete="username" hidden>
      <label for="secret">Passcode</label>
      <input id="secret" name="secret" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" required>`;
    $('#login-submit').textContent = 'Unlock';
  }
}

function showLogin(message = '') {
  renderLoginForm();
  $('#boot').hidden = true;
  $('#shell').hidden = true;
  $('#login').hidden = false;
  $('#login-error').textContent = message;
  setTimeout(() => $('#secret')?.focus(), 50);
}

function showSetupNeeded() {
  $('#boot').hidden = false;
  $('#boot').innerHTML = `<div class="state"><h3>Add your W&B API key</h3>
    <p>The server is running without <code>WANDB_API_KEY</code>. Add it to the <code>.env</code> file next to <code>server.js</code>, restart the server, then reload this page.</p>
    <button class="btn" type="button" id="reload">Reload</button></div>`;
  $('#reload').addEventListener('click', () => location.reload());
}

async function start() {
  try {
    app.config = await transport.config();
  } catch (err) {
    if (err.kind === 'no_key') return showSetupNeeded();
    if (err.kind === 'auth') return undefined;
    throw err;
  }
  $('#boot').hidden = true;
  $('#login').hidden = true;
  $('#shell').hidden = false;
  renderDrawer();
  renderTabbar();
  if (!routerStarted) {
    window.addEventListener('hashchange', render);
    routerStarted = true;
  }
  render();
}

let routerStarted = false;

function bindShell() {
  // Sticky elements below the top bar need its height, which changes with the status bar inset.
  const topbar = $('.topbar');
  const setTopbarHeight = () => document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`);
  new ResizeObserver(setTopbarHeight).observe(topbar);

  $('#menu-btn').innerHTML = icon('menu');
  $('#back-btn').innerHTML = icon('back');
  $('#refresh-btn').innerHTML = icon('refresh');
  $('#menu-btn').addEventListener('click', openDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#refresh-btn').addEventListener('click', () => {
    runCache.clear();
    render();
  });
  $('#tabbar').addEventListener('click', (e) => {
    if (e.target.closest('[data-open-menu]')) openDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-submit');
    btn.disabled = true;
    $('#login-error').textContent = '';
    try {
      const res = await transport.login({ secret: $('#secret').value, host: $('#host')?.value });
      if (!res.hasKey) return showSetupNeeded();
      await start();
    } catch (err) {
      $('#login-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

async function boot() {
  applyTheme(store.get('theme', DEFAULT_THEME));
  bindShell();
  let session;
  try {
    session = await transport.session();
  } catch {
    $('#boot').innerHTML = '<div class="state"><h3>Cannot reach the watchBoard server</h3><p>Check that it is running and that this device is on the same network.</p></div>';
    return;
  }
  if (!session.authed) return showLogin();
  if (!session.hasKey) return showSetupNeeded();
  try {
    await start();
  } catch (err) {
    $('#boot').innerHTML = errorState(err);
    $('[data-retry]')?.addEventListener('click', () => location.reload());
  }
  return undefined;
}

// The Android app ships its files inside the APK, so only the browser version needs a service worker.
if (!NATIVE && 'serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

boot();
