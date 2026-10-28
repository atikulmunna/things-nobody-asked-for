// AWS client for the web layer. Every request goes through the native Aws plugin, which holds
// the keys, signs the request and refuses anything that is not a read.
import { Capacitor, registerPlugin } from './vendor/capacitor.js';

export const NATIVE = Capacitor.isNativePlatform();
const Native = NATIVE ? registerPlugin('Aws') : null;

export class AwsError extends Error {
  constructor(message, code = 'error', status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const REGIONS = [
  ['us-east-1', 'N. Virginia'], ['us-east-2', 'Ohio'], ['us-west-1', 'N. California'], ['us-west-2', 'Oregon'],
  ['ca-central-1', 'Canada'], ['ca-west-1', 'Calgary'], ['mx-central-1', 'Mexico'], ['sa-east-1', 'São Paulo'],
  ['eu-west-1', 'Ireland'], ['eu-west-2', 'London'], ['eu-west-3', 'Paris'], ['eu-central-1', 'Frankfurt'],
  ['eu-central-2', 'Zurich'], ['eu-north-1', 'Stockholm'], ['eu-south-1', 'Milan'], ['eu-south-2', 'Spain'],
  ['ap-south-1', 'Mumbai'], ['ap-south-2', 'Hyderabad'], ['ap-southeast-1', 'Singapore'], ['ap-southeast-2', 'Sydney'],
  ['ap-southeast-3', 'Jakarta'], ['ap-southeast-4', 'Melbourne'], ['ap-southeast-5', 'Malaysia'], ['ap-southeast-7', 'Thailand'],
  ['ap-northeast-1', 'Tokyo'], ['ap-northeast-2', 'Seoul'], ['ap-northeast-3', 'Osaka'], ['ap-east-1', 'Hong Kong'],
  ['me-south-1', 'Bahrain'], ['me-central-1', 'UAE'], ['il-central-1', 'Tel Aviv'], ['af-south-1', 'Cape Town'],
];
export const regionName = (code) => REGIONS.find(([c]) => c === code)?.[1] || code;

// ---------------------------------------------------------------------------
// Credentials

export const creds = {
  async status() {
    if (!Native) return { hasCredentials: false };
    return Native.status();
  },
  async save(accessKeyId, secretAccessKey, sessionToken) {
    if (!Native) throw new AwsError('cloudBoard signs requests inside the Android app. Install the APK on your phone.', 'no_native');
    try {
      return await Native.save({ accessKeyId, secretAccessKey, sessionToken });
    } catch (err) {
      throw new AwsError(err.message, 'bad_keys');
    }
  },
  async clear() {
    if (Native) await Native.clear();
  },
};

let onAuthLost = () => {};
export function setAuthLostHandler(fn) {
  onAuthLost = fn;
}

// ---------------------------------------------------------------------------
// Transport

/** RFC 3986 encoding, which is what Signature Version 4 expects. */
export const enc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${enc3986(k)}=${enc3986(String(v))}`)
    .join('&');
}

async function send({ url, region, method = 'GET', headers = {}, body = '', responseType = 'text', timeoutMs = 30000 }) {
  if (!Native) throw new AwsError('cloudBoard signs requests inside the Android app.', 'no_native');
  try {
    return await Native.request({ url, region, method, headers, body, responseType, timeoutMs });
  } catch (err) {
    if (err.code === 'NO_CREDENTIALS') {
      onAuthLost();
      throw new AwsError('Add your AWS keys to continue.', 'no_credentials');
    }
    if (err.code === 'BLOCKED') throw new AwsError(err.message, 'blocked');
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // Keep the raw string.
    }
    throw new AwsError(`Could not reach ${host}. Check your internet connection.`, 'network');
  }
}

const parser = new DOMParser();
export const parseXml = (text) => parser.parseFromString(text, 'application/xml');
// Namespace-agnostic helpers: AWS XML puts everything in a default namespace.
export const kids = (node, name) => (node ? [...node.children].filter((c) => c.localName === name) : []);
export const kid = (node, name) => kids(node, name)[0] || null;
export const txt = (node, name) => {
  const k = name ? kid(node, name) : node;
  return k ? k.textContent : '';
};
const deep = (node, name) => (node ? node.getElementsByTagNameNS('*', name)[0] || null : null);
const members = (node) => kids(node, 'member');

const FRIENDLY = {
  SignatureDoesNotMatch: 'AWS rejected the request signature. Check that the secret access key is correct.',
  InvalidSignatureException: 'AWS rejected the request signature. Check that the secret access key is correct.',
  InvalidClientTokenId: 'AWS does not recognize this access key ID. It may have been deleted or deactivated.',
  InvalidAccessKeyId: 'AWS does not recognize this access key ID. It may have been deleted or deactivated.',
  UnrecognizedClientException: 'AWS does not recognize this access key ID. It may have been deleted or deactivated.',
  RequestTimeTooSkewed: 'Your phone clock is off, so AWS rejected the request. Turn on automatic date and time.',
  SignatureExpired: 'Your phone clock is off, so AWS rejected the request. Turn on automatic date and time.',
  ExpiredToken: 'The temporary session token has expired. Remove the keys in Settings and add fresh ones.',
  ExpiredTokenException: 'The temporary session token has expired. Remove the keys in Settings and add fresh ones.',
  OptInRequired: 'This region is not enabled for your account.',
  Throttling: 'AWS is rate limiting requests. Wait a moment, then refresh.',
  ThrottlingException: 'AWS is rate limiting requests. Wait a moment, then refresh.',
  SlowDown: 'AWS is rate limiting requests. Wait a moment, then refresh.',
};
const AUTH_CODES = new Set(['SignatureDoesNotMatch', 'InvalidSignatureException', 'InvalidClientTokenId', 'InvalidAccessKeyId', 'UnrecognizedClientException', 'ExpiredToken', 'ExpiredTokenException']);
const DENIED = /AccessDenied|AuthorizationError|UnauthorizedOperation|Forbidden/i;

function fail(res, perm) {
  const text = res.body || '';
  let code = '';
  let message = '';
  if (text.trim().startsWith('{')) {
    try {
      const j = JSON.parse(text);
      code = String(j.__type || j.code || '').split('#').pop();
      message = j.message || j.Message || '';
    } catch {
      // Fall through to the generic message.
    }
  } else if (text.trim().startsWith('<')) {
    const doc = parseXml(text);
    code = txt(deep(doc, 'Code'));
    message = txt(deep(doc, 'Message'));
  }
  if (!code && res.headers?.['x-amzn-errortype']) code = res.headers['x-amzn-errortype'].split(':')[0];
  if (!code && res.status === 403) code = 'AccessDenied';
  if (!code && res.status === 404) code = 'NotFound';
  let friendly = FRIENDLY[code];
  if (!friendly && DENIED.test(code)) {
    friendly = perm
      ? `Your IAM user is not allowed to do this. Add ${perm} to its policy.`
      : 'Your IAM user is not allowed to do this.';
  }
  const err = new AwsError(friendly || message || `AWS returned HTTP ${res.status}${code ? ` (${code})` : ''}.`, code || 'http', res.status);
  err.denied = DENIED.test(code);
  err.auth = AUTH_CODES.has(code);
  throw err;
}

async function queryCall(host, region, action, version, params, perm) {
  const res = await send({
    url: `https://${host}/`,
    region,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: qs({ Action: action, Version: version, ...params }),
  });
  if (res.status >= 300) fail(res, perm);
  return parseXml(res.body);
}

async function jsonCall(host, region, target, version, payload, perm) {
  const res = await send({
    url: `https://${host}/`,
    region,
    method: 'POST',
    headers: { 'Content-Type': `application/x-amz-json-${version}`, 'X-Amz-Target': target },
    body: JSON.stringify(payload),
  });
  if (res.status >= 300) fail(res, perm);
  return res.body ? JSON.parse(res.body) : {};
}

/** Runs fn over items with at most `limit` in flight. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        out[i] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// STS

export async function whoAmI() {
  const doc = await queryCall('sts.amazonaws.com', 'us-east-1', 'GetCallerIdentity', '2011-06-15', {});
  const r = deep(doc, 'GetCallerIdentityResult');
  return { account: txt(r, 'Account'), arn: txt(r, 'Arn'), userId: txt(r, 'UserId') };
}

// ---------------------------------------------------------------------------
// S3

const bucketRegions = new Map();

function s3Url(bucket, region, key = null, query = {}) {
  const dotted = !bucket || bucket.includes('.');
  const host = bucket && !dotted ? `${bucket}.s3.${region}.amazonaws.com` : `s3.${region}.amazonaws.com`;
  let path = bucket && dotted ? `/${enc3986(bucket)}` : '';
  if (key !== null) path += `/${key.split('/').map(enc3986).join('/')}`;
  if (!path) path = '/';
  const q = qs(query);
  return `https://${host}${path}${q ? `?${q}` : ''}`;
}

export async function bucketRegion(bucket) {
  if (bucketRegions.has(bucket)) return bucketRegions.get(bucket);
  const res = await send({ url: `https://s3.us-east-1.amazonaws.com/${enc3986(bucket)}`, region: 'us-east-1', method: 'HEAD' });
  const region = res.headers?.['x-amz-bucket-region'] || 'us-east-1';
  bucketRegions.set(bucket, region);
  return region;
}

// Signs for the bucket's region, and follows S3's hint once if the region turns out wrong.
async function s3Send(bucket, { key = null, query = {}, method = 'GET', headers = {}, responseType = 'text' }, perm) {
  let region = bucket ? await bucketRegion(bucket) : 'us-east-1';
  let res = await send({ url: s3Url(bucket, region, key, query), region, method, headers, responseType });
  const hinted = res.headers?.['x-amz-bucket-region'];
  if ((res.status === 301 || res.status === 400 || res.status === 403) && hinted && hinted !== region) {
    region = hinted;
    bucketRegions.set(bucket, region);
    res = await send({ url: s3Url(bucket, region, key, query), region, method, headers, responseType });
  }
  if (res.status >= 300 && res.status !== 304) fail(res, perm);
  return res;
}

export async function listBuckets() {
  const out = [];
  let token = '';
  for (let page = 0; page < 20; page++) {
    const res = await s3Send(null, { query: { 'max-buckets': 1000, 'continuation-token': token } }, 's3:ListAllMyBuckets');
    const doc = parseXml(res.body);
    for (const b of kids(deep(doc, 'Buckets'), 'Bucket')) {
      const name = txt(b, 'Name');
      const region = txt(b, 'BucketRegion');
      if (region) bucketRegions.set(name, region);
      out.push({ name, created: txt(b, 'CreationDate'), region });
    }
    token = txt(deep(doc, 'ContinuationToken'));
    if (!token) break;
  }
  return out;
}

export async function listObjects(bucket, prefix = '', token = '') {
  const res = await s3Send(bucket, {
    query: { 'list-type': 2, delimiter: '/', prefix, 'max-keys': 300, 'continuation-token': token },
  }, 's3:ListBucket');
  const doc = parseXml(res.body);
  const root = doc.documentElement;
  return {
    region: bucketRegions.get(bucket),
    folders: kids(root, 'CommonPrefixes').map((p) => txt(p, 'Prefix')),
    objects: kids(root, 'Contents').map((c) => ({
      key: txt(c, 'Key'),
      size: Number(txt(c, 'Size')) || 0,
      modified: txt(c, 'LastModified'),
      storageClass: txt(c, 'StorageClass'),
    })),
    next: txt(root, 'IsTruncated') === 'true' ? txt(root, 'NextContinuationToken') : '',
  };
}

export async function headObject(bucket, key) {
  const res = await s3Send(bucket, { key, method: 'HEAD' }, 's3:GetObject');
  return res.headers || {};
}

/** The first maxBytes of an object, as text or base64. */
export async function readObject(bucket, key, maxBytes, responseType = 'text') {
  const res = await s3Send(bucket, { key, headers: { Range: `bytes=0-${maxBytes - 1}` }, responseType }, 's3:GetObject');
  return { body: res.body, headers: res.headers || {}, partial: res.status === 206 };
}

export async function bucketInfo(bucket) {
  const sub = async (q, perm, pick) => {
    try {
      const res = await s3Send(bucket, { query: { [q]: '' } }, perm);
      return pick(parseXml(res.body));
    } catch (err) {
      if (err.status === 404) return pick(null);
      return { error: err };
    }
  };
  const [versioning, encryption, publicAccess] = await Promise.all([
    sub('versioning', 's3:GetBucketVersioning', (d) => txt(deep(d, 'Status')) || 'Off'),
    sub('encryption', 's3:GetEncryptionConfiguration', (d) => txt(deep(d, 'SSEAlgorithm')) || 'None'),
    sub('publicAccessBlock', 's3:GetBucketPublicAccessBlock', (d) => {
      if (!d) return 'Not configured';
      const keys = ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets'];
      const on = keys.filter((k) => txt(deep(d, k)) === 'true').length;
      return on === 4 ? 'All blocked' : on === 0 ? 'Not blocked' : `${on} of 4 blocked`;
    }),
  ]);
  return { region: await bucketRegion(bucket), versioning, encryption, publicAccess };
}

export async function presignObject(bucket, key, { download = false } = {}) {
  const region = await bucketRegion(bucket);
  const name = key.split('/').pop();
  const query = download ? { 'response-content-disposition': `attachment; filename="${name.replace(/"/g, '')}"` } : {};
  const res = await Native.presign({ url: s3Url(bucket, region, key, query), region, expiresSeconds: 900 });
  return res.url;
}

export async function openExternal(url) {
  if (Native) await Native.openExternal({ url });
  else window.open(url, '_blank', 'noopener');
}

// ---------------------------------------------------------------------------
// SQS (JSON protocol)

const sqs = (region, action, payload, perm) => jsonCall(`sqs.${region}.amazonaws.com`, region, `AmazonSQS.${action}`, '1.0', payload, perm);

export async function listQueues(region) {
  const urls = [];
  let token;
  for (let page = 0; page < 20; page++) {
    const d = await sqs(region, 'ListQueues', { MaxResults: 1000, NextToken: token }, 'sqs:ListQueues');
    urls.push(...(d.QueueUrls || []));
    token = d.NextToken;
    if (!token) break;
  }
  return urls;
}

export const queueName = (url) => decodeURIComponent(String(url).split('/').pop());
export const queueUrl = (region, account, name) => `https://sqs.${region}.amazonaws.com/${account}/${enc3986(name)}`;

export async function queueAttributes(region, url) {
  const d = await sqs(region, 'GetQueueAttributes', { QueueUrl: url, AttributeNames: ['All'] }, 'sqs:GetQueueAttributes');
  return d.Attributes || {};
}

export async function deadLetterSources(region, url) {
  const d = await sqs(region, 'ListDeadLetterSourceQueues', { QueueUrl: url, MaxResults: 1000 }, 'sqs:ListDeadLetterSourceQueues');
  return d.queueUrls || d.QueueUrls || [];
}

/** Reads up to 10 messages and leaves them visible (the plugin forces VisibilityTimeout to 0). */
export async function peekMessages(region, url) {
  const d = await sqs(region, 'ReceiveMessage', {
    QueueUrl: url,
    MaxNumberOfMessages: 10,
    VisibilityTimeout: 0,
    WaitTimeSeconds: 1,
    MessageAttributeNames: ['All'],
    MessageSystemAttributeNames: ['All'],
  }, 'sqs:ReceiveMessage');
  return d.Messages || [];
}

// ---------------------------------------------------------------------------
// CloudWatch metrics and alarms (query protocol, XML)

const cw = (region, action, params, perm) => queryCall(`monitoring.${region}.amazonaws.com`, region, action, '2010-08-01', params, perm);

const parseDims = (node) => members(kid(node, 'Dimensions')).map((d) => ({ name: txt(d, 'Name'), value: txt(d, 'Value') }));

function parseMetricStat(ms) {
  const metric = kid(ms, 'Metric');
  return {
    namespace: txt(metric, 'Namespace'),
    metric: txt(metric, 'MetricName'),
    dims: parseDims(metric),
    period: Number(txt(ms, 'Period')) || 300,
    stat: txt(ms, 'Stat'),
  };
}

function parseAlarm(m, kind) {
  const a = {
    kind,
    name: txt(m, 'AlarmName'),
    arn: txt(m, 'AlarmArn'),
    description: txt(m, 'AlarmDescription'),
    state: txt(m, 'StateValue'),
    reason: txt(m, 'StateReason'),
    updated: txt(m, 'StateUpdatedTimestamp'),
    actionsEnabled: txt(m, 'ActionsEnabled') === 'true',
    actions: members(kid(m, 'AlarmActions')).map((x) => x.textContent),
  };
  if (kind === 'composite') {
    a.rule = txt(m, 'AlarmRule');
    return a;
  }
  Object.assign(a, {
    namespace: txt(m, 'Namespace'),
    metric: txt(m, 'MetricName'),
    dims: parseDims(m),
    stat: txt(m, 'Statistic') || txt(m, 'ExtendedStatistic'),
    period: Number(txt(m, 'Period')) || 0,
    threshold: txt(m, 'Threshold') === '' ? null : Number(txt(m, 'Threshold')),
    comparison: txt(m, 'ComparisonOperator'),
    evaluationPeriods: Number(txt(m, 'EvaluationPeriods')) || 0,
    datapointsToAlarm: Number(txt(m, 'DatapointsToAlarm')) || 0,
    treatMissing: txt(m, 'TreatMissingData'),
    unit: txt(m, 'Unit'),
    queries: members(kid(m, 'Metrics')).map((q) => ({
      id: txt(q, 'Id'),
      label: txt(q, 'Label'),
      expression: txt(q, 'Expression'),
      returnData: txt(q, 'ReturnData') !== 'false',
      period: Number(txt(q, 'Period')) || 0,
      ...(kid(q, 'MetricStat') ? parseMetricStat(kid(q, 'MetricStat')) : {}),
    })),
  });
  return a;
}

export async function describeAlarms(region) {
  const out = [];
  let token = '';
  for (let page = 0; page < 10; page++) {
    const doc = await cw(region, 'DescribeAlarms', {
      MaxRecords: 100,
      NextToken: token,
      'AlarmTypes.member.1': 'MetricAlarm',
      'AlarmTypes.member.2': 'CompositeAlarm',
    }, 'cloudwatch:DescribeAlarms');
    const r = deep(doc, 'DescribeAlarmsResult');
    for (const m of members(kid(r, 'MetricAlarms'))) out.push(parseAlarm(m, 'metric'));
    for (const m of members(kid(r, 'CompositeAlarms'))) out.push(parseAlarm(m, 'composite'));
    token = txt(r, 'NextToken');
    if (!token) break;
  }
  return out;
}

export async function alarmHistory(region, name) {
  const doc = await cw(region, 'DescribeAlarmHistory', {
    AlarmName: name,
    HistoryItemType: 'StateUpdate',
    MaxRecords: 30,
    ScanBy: 'TimestampDescending',
  }, 'cloudwatch:DescribeAlarmHistory');
  return members(kid(deep(doc, 'DescribeAlarmHistoryResult'), 'AlarmHistoryItems')).map((h) => {
    let data = {};
    try {
      data = JSON.parse(txt(h, 'HistoryData'));
    } catch {
      // Not every item carries JSON.
    }
    return { at: txt(h, 'Timestamp'), summary: txt(h, 'HistorySummary'), from: data.oldState?.stateValue, to: data.newState?.stateValue };
  });
}

/** Lists metrics, following pages up to maxPages (500 per page). */
export async function listMetrics(region, { namespace = '', metric = '', recent = true, maxPages = 10 } = {}) {
  const out = [];
  let token = '';
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    const doc = await cw(region, 'ListMetrics', {
      Namespace: namespace,
      MetricName: metric,
      RecentlyActive: recent ? 'PT3H' : '',
      NextToken: token,
    }, 'cloudwatch:ListMetrics');
    const r = deep(doc, 'ListMetricsResult');
    for (const m of members(kid(r, 'Metrics'))) {
      out.push({ namespace: txt(m, 'Namespace'), metric: txt(m, 'MetricName'), dims: parseDims(m) });
    }
    token = txt(r, 'NextToken');
    if (!token) break;
    truncated = page === maxPages - 1;
  }
  return { metrics: out, truncated };
}

/** Picks a period that gives a few hundred points for the range. */
export function periodFor(rangeMs, min = 60) {
  const sec = rangeMs / 1000;
  return [60, 300, 900, 3600, 21600, 86400].find((p) => p >= min && sec / p <= 500) || 86400;
}

/**
 * queries: [{ id, label?, expression? } | { id, label?, namespace, metric, dims, stat, period }]
 * Returns [{ id, label, points: [[ms, value], ...] }] in query order.
 */
export async function getMetricData(region, queries, startMs, endMs) {
  const params = {
    StartTime: new Date(startMs).toISOString(),
    EndTime: new Date(endMs).toISOString(),
    ScanBy: 'TimestampAscending',
  };
  queries.forEach((q, i) => {
    const p = `MetricDataQueries.member.${i + 1}`;
    params[`${p}.Id`] = q.id;
    if (q.label) params[`${p}.Label`] = q.label;
    params[`${p}.ReturnData`] = q.returnData === false ? 'false' : 'true';
    if (q.expression) {
      params[`${p}.Expression`] = q.expression;
      if (q.period) params[`${p}.Period`] = q.period;
      return;
    }
    params[`${p}.MetricStat.Metric.Namespace`] = q.namespace;
    params[`${p}.MetricStat.Metric.MetricName`] = q.metric;
    (q.dims || []).forEach((d, j) => {
      params[`${p}.MetricStat.Metric.Dimensions.member.${j + 1}.Name`] = d.name;
      params[`${p}.MetricStat.Metric.Dimensions.member.${j + 1}.Value`] = d.value;
    });
    params[`${p}.MetricStat.Period`] = q.period;
    params[`${p}.MetricStat.Stat`] = q.stat;
  });
  const byId = new Map();
  let token = '';
  for (let page = 0; page < 10; page++) {
    const doc = await cw(region, 'GetMetricData', { ...params, NextToken: token }, 'cloudwatch:GetMetricData');
    const r = deep(doc, 'GetMetricDataResult');
    for (const m of members(kid(r, 'MetricDataResults'))) {
      const id = txt(m, 'Id');
      const ts = members(kid(m, 'Timestamps')).map((t) => Date.parse(t.textContent));
      const vs = members(kid(m, 'Values')).map((v) => Number(v.textContent));
      const entry = byId.get(id) || { id, label: txt(m, 'Label'), points: [] };
      ts.forEach((t, k) => entry.points.push([t, vs[k]]));
      byId.set(id, entry);
    }
    token = txt(r, 'NextToken');
    if (!token) break;
  }
  return queries
    .filter((q) => q.returnData !== false)
    .map((q) => byId.get(q.id) || { id: q.id, label: q.label || q.metric || q.id, points: [] });
}

// ---------------------------------------------------------------------------
// CloudWatch Logs (JSON protocol)

const logs = (region, action, payload, perm) => jsonCall(`logs.${region}.amazonaws.com`, region, `Logs_20140328.${action}`, '1.1', payload, perm);

export async function describeLogGroups(region, { pattern = '', token } = {}) {
  const d = await logs(region, 'DescribeLogGroups', {
    limit: 50,
    nextToken: token,
    logGroupNamePattern: pattern || undefined,
  }, 'logs:DescribeLogGroups');
  return { groups: d.logGroups || [], next: d.nextToken || '' };
}

export async function describeLogStreams(region, group, token) {
  const d = await logs(region, 'DescribeLogStreams', {
    logGroupName: group,
    orderBy: 'LastEventTime',
    descending: true,
    limit: 50,
    nextToken: token,
  }, 'logs:DescribeLogStreams');
  return { streams: d.logStreams || [], next: d.nextToken || '' };
}

export async function getLogEvents(region, group, stream, { token, fromHead = false, limit = 300 } = {}) {
  return logs(region, 'GetLogEvents', {
    logGroupName: group,
    logStreamName: stream,
    startFromHead: fromHead,
    limit,
    nextToken: token,
  }, 'logs:GetLogEvents');
}

export async function filterLogEvents(region, group, { pattern = '', startTime, token, limit = 300 } = {}) {
  return logs(region, 'FilterLogEvents', {
    logGroupName: group,
    filterPattern: pattern || undefined,
    startTime,
    limit,
    nextToken: token,
  }, 'logs:FilterLogEvents');
}

// ---------------------------------------------------------------------------
// Advanced mode services (all read-only, enforced natively)

async function restGet(host, region, path, query, perm) {
  const q = qs(query || {});
  const res = await send({ url: `https://${host}${path}${q ? `?${q}` : ''}`, region });
  if (res.status >= 300) fail(res, perm);
  return res.body ? JSON.parse(res.body) : {};
}

const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

// ECS
const ecs = (region, action, payload, perm) => jsonCall(`ecs.${region}.amazonaws.com`, region, `AmazonEC2ContainerServiceV20141113.${action}`, '1.1', payload, perm);

export async function ecsClusters(region) {
  const arns = [];
  let token;
  for (let p = 0; p < 10; p++) {
    const d = await ecs(region, 'ListClusters', { maxResults: 100, nextToken: token }, 'ecs:ListClusters');
    arns.push(...(d.clusterArns || []));
    token = d.nextToken;
    if (!token) break;
  }
  const out = [];
  for (const part of chunk(arns, 100)) {
    const d = await ecs(region, 'DescribeClusters', { clusters: part }, 'ecs:DescribeClusters');
    out.push(...(d.clusters || []));
  }
  return out;
}

export async function ecsServices(region, cluster) {
  const arns = [];
  let token;
  for (let p = 0; p < 20; p++) {
    const d = await ecs(region, 'ListServices', { cluster, maxResults: 100, nextToken: token }, 'ecs:ListServices');
    arns.push(...(d.serviceArns || []));
    token = d.nextToken;
    if (!token) break;
  }
  const parts = await Promise.all(chunk(arns, 10).map((part) => ecs(region, 'DescribeServices', { cluster, services: part }, 'ecs:DescribeServices')));
  return parts.flatMap((d) => d.services || []);
}

export async function ecsTasks(region, cluster, serviceName) {
  const lists = await Promise.all(['RUNNING', 'STOPPED'].map((desiredStatus) =>
    ecs(region, 'ListTasks', { cluster, serviceName, desiredStatus, maxResults: 100 }, 'ecs:ListTasks')));
  const arns = lists.flatMap((d) => d.taskArns || []).slice(0, 100);
  if (!arns.length) return [];
  const d = await ecs(region, 'DescribeTasks', { cluster, tasks: arns }, 'ecs:DescribeTasks');
  return d.tasks || [];
}

// EC2 (query protocol; lists are <item> elements)
const ec2 = (region, action, params, perm) => queryCall(`ec2.${region}.amazonaws.com`, region, action, '2016-11-15', params, perm);
const items = (node) => kids(node, 'item');

export async function ec2Instances(region) {
  const out = [];
  let token = '';
  for (let p = 0; p < 10; p++) {
    const doc = await ec2(region, 'DescribeInstances', { MaxResults: 1000, NextToken: token }, 'ec2:DescribeInstances');
    const root = doc.documentElement;
    for (const r of items(kid(root, 'reservationSet'))) {
      for (const i of items(kid(r, 'instancesSet'))) {
        const tags = Object.fromEntries(items(kid(i, 'tagSet')).map((t) => [txt(t, 'key'), txt(t, 'value')]));
        out.push({
          id: txt(i, 'instanceId'),
          name: tags.Name || '',
          type: txt(i, 'instanceType'),
          state: txt(kid(i, 'instanceState'), 'name'),
          stateReason: txt(kid(i, 'stateReason'), 'message'),
          privateIp: txt(i, 'privateIpAddress'),
          publicIp: txt(i, 'ipAddress'),
          launched: txt(i, 'launchTime'),
          az: txt(kid(i, 'placement'), 'availabilityZone'),
          platform: txt(i, 'platformDetails'),
          arch: txt(i, 'architecture'),
          image: txt(i, 'imageId'),
          vpc: txt(i, 'vpcId'),
          subnet: txt(i, 'subnetId'),
          keyName: txt(i, 'keyName'),
          spot: txt(i, 'instanceLifecycle') === 'spot',
          profile: txt(kid(i, 'iamInstanceProfile'), 'arn'),
          groups: items(kid(i, 'groupSet')).map((g) => txt(g, 'groupName')),
          tags,
        });
      }
    }
    token = txt(root, 'nextToken');
    if (!token) break;
  }
  return out;
}

// IAM (global; signed for us-east-1)
const iam = (action, params, perm) => queryCall('iam.amazonaws.com', 'us-east-1', action, '2010-05-08', params, perm);
const decodeDoc = (s) => {
  try {
    return JSON.parse(decodeURIComponent(s));
  } catch {
    return s;
  }
};

/** The principal behind an ARN: { kind: 'user'|'role'|'root'|'other', name }. */
export function principalOf(arn) {
  const res = String(arn).split(':').slice(5).join(':');
  if (res === 'root') return { kind: 'root', name: 'root' };
  if (res.startsWith('user/')) return { kind: 'user', name: res.split('/').pop() };
  if (res.startsWith('assumed-role/')) return { kind: 'role', name: res.split('/')[1] };
  return { kind: 'other', name: res };
}

export async function iamPolicies(principal) {
  const settle = async (p) => {
    try {
      return { ok: true, value: await p };
    } catch (error) {
      return { ok: false, error };
    }
  };
  const list = async (action, params, container, perm, pick) => {
    const doc = await iam(action, params, perm);
    return members(deep(doc, container)).map(pick);
  };
  const attachedPick = (m) => ({ name: txt(m, 'PolicyName'), arn: txt(m, 'PolicyArn') });
  const namePick = (m) => m.textContent;
  const { kind, name } = principal;
  if (kind === 'role') {
    const [attached, inline] = await Promise.all([
      settle(list('ListAttachedRolePolicies', { RoleName: name }, 'AttachedPolicies', 'iam:ListAttachedRolePolicies', attachedPick)),
      settle(list('ListRolePolicies', { RoleName: name }, 'PolicyNames', 'iam:ListRolePolicies', namePick)),
    ]);
    return { attached, inline, groups: { ok: true, value: [] } };
  }
  const [attached, inline, groupList] = await Promise.all([
    settle(list('ListAttachedUserPolicies', { UserName: name }, 'AttachedPolicies', 'iam:ListAttachedUserPolicies', attachedPick)),
    settle(list('ListUserPolicies', { UserName: name }, 'PolicyNames', 'iam:ListUserPolicies', namePick)),
    settle(list('ListGroupsForUser', { UserName: name }, 'Groups', 'iam:ListGroupsForUser', (m) => txt(m, 'GroupName'))),
  ]);
  let groups = groupList;
  if (groupList.ok) {
    const detail = await Promise.all(groupList.value.map(async (g) => {
      const [ga, gi] = await Promise.all([
        settle(list('ListAttachedGroupPolicies', { GroupName: g }, 'AttachedPolicies', 'iam:ListAttachedGroupPolicies', attachedPick)),
        settle(list('ListGroupPolicies', { GroupName: g }, 'PolicyNames', 'iam:ListGroupPolicies', namePick)),
      ]);
      return { name: g, attached: ga, inline: gi };
    }));
    groups = { ok: true, value: detail };
  }
  return { attached, inline, groups };
}

export async function iamManagedDoc(arn) {
  const p = await iam('GetPolicy', { PolicyArn: arn }, 'iam:GetPolicy');
  const version = txt(deep(p, 'DefaultVersionId'));
  const v = await iam('GetPolicyVersion', { PolicyArn: arn, VersionId: version }, 'iam:GetPolicyVersion');
  return { version, document: decodeDoc(txt(deep(v, 'Document'))) };
}

export async function iamInlineDoc(kind, owner, policy) {
  const call = {
    user: ['GetUserPolicy', 'UserName'],
    group: ['GetGroupPolicy', 'GroupName'],
    role: ['GetRolePolicy', 'RoleName'],
  }[kind];
  const doc = await iam(call[0], { [call[1]]: owner, PolicyName: policy }, `iam:${call[0]}`);
  return { document: decodeDoc(txt(deep(doc, 'PolicyDocument'))) };
}

// Lambda (REST)
export async function lambdaFunctions(region) {
  const out = [];
  let marker = '';
  for (let p = 0; p < 20; p++) {
    const d = await restGet(`lambda.${region}.amazonaws.com`, region, '/2015-03-31/functions/', { MaxItems: 50, Marker: marker }, 'lambda:ListFunctions');
    out.push(...(d.Functions || []));
    marker = d.NextMarker || '';
    if (!marker) break;
  }
  return out;
}

export const lambdaFunction = (region, name) =>
  restGet(`lambda.${region}.amazonaws.com`, region, `/2015-03-31/functions/${enc3986(name)}/configuration`, {}, 'lambda:GetFunctionConfiguration');

// Cost Explorer (us-east-1 only; AWS charges $0.01 per request)
export async function costAndUsage() {
  const day = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const results = [];
  let token;
  for (let p = 0; p < 5; p++) {
    const d = await jsonCall('ce.us-east-1.amazonaws.com', 'us-east-1', 'AWSInsightsIndexService.GetCostAndUsage', '1.1', {
      TimePeriod: { Start: day(start), End: day(end) },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      NextPageToken: token,
    }, 'ce:GetCostAndUsage');
    results.push(...(d.ResultsByTime || []));
    token = d.NextPageToken;
    if (!token) break;
  }
  return results;
}

// DynamoDB
const ddb = (region, action, payload, perm) => jsonCall(`dynamodb.${region}.amazonaws.com`, region, `DynamoDB_20120810.${action}`, '1.0', payload, perm);

export async function ddbTables(region) {
  const names = [];
  let start;
  for (let p = 0; p < 20; p++) {
    const d = await ddb(region, 'ListTables', { Limit: 100, ExclusiveStartTableName: start }, 'dynamodb:ListTables');
    names.push(...(d.TableNames || []));
    start = d.LastEvaluatedTableName;
    if (!start) break;
  }
  return names;
}

export const ddbTable = async (region, name) => (await ddb(region, 'DescribeTable', { TableName: name }, 'dynamodb:DescribeTable')).Table || {};

// RDS (query protocol; list elements are named after their type)
const rds = (region, action, params, perm) => queryCall(`rds.${region}.amazonaws.com`, region, action, '2014-10-31', params, perm);

export async function rdsInstances(region) {
  const out = [];
  let marker = '';
  for (let p = 0; p < 10; p++) {
    const doc = await rds(region, 'DescribeDBInstances', { MaxRecords: 100, Marker: marker }, 'rds:DescribeDBInstances');
    const r = deep(doc, 'DescribeDBInstancesResult');
    for (const i of kids(kid(r, 'DBInstances'), 'DBInstance')) {
      out.push({
        id: txt(i, 'DBInstanceIdentifier'),
        class: txt(i, 'DBInstanceClass'),
        engine: txt(i, 'Engine'),
        version: txt(i, 'EngineVersion'),
        status: txt(i, 'DBInstanceStatus'),
        endpoint: txt(kid(i, 'Endpoint'), 'Address'),
        port: txt(kid(i, 'Endpoint'), 'Port'),
        storage: Number(txt(i, 'AllocatedStorage')) || 0,
        storageType: txt(i, 'StorageType'),
        multiAz: txt(i, 'MultiAZ') === 'true',
        az: txt(i, 'AvailabilityZone'),
        cluster: txt(i, 'DBClusterIdentifier'),
        created: txt(i, 'InstanceCreateTime'),
        encrypted: txt(i, 'StorageEncrypted') === 'true',
        publiclyAccessible: txt(i, 'PubliclyAccessible') === 'true',
        backupRetention: Number(txt(i, 'BackupRetentionPeriod')) || 0,
      });
    }
    marker = txt(r, 'Marker');
    if (!marker) break;
  }
  return out;
}

export async function rdsClusters(region) {
  const doc = await rds(region, 'DescribeDBClusters', { MaxRecords: 100 }, 'rds:DescribeDBClusters');
  const r = deep(doc, 'DescribeDBClustersResult');
  return kids(kid(r, 'DBClusters'), 'DBCluster').map((c) => ({
    id: txt(c, 'DBClusterIdentifier'),
    engine: txt(c, 'Engine'),
    version: txt(c, 'EngineVersion'),
    status: txt(c, 'Status'),
    endpoint: txt(c, 'Endpoint'),
    reader: txt(c, 'ReaderEndpoint'),
    port: txt(c, 'Port'),
    mode: txt(c, 'EngineMode'),
    multiAz: txt(c, 'MultiAZ') === 'true',
    encrypted: txt(c, 'StorageEncrypted') === 'true',
    created: txt(c, 'ClusterCreateTime'),
    members: kids(kid(c, 'DBClusterMembers'), 'DBClusterMember').map((m) => ({ id: txt(m, 'DBInstanceIdentifier'), writer: txt(m, 'IsClusterWriter') === 'true' })),
  }));
}

// SNS
const sns = (region, action, params, perm) => queryCall(`sns.${region}.amazonaws.com`, region, action, '2010-03-31', params, perm);

export async function snsTopics(region) {
  const out = [];
  let token = '';
  for (let p = 0; p < 20; p++) {
    const doc = await sns(region, 'ListTopics', { NextToken: token }, 'sns:ListTopics');
    const r = deep(doc, 'ListTopicsResult');
    out.push(...members(kid(r, 'Topics')).map((m) => txt(m, 'TopicArn')));
    token = txt(r, 'NextToken');
    if (!token) break;
  }
  return out;
}

export async function snsTopic(region, arn) {
  const [a, s] = await Promise.allSettled([
    sns(region, 'GetTopicAttributes', { TopicArn: arn }, 'sns:GetTopicAttributes'),
    sns(region, 'ListSubscriptionsByTopic', { TopicArn: arn }, 'sns:ListSubscriptionsByTopic'),
  ]);
  if (a.status === 'rejected') throw a.reason;
  const attrs = Object.fromEntries(kids(deep(a.value, 'Attributes'), 'entry').map((e) => [txt(e, 'key'), txt(e, 'value')]));
  const subs = s.status === 'fulfilled'
    ? members(deep(s.value, 'Subscriptions')).map((m) => ({ arn: txt(m, 'SubscriptionArn'), protocol: txt(m, 'Protocol'), endpoint: txt(m, 'Endpoint') }))
    : { error: s.reason };
  return { attrs, subs };
}

// ---------------------------------------------------------------------------
// Access check: one harmless read per service shows what the IAM user may use.

export const SERVICES = [
  { key: 's3', label: 'S3', action: 's3:ListAllMyBuckets' },
  { key: 'sqs', label: 'SQS', action: 'sqs:ListQueues' },
  { key: 'cloudwatch', label: 'CloudWatch metrics and alarms', action: 'cloudwatch:DescribeAlarms' },
  { key: 'logs', label: 'CloudWatch Logs', action: 'logs:DescribeLogGroups' },
  { key: 'ecs', label: 'ECS', action: 'ecs:ListClusters' },
  { key: 'ec2', label: 'EC2', action: 'ec2:DescribeInstances' },
  { key: 'lambda', label: 'Lambda', action: 'lambda:ListFunctions' },
  { key: 'dynamodb', label: 'DynamoDB', action: 'dynamodb:ListTables' },
  { key: 'rds', label: 'RDS', action: 'rds:DescribeDBInstances' },
  { key: 'sns', label: 'SNS', action: 'sns:ListTopics' },
  { key: 'iam', label: 'IAM (read own policies)', action: 'iam:List*Policies' },
  { key: 'ce', label: 'Cost Explorer', action: 'ce:GetCostAndUsage', manual: true },
];

const PROBES = {
  s3: () => s3Send(null, { query: { 'max-buckets': 1 } }),
  sqs: (r) => sqs(r, 'ListQueues', { MaxResults: 1 }),
  cloudwatch: (r) => cw(r, 'DescribeAlarms', { MaxRecords: 1 }),
  logs: (r) => logs(r, 'DescribeLogGroups', { limit: 1 }),
  ecs: (r) => ecs(r, 'ListClusters', { maxResults: 1 }),
  ec2: (r) => ec2(r, 'DescribeInstances', { MaxResults: 5 }),
  lambda: (r) => restGet(`lambda.${r}.amazonaws.com`, r, '/2015-03-31/functions/', { MaxItems: 1 }),
  dynamodb: (r) => ddb(r, 'ListTables', { Limit: 1 }),
  rds: (r) => rds(r, 'DescribeDBInstances', { MaxRecords: 20 }),
  sns: (r) => sns(r, 'ListTopics', {}),
  iam: async (r, principal) => {
    if (principal.kind === 'root') return;
    if (principal.kind === 'role') await iam('ListAttachedRolePolicies', { RoleName: principal.name });
    else await iam('ListAttachedUserPolicies', { UserName: principal.name });
  },
};

/** Returns { [key]: 'allowed' | 'denied' | 'error' | 'unchecked' }. */
export async function checkAccess(region, principal) {
  const out = {};
  await Promise.all(SERVICES.map(async (s) => {
    if (s.manual) {
      out[s.key] = 'unchecked';
      return;
    }
    try {
      await PROBES[s.key](region, principal);
      out[s.key] = 'allowed';
    } catch (err) {
      out[s.key] = err.denied ? 'denied' : err.code === 'OptInRequired' ? 'denied' : 'error';
    }
  }));
  return out;
}

// ---------------------------------------------------------------------------

export const IAM_POLICY = {
  Version: '2012-10-17',
  Statement: [{
    Sid: 'CloudBoardReadOnly',
    Effect: 'Allow',
    Action: [
      's3:ListAllMyBuckets', 's3:ListBucket', 's3:GetObject', 's3:GetBucketVersioning',
      's3:GetEncryptionConfiguration', 's3:GetBucketPublicAccessBlock',
      'sqs:ListQueues', 'sqs:GetQueueAttributes', 'sqs:ListDeadLetterSourceQueues', 'sqs:ReceiveMessage',
      'cloudwatch:DescribeAlarms', 'cloudwatch:DescribeAlarmHistory', 'cloudwatch:ListMetrics', 'cloudwatch:GetMetricData',
      'logs:DescribeLogGroups', 'logs:DescribeLogStreams', 'logs:GetLogEvents', 'logs:FilterLogEvents',
    ],
    Resource: '*',
  }, {
    Sid: 'CloudBoardAdvancedReadOnly',
    Effect: 'Allow',
    Action: [
      'ecs:ListClusters', 'ecs:DescribeClusters', 'ecs:ListServices', 'ecs:DescribeServices', 'ecs:ListTasks', 'ecs:DescribeTasks',
      'ec2:DescribeInstances',
      'lambda:ListFunctions', 'lambda:GetFunctionConfiguration',
      'dynamodb:ListTables', 'dynamodb:DescribeTable',
      'rds:DescribeDBInstances', 'rds:DescribeDBClusters',
      'sns:ListTopics', 'sns:GetTopicAttributes', 'sns:ListSubscriptionsByTopic',
      'ce:GetCostAndUsage',
      'iam:ListAttachedUserPolicies', 'iam:ListUserPolicies', 'iam:GetUserPolicy', 'iam:ListGroupsForUser',
      'iam:ListAttachedGroupPolicies', 'iam:ListGroupPolicies', 'iam:GetGroupPolicy', 'iam:GetPolicy', 'iam:GetPolicyVersion',
    ],
    Resource: '*',
  }],
};
