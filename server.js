// watchBoard server: serves the mobile web app and forwards its requests to the W&B API.
// The API key never leaves this process. Phones only get a session cookie after
// entering the passcode, and the generic GraphQL endpoint is read-only.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as W from './public/queries.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const SECRETS_FILE = path.join(ROOT, '.app-secrets.json');
const VERSION = '1.0.1';

loadDotEnv(path.join(ROOT, '.env'));

const env = process.env;
const API_KEY = (env.WANDB_API_KEY || '').trim();
const DEFAULT_URLS = W.wandbUrls(env.WANDB_BASE_URL);
const BASE_URL = DEFAULT_URLS.baseUrl;
const TRACE_URL = trimSlash(env.WEAVE_TRACE_URL || DEFAULT_URLS.traceUrl);
const APP_URL = trimSlash(env.WANDB_APP_URL || DEFAULT_URLS.appUrl);
const PORT = Number(env.PORT || 8787);
const HOST = env.HOST || '0.0.0.0';
const ALLOW_ACTIONS = env.ALLOW_ACTIONS !== '0';
const TRUST_PROXY = env.TRUST_PROXY === '1';
const SESSION_DAYS = Number(env.SESSION_DAYS || 30);
const COOKIE = 'rw_session';
const AUTH_HEADER = 'Basic ' + Buffer.from(`api:${API_KEY}`).toString('base64');
const UA = `watchboard/${VERSION}`;

const secrets = loadSecrets();
const PASSCODE = secrets.passcode;
const SESSION_SECRET = secrets.sessionSecret;
// Changing the passcode invalidates every existing session.
const PASS_TAG = crypto.createHash('sha256').update(PASSCODE).digest('hex').slice(0, 16);

// ---------------------------------------------------------------------------
// Config helpers

function trimSlash(value) {
  return String(value).trim().replace(/\/+$/, '');
}

function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function makePasscode() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 10; i++) {
    if (i === 5) out += '-';
    out += alphabet[crypto.randomInt(alphabet.length)];
  }
  return out;
}

function loadSecrets() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  } catch {
    // First run, or the file was removed. A new one is written below.
  }
  let changed = false;
  if (!saved.sessionSecret) {
    saved.sessionSecret = crypto.randomBytes(32).toString('hex');
    changed = true;
  }
  if (!env.APP_PASSCODE && !saved.passcode) {
    saved.passcode = makePasscode();
    changed = true;
  }
  if (changed) {
    try {
      fs.writeFileSync(SECRETS_FILE, JSON.stringify(saved, null, 2), { mode: 0o600 });
    } catch (err) {
      console.warn(`Could not save ${SECRETS_FILE}: ${err.message}. Sessions will reset when the server restarts.`);
    }
  }
  return {
    passcode: (env.APP_PASSCODE || saved.passcode).trim(),
    passcodeFromEnv: Boolean(env.APP_PASSCODE),
    sessionSecret: env.SESSION_SECRET || saved.sessionSecret,
  };
}

// ---------------------------------------------------------------------------
// Sessions and login throttling

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(`${value}.${PASS_TAG}`).digest('base64url');
}

function makeSession() {
  const expires = String(Date.now() + SESSION_DAYS * 86400e3);
  return `${expires}.${sign(expires)}`;
}

function validSession(token) {
  if (!token) return false;
  const [expires, sig] = token.split('.');
  if (!expires || !sig || Number(expires) < Date.now()) return false;
  const expected = Buffer.from(sign(expires));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function readCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // Ignore malformed cookies.
      }
    }
  }
  return out;
}

function sessionCookie(req, value, maxAge) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

const attempts = new Map();
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW = 15 * 60e3;

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function isLimited(ip) {
  const a = attempts.get(ip);
  return Boolean(a && a.resetAt > Date.now() && a.count >= MAX_ATTEMPTS);
}

function recordFailure(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < now) attempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW });
  else a.count += 1;
}

// ---------------------------------------------------------------------------
// HTTP helpers

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const BASE_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function send(req, res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', ...BASE_HEADERS, ...extra };
  const compressible = /json|text|javascript|svg|css|html|manifest/.test(type);
  if (compressible && buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    buf = zlib.gzipSync(buf);
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function json(req, res, status, obj, extra) {
  send(req, res, status, obj, undefined, extra);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, 'Request body is too large.'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw httpError(400, 'Request body is not valid JSON.');
  }
}

// ---------------------------------------------------------------------------
// W&B API access

async function wandbGraphQL(query, variables) {
  const res = await fetch(`${BASE_URL}/graphql`, {
    method: 'POST',
    headers: { Authorization: AUTH_HEADER, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ query, variables: variables || {} }),
    signal: AbortSignal.timeout(45000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Not JSON: handled by the caller through `text`.
  }
  return { status: res.status, data, text };
}

function upstreamError(status, text) {
  if (status === 401 || status === 403) {
    return { status: 502, body: { error: 'wandb_auth', message: 'W&B rejected the API key. Check WANDB_API_KEY in .env, then restart the server.' } };
  }
  if (status === 429) {
    return { status: 429, body: { error: 'rate_limited', message: 'W&B is rate limiting requests. Wait a minute, then refresh.' } };
  }
  const detail = String(text || '').replace(/\s+/g, ' ').slice(0, 240);
  return { status: 502, body: { error: 'upstream', message: `W&B returned HTTP ${status}. ${detail}`.trim() } };
}

function graphqlPassThrough(up) {
  const hasPayload = up.data && (up.data.data !== undefined || Array.isArray(up.data.errors));
  return hasPayload && ![401, 403, 429].includes(up.status) && up.status < 500;
}

// Any document containing these words is refused, even inside strings or comments.
// That fails closed: an operation of these types cannot be written without them.
function readOnlyProblem(query) {
  if (typeof query !== 'string' || !query.trim()) return 'The request has no query.';
  if (query.length > 60000) return 'The query is too long.';
  if (/mutation|subscription/i.test(query)) return 'This endpoint only forwards read-only queries.';
  if (/apikey/i.test(query)) return 'Queries that read API keys are blocked.';
  return null;
}

async function weaveStreamQuery(body) {
  return fetch(`${TRACE_URL}/calls/stream_query`, {
    method: 'POST',
    headers: { Authorization: AUTH_HEADER, 'Content-Type': 'application/json', Accept: 'application/jsonl', 'User-Agent': UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
}

// ---------------------------------------------------------------------------
// API routes

async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (isLimited(ip)) {
    return json(req, res, 429, { error: 'rate_limited', message: 'Too many wrong passcodes. Wait 15 minutes, then try again.' });
  }
  const { passcode } = await readJson(req);
  const given = crypto.createHash('sha256').update(String(passcode || '').trim()).digest();
  const expected = crypto.createHash('sha256').update(PASSCODE).digest();
  if (!crypto.timingSafeEqual(given, expected)) {
    recordFailure(ip);
    return json(req, res, 401, { error: 'bad_passcode', message: 'That passcode does not match. Check the terminal where watchBoard is running.' });
  }
  attempts.delete(ip);
  return json(req, res, 200, { ok: true, hasKey: Boolean(API_KEY) }, {
    'Set-Cookie': sessionCookie(req, makeSession(), SESSION_DAYS * 86400),
  });
}

async function handleGraphQL(req, res) {
  const { query, variables } = await readJson(req);
  const problem = readOnlyProblem(query);
  if (problem) return json(req, res, 403, { error: 'blocked', message: problem });
  const up = await wandbGraphQL(query, variables);
  if (!graphqlPassThrough(up)) {
    const e = upstreamError(up.status, up.text);
    return json(req, res, e.status, e.body);
  }
  return json(req, res, 200, up.data);
}

async function handleWeaveCalls(req, res) {
  let payload;
  try {
    payload = W.weaveQueryBody(await readJson(req));
  } catch (err) {
    return json(req, res, err.status || 400, { error: 'bad_request', message: err.message });
  }
  let up = await weaveStreamQuery(payload);
  if (up.status === 422 && payload.columns) {
    // The server rejected a column name; ask for whole rows instead.
    delete payload.columns;
    up = await weaveStreamQuery(payload);
  }
  const text = await up.text();
  if (!up.ok) {
    if (up.status === 401) {
      const e = upstreamError(401, text);
      return json(req, res, e.status, e.body);
    }
    const message = up.status === 403
      ? 'This API key cannot read Weave traces for this project.'
      : `The Weave trace server returned HTTP ${up.status}. ${W.weaveErrorReason(text).slice(0, 240)}`;
    return json(req, res, up.status === 403 ? 403 : 502, { error: 'weave', message });
  }
  return json(req, res, 200, { calls: W.parseJsonl(text) });
}

function mutationResult(req, res, up) {
  if (!graphqlPassThrough(up)) {
    const e = upstreamError(up.status, up.text);
    return json(req, res, e.status, e.body);
  }
  if (up.data.errors?.length) {
    return json(req, res, 400, { error: 'graphql', message: up.data.errors.map((e) => e.message).join('; ') });
  }
  return json(req, res, 200, up.data.data || {});
}

async function handleStopRun(req, res) {
  if (!ALLOW_ACTIONS) return json(req, res, 403, { error: 'actions_off', message: 'Actions are turned off on this server (ALLOW_ACTIONS=0).' });
  const { id } = await readJson(req);
  if (typeof id !== 'string' || !id || id.length > 300) return json(req, res, 400, { error: 'bad_request', message: 'A run id is required.' });
  return mutationResult(req, res, await wandbGraphQL(W.STOP_RUN, { id }));
}

async function handleSweepState(req, res) {
  if (!ALLOW_ACTIONS) return json(req, res, 403, { error: 'actions_off', message: 'Actions are turned off on this server (ALLOW_ACTIONS=0).' });
  const { id, state } = await readJson(req);
  if (typeof id !== 'string' || !id || id.length > 300) return json(req, res, 400, { error: 'bad_request', message: 'A sweep id is required.' });
  if (!W.SWEEP_TARGET_STATES.includes(state)) return json(req, res, 400, { error: 'bad_request', message: 'state must be RUNNING, PAUSED or FINISHED.' });
  return mutationResult(req, res, await wandbGraphQL(W.SWEEP_STATE, { id, state }));
}

async function routeApi(req, res, url) {
  const p = url.pathname;
  if (req.method === 'POST' && req.headers['x-requested-with'] !== 'watchboard') {
    return json(req, res, 403, { error: 'csrf', message: 'Missing request header.' });
  }
  if (p === '/api/login' && req.method === 'POST') return handleLogin(req, res);
  if (p === '/api/logout' && req.method === 'POST') {
    return json(req, res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }
  const authed = validSession(readCookies(req)[COOKIE]);
  if (p === '/api/session') return json(req, res, 200, { authed, hasKey: Boolean(API_KEY), version: VERSION });
  if (!authed) return json(req, res, 401, { error: 'auth', message: 'Enter the passcode to continue.' });
  if (!API_KEY) return json(req, res, 503, { error: 'no_key', message: 'WANDB_API_KEY is not set on the server. Add it to .env, then restart.' });

  if (p === '/api/config') {
    return json(req, res, 200, { appUrl: APP_URL, baseUrl: BASE_URL, traceUrl: TRACE_URL, actions: ALLOW_ACTIONS, version: VERSION });
  }
  if (p === '/api/graphql' && req.method === 'POST') return handleGraphQL(req, res);
  if (p === '/api/weave/calls' && req.method === 'POST') return handleWeaveCalls(req, res);
  if (p === '/api/action/stop-run' && req.method === 'POST') return handleStopRun(req, res);
  if (p === '/api/action/sweep-state' && req.method === 'POST') return handleSweepState(req, res);
  return json(req, res, 404, { error: 'not_found', message: 'Unknown endpoint.' });
}

// ---------------------------------------------------------------------------
// Static files

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return json(req, res, 400, { error: 'bad_request', message: 'Malformed path.' });
  }
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(req, res, 404, { error: 'not_found', message: 'Not found.' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(req, res, 404, { error: 'not_found', message: 'Not found.' });
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    send(req, res, 200, buf, type, { 'Cache-Control': 'no-cache' });
  });
}

// ---------------------------------------------------------------------------
// Server

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') return json(req, res, 200, { ok: true });
  if (url.pathname.startsWith('/api/')) return routeApi(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, res, 405, { error: 'method', message: 'Method not allowed.' });
  return serveStatic(req, res, url.pathname);
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      const status = err.status || (timedOut ? 504 : 502);
      if (!err.status && !timedOut) console.error(err);
      const message = err.status
        ? err.message
        : timedOut
          ? 'W&B took too long to respond. Try again.'
          : `Could not reach W&B: ${err.cause?.code || err.message}`;
      if (!res.headersSent) json(req, res, status, { error: 'server', message });
      else res.end();
    }
  });

  server.listen(PORT, HOST, () => {
    const lines = [
      '',
      `watchBoard ${VERSION} is running.`,
      `  On this computer:            http://localhost:${PORT}`,
    ];
    if (HOST === '0.0.0.0' || HOST === '::') {
      for (const ip of lanAddresses()) lines.push(`  On your phone (same Wi-Fi):  http://${ip}:${PORT}`);
    }
    lines.push(`  Passcode:                    ${PASSCODE}${secrets.passcodeFromEnv ? '  (from APP_PASSCODE)' : '  (set APP_PASSCODE in .env to choose your own)'}`);
    lines.push(`  W&B API:                     ${BASE_URL}`);
    lines.push(`  API key:                     ${API_KEY ? 'loaded' : 'MISSING. Add WANDB_API_KEY to .env and restart.'}`);
    lines.push(`  Actions (stop run, sweeps):  ${ALLOW_ACTIONS ? 'on' : 'off'}`);
    lines.push('');
    console.log(lines.join('\n'));
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Set PORT in .env to use another one.`);
    else console.error(err);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// `npm run check`: runs every query the app uses against your account.

async function runCheck() {
  const Q = W;
  let failures = 0;
  const step = async (label, fn) => {
    try {
      const note = await fn();
      console.log(`  OK    ${label}${note ? `: ${note}` : ''}`);
      return true;
    } catch (err) {
      failures += 1;
      console.log(`  FAIL  ${label}: ${err.message}`);
      return false;
    }
  };
  const gql = async (query, variables) => {
    const up = await wandbGraphQL(query, variables);
    if (!graphqlPassThrough(up)) throw new Error(upstreamError(up.status, up.text).body.message);
    if (up.data.errors?.length) throw new Error(up.data.errors.map((e) => e.message).join('; '));
    return up.data.data;
  };
  const edges = (conn) => (conn?.edges || []).map((e) => e.node);

  console.log(`\nChecking watchBoard queries against ${BASE_URL}\n`);
  if (!API_KEY) {
    console.log('  FAIL  WANDB_API_KEY is not set. Add it to .env first.\n');
    return 1;
  }

  let viewer;
  const ok = await step('Viewer', async () => {
    viewer = (await gql(Q.Q.viewer)).viewer;
    if (!viewer) throw new Error('No viewer returned. The key may be invalid.');
    return `signed in as ${viewer.username}, entity ${viewer.entity}, ${edges(viewer.teams).length} team(s)`;
  });
  if (!ok) return 1;

  const entities = [...new Set([viewer.entity, ...edges(viewer.teams).map((t) => t.name)])];
  let projects = [];
  await step('Projects for dashboard', async () => {
    const d = await gql(Q.dashProjectsQuery(entities));
    projects = Object.values(d).flatMap(edges);
    projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return `${projects.length} project(s) across ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'}`;
  });
  await step('Project list', async () => `${edges((await gql(Q.Q.projects, { entity: viewer.entity })).models).length} in ${viewer.entity}`);

  const [wantEntity, wantProject] = (env.CHECK_PROJECT || '').split('/');
  const proj = wantProject ? { entityName: wantEntity, name: wantProject } : projects[0];
  if (!proj) {
    console.log('\n  No projects found, so run-level checks were skipped.\n');
    return failures ? 1 : 0;
  }
  const vars = { entity: proj.entityName, project: proj.name };
  console.log(`\n  Using project ${proj.entityName}/${proj.name} (set CHECK_PROJECT=entity/project to pick another)\n`);

  await step('Dashboard runs', async () => {
    const d = await gql(Q.dashRunsQuery(projects.slice(0, 3).length ? projects.slice(0, 3) : [proj]), { running: Q.F.state('running') });
    return `${Object.values(d).reduce((n, p) => n + edges(p?.recent).length, 0)} recent run(s)`;
  });
  await step('Project overview', async () => {
    const p = (await gql(Q.Q.projectOverview, { ...vars, ...Q.F.overviewFilters() })).project;
    return `${p.total} runs, ${p.running} running, ${p.totalSweeps} sweeps`;
  });

  let run;
  await step('Runs list', async () => {
    const d = await gql(Q.Q.runs, { ...vars, perPage: 5, order: '-created_at', filters: null });
    run = edges(d.project.runs)[0];
    return `${d.project.runCount} total`;
  });
  if (run) {
    const rv = { ...vars, name: run.name };
    let detail;
    await step('Run detail', async () => {
      detail = (await gql(Q.Q.run, rv)).project.run;
      return `${detail.displayName} (${detail.state})`;
    });
    const keys = Object.keys(JSON.parse(detail?.historyKeys || '{}').keys || {}).filter((k) => !k.startsWith('_'));
    await step('Run charts (sampled history)', async () => {
      if (!keys.length) return 'run has no history keys, skipped';
      const specs = [JSON.stringify({ keys: ['_step', keys[0]], samples: 20 })];
      const rows = (await gql(Q.Q.sampledHistory, { ...rv, specs })).project.run.sampledHistory[0];
      return `${keys.length} key(s), ${rows.length} point(s) for ${keys[0]}`;
    });
    await step('Dashboard sparklines', async () => {
      if (!keys.length) return 'skipped';
      const items = [{ entity: vars.entity, project: vars.project, run: run.name }];
      await gql(Q.sparkQuery(items), { s0: [JSON.stringify({ keys: ['_step', keys[0]], samples: 10 })] });
      return 'ok';
    });
    await step('System metrics', async () => `${(await gql(Q.Q.systemEvents, { ...rv, samples: 20 })).project.run.events.length} sample(s)`);
    await step('Files', async () => `${(await gql(Q.Q.runFiles, { ...rv, perPage: 5 })).project.run.fileCount} file(s)`);
    await step('Console log', async () => {
      const r = (await gql(Q.Q.consoleLog, { ...vars, runName: run.name, last: 20 })).project.run;
      return `${r.logLineCount ?? 0} line(s), ${edges(r.logLines).length} in sample`;
    });
    await step('Run artifacts', async () => {
      const r = (await gql(Q.Q.runArtifacts, { ...vars, run: run.name })).project.run;
      return `${r.outputs.totalCount} output, ${r.inputs.totalCount} input`;
    });
  }

  await step('Sweeps', async () => {
    const d = await gql(Q.Q.sweeps, { ...vars, filters: '{}', perPage: 5 });
    const sweep = edges(d.project.sweeps)[0];
    if (sweep) await gql(Q.Q.sweep, { ...vars, name: sweep.name });
    return `${d.project.totalSweeps} sweep(s)`;
  });

  await step('Artifacts', async () => {
    const types = edges((await gql(Q.Q.artifactTypes, vars)).project.artifactTypes);
    if (!types.length) return 'no artifact types';
    const cols = edges((await gql(Q.Q.typeCollections, { ...vars, type: types[0].name, perPage: 5 })).project.artifactType.artifactCollections);
    if (cols.length) {
      const v = (await gql(Q.Q.artifactVersions, { ...vars, type: types[0].name, collection: cols[0].name, perPage: 5 })).project.artifactType.artifactCollection.artifacts;
      return `${types.length} type(s), ${cols[0].name} has ${v.totalCount} version(s)`;
    }
    return `${types.length} type(s)`;
  });

  await step('Reports', async () => `${edges((await gql(Q.Q.reports, { ...vars, perPage: 5 })).project.allViews).length} report(s) in first page`);

  await step('Registry', async () => {
    const d = (await gql(Q.Q.orgInfo, { entity: viewer.entity })).entity;
    const orgs = [d?.organization, ...(d?.user?.organizations || [])].filter(Boolean);
    if (!orgs.length) return 'account is not in an organization';
    const regs = edges((await gql(Q.Q.registries, { organization: orgs[0].name, filters: Q.F.registries() })).organization.orgEntity.projects);
    if (regs.length) await gql(Q.Q.projectCollections, { entity: orgs[0].orgEntity.name, project: regs[0].name, perPage: 5 });
    return `${regs.length} registr${regs.length === 1 ? 'y' : 'ies'} in ${orgs[0].name}`;
  });

  await step('Weave traces', async () => {
    const r = await weaveStreamQuery(W.weaveQueryBody({ project: `${vars.entity}/${vars.project}`, filter: { trace_roots_only: true }, limit: 3 }));
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 200)}`);
    return `${W.parseJsonl(text).length} trace(s) in sample`;
  });

  console.log(failures ? `\n${failures} check(s) failed.\n` : '\nAll checks passed.\n');
  return failures ? 1 : 0;
}

if (process.argv.includes('--check')) {
  // Setting exitCode instead of calling process.exit lets open sockets close cleanly.
  process.exitCode = await runCheck();
} else {
  startServer();
}
