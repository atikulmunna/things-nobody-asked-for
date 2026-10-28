// Made-up data for previewing the interface in a desktop browser (open index.html?demo).
// The Android app never loads this file.
export { queueName, queueUrl, periodFor, SERVICES, principalOf } from './aws.js';

const wait = () => Promise.resolve();
const now = Date.now();
const ACCOUNT = '123456789012';
let saved = true;

export const creds = {
  status: async () => (saved ? { hasCredentials: true, accessKeyId: 'AKIA…7Q2X', temporary: false } : { hasCredentials: false }),
  save: async () => { saved = true; return { accessKeyId: 'AKIA…7Q2X' }; },
  clear: async () => { saved = false; },
};

export async function whoAmI() {
  await wait();
  return { account: ACCOUNT, arn: `arn:aws:iam::${ACCOUNT}:user/cloudboard-readonly`, userId: 'AIDAEXAMPLEUSERID' };
}

const BUCKETS = [
  ['acme-prod-assets', 'us-east-1', 400], ['acme-data-lake', 'us-east-1', 900], ['acme-logs-archive', 'eu-west-1', 700],
  ['ml-training-sets', 'us-west-2', 200], ['static.acme.dev', 'us-east-1', 120], ['acme-backups', 'ap-south-1', 60],
];
export async function listBuckets() {
  await wait();
  return BUCKETS.map(([name, region, days]) => ({ name, region, created: new Date(now - days * 864e5).toISOString() }));
}
export async function listObjects(bucket, prefix = '') {
  await wait();
  const depth = prefix.split('/').filter(Boolean).length;
  const folders = depth < 2 ? ['images/', 'reports/', 'exports/', '2026/'].map((f) => prefix + f) : [];
  const objects = [
    ['config.json', 1840], ['README.md', 4200], ['hero.png', 482000], ['events.csv', 2_400_000], ['dump.tar.gz', 734_000_000],
  ].map(([k, size], i) => ({ key: prefix + k, size, modified: new Date(now - (i + 1) * 36e5 * 7).toISOString(), storageClass: i === 4 ? 'GLACIER_IR' : 'STANDARD' }));
  return { folders, objects, next: '' };
}
export async function headObject(bucket, key) {
  await wait();
  const ext = key.split('.').pop();
  const types = { json: 'application/json', md: 'text/markdown', png: 'image/png', csv: 'text/csv', gz: 'application/gzip' };
  return {
    'content-length': ext === 'png' ? '482000' : ext === 'gz' ? '734000000' : '1840',
    'content-type': types[ext] || 'binary/octet-stream',
    'last-modified': new Date(now - 7 * 36e5).toUTCString(),
    etag: '"9b2cf535f27731c974343645a3985328"',
    'x-amz-server-side-encryption': 'AES256',
    'x-amz-meta-uploaded-by': 'ci-pipeline',
  };
}
export async function readObject(bucket, key, max, type) {
  await wait();
  if (type === 'base64') {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 220"><rect width="400" height="220" fill="#232f3e"/><circle cx="200" cy="110" r="60" fill="#ff9900"/></svg>';
    return { body: btoa(svg), headers: {}, partial: false };
  }
  return { body: JSON.stringify({ service: 'checkout', replicas: 3, regions: ['us-east-1', 'eu-west-1'], features: { search: true, beta: false } }), headers: {}, partial: false };
}
export async function bucketInfo(bucket) {
  await wait(400);
  return { region: BUCKETS.find((b) => b[0] === bucket)?.[1] || 'us-east-1', versioning: 'Enabled', encryption: 'aws:kms', publicAccess: 'All blocked' };
}
export const presignObject = async () => 'https://example.com/presigned';
export const openExternal = async (url) => window.open(url, '_blank', 'noopener');

const QUEUES = {
  'orders-intake': { v: 1284, f: 37, d: 0 },
  'orders-intake-dlq': { v: 12, f: 0, d: 0, dlqOf: true },
  'email-dispatch': { v: 0, f: 4, d: 2 },
  'payments-events.fifo': { v: 58, f: 3, d: 0 },
  'thumbnail-jobs': { v: 311, f: 20, d: 0 },
  'audit-trail': { v: 0, f: 0, d: 0 },
};
const qurl = (n) => `https://sqs.ap-southeast-1.amazonaws.com/${ACCOUNT}/${n}`;
export async function listQueues() {
  await wait();
  return Object.keys(QUEUES).map(qurl);
}
export async function queueAttributes(region, url) {
  const name = url.split('/').pop();
  const q = QUEUES[name] || { v: 0, f: 0, d: 0 };
  return {
    QueueArn: `arn:aws:sqs:${region}:${ACCOUNT}:${name}`,
    ApproximateNumberOfMessages: String(q.v),
    ApproximateNumberOfMessagesNotVisible: String(q.f),
    ApproximateNumberOfMessagesDelayed: String(q.d),
    MessageRetentionPeriod: '345600',
    VisibilityTimeout: '30',
    MaximumMessageSize: '262144',
    ReceiveMessageWaitTimeSeconds: '20',
    DelaySeconds: '0',
    CreatedTimestamp: String(Math.floor((now - 200 * 864e5) / 1000)),
    LastModifiedTimestamp: String(Math.floor((now - 3 * 864e5) / 1000)),
    SqsManagedSseEnabled: 'true',
    ...(name === 'orders-intake' ? { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: `arn:aws:sqs:${region}:${ACCOUNT}:orders-intake-dlq`, maxReceiveCount: 5 }) } : {}),
  };
}
export const deadLetterSources = async (region, url) => (url.endsWith('-dlq') ? [qurl('orders-intake')] : []);
export async function peekMessages() {
  await wait(600);
  return [1, 2, 3].map((i) => ({
    MessageId: `5fea7756-0ea4-451a-a703-a558b933e27${i}`,
    Body: JSON.stringify({ orderId: `ord_${1000 + i}`, total: 49.9 * i, currency: 'USD', items: i + 1 }),
    Attributes: { SentTimestamp: String(now - i * 6e5), ApproximateReceiveCount: String(i), SenderId: 'AIDAEXAMPLE' },
    MessageAttributes: { source: { StringValue: 'web-checkout', DataType: 'String' } },
  }));
}

const ALARMS = [
  { name: 'orders-dlq-not-empty', state: 'ALARM', metric: 'ApproximateNumberOfMessagesVisible', namespace: 'AWS/SQS', dims: [{ name: 'QueueName', value: 'orders-intake-dlq' }], threshold: 0, comparison: 'GreaterThanThreshold', stat: 'Maximum', mins: 42 },
  { name: 'api-5xx-rate-high', state: 'ALARM', metric: '5XXError', namespace: 'AWS/ApiGateway', dims: [{ name: 'ApiName', value: 'public-api' }], threshold: 25, comparison: 'GreaterThanThreshold', stat: 'Sum', mins: 9 },
  { name: 'checkout-latency-p99', state: 'OK', metric: 'Latency', namespace: 'AWS/ApiGateway', dims: [{ name: 'ApiName', value: 'public-api' }], threshold: 1200, comparison: 'GreaterThanThreshold', stat: 'p99', mins: 300 },
  { name: 'rds-cpu-high', state: 'OK', metric: 'CPUUtilization', namespace: 'AWS/RDS', dims: [{ name: 'DBInstanceIdentifier', value: 'prod-db-1' }], threshold: 80, comparison: 'GreaterThanOrEqualToThreshold', stat: 'Average', mins: 2000 },
  { name: 'lambda-thumbnail-errors', state: 'INSUFFICIENT_DATA', metric: 'Errors', namespace: 'AWS/Lambda', dims: [{ name: 'FunctionName', value: 'thumbnailer' }], threshold: 5, comparison: 'GreaterThanThreshold', stat: 'Sum', mins: 90 },
];
export async function describeAlarms() {
  await wait();
  return ALARMS.map((a) => ({
    kind: 'metric', ...a, period: 300, evaluationPeriods: 3, datapointsToAlarm: 2, actionsEnabled: true, queries: [], unit: '', treatMissing: 'missing',
    description: a.state === 'ALARM' ? 'Pages the on-call engineer.' : '',
    reason: a.state === 'ALARM' ? `Threshold Crossed: 2 out of the last 3 datapoints were greater than the threshold (${a.threshold}).` : 'Threshold Crossed: no datapoints were greater than the threshold.',
    updated: new Date(now - a.mins * 6e4).toISOString(),
  }));
}
export async function alarmHistory(region, name) {
  await wait();
  const a = ALARMS.find((x) => x.name === name);
  return [
    { at: new Date(now - a.mins * 6e4).toISOString(), summary: `Alarm updated from OK to ${a.state}`, to: a.state },
    { at: new Date(now - (a.mins + 600) * 6e4).toISOString(), summary: 'Alarm updated from ALARM to OK', to: 'OK' },
    { at: new Date(now - (a.mins + 700) * 6e4).toISOString(), summary: 'Alarm updated from OK to ALARM', to: 'ALARM' },
  ];
}

const METRICS = [
  ['AWS/SQS', 'ApproximateNumberOfMessagesVisible', 'QueueName'], ['AWS/SQS', 'NumberOfMessagesSent', 'QueueName'],
  ['AWS/Lambda', 'Invocations', 'FunctionName'], ['AWS/Lambda', 'Duration', 'FunctionName'], ['AWS/Lambda', 'Errors', 'FunctionName'],
  ['AWS/EC2', 'CPUUtilization', 'InstanceId'], ['AWS/EC2', 'NetworkIn', 'InstanceId'], ['AWS/RDS', 'CPUUtilization', 'DBInstanceIdentifier'],
  ['AWS/ApiGateway', 'Count', 'ApiName'], ['AWS/ApiGateway', 'Latency', 'ApiName'], ['Acme/Checkout', 'OrdersPlaced', 'Env'],
];
export async function listMetrics(region, { namespace = '' } = {}) {
  await wait();
  const out = [];
  for (const [ns, metric, dim] of METRICS) {
    if (namespace && ns !== namespace) continue;
    for (const v of ['prod-a', 'prod-b', 'staging']) out.push({ namespace: ns, metric, dims: [{ name: dim, value: v }] });
  }
  return { metrics: out, truncated: false };
}
export async function getMetricData(region, queries, start, end) {
  await wait(350);
  return queries.filter((q) => q.returnData !== false).map((q, qi) => {
    const period = (q.period || 300) * 1000;
    const points = [];
    let seed = (q.metric || q.id).length * 7 + qi * 13;
    const base = q.metric === 'NumberOfObjects' ? 120000 : q.id === 'size' ? 8.4e10 : 40 + seed % 60;
    for (let t = Math.ceil(start / period) * period; t <= end; t += period) {
      seed = (seed * 9301 + 49297) % 233280;
      const wave = Math.sin(t / 3.6e6) * base * 0.3;
      points.push([t, Math.max(0, base + wave + (seed / 233280 - 0.5) * base * 0.4)]);
    }
    return { id: q.id, label: q.label || q.metric, points };
  });
}

const GROUPS = ['/aws/lambda/thumbnailer', '/aws/lambda/order-processor', '/aws/apigateway/public-api', '/ecs/checkout-service', 'application/web'];
export async function describeLogGroups(region, { pattern = '' } = {}) {
  await wait();
  return {
    groups: GROUPS.filter((g) => g.includes(pattern)).map((g, i) => ({ logGroupName: g, storedBytes: (i + 1) * 3.3e8, retentionInDays: i % 2 ? 30 : undefined, creationTime: now - i * 864e6 })),
    next: '',
  };
}
export async function describeLogStreams() {
  await wait();
  return {
    streams: [0, 1, 2, 3].map((i) => ({ logStreamName: `2026/10/28/[$LATEST]a1b2c3d4e5f6${i}`, lastEventTimestamp: now - i * 9e5, firstEventTimestamp: now - (i + 1) * 36e5 })),
    next: '',
  };
}
const LINES = ['START RequestId: 8f2c Version: $LATEST', 'Processing order ord_1042', 'WARN retrying payment provider (attempt 2)', 'Order ord_1042 stored in 182 ms', 'ERROR Timeout waiting for inventory-service', 'END RequestId: 8f2c', 'REPORT Duration: 812.4 ms Billed Duration: 813 ms Memory Size: 512 MB'];
export async function getLogEvents() {
  await wait();
  const events = Array.from({ length: 60 }, (_, i) => ({ timestamp: now - (60 - i) * 4000, message: LINES[i % LINES.length] }));
  return { events, nextBackwardToken: 'b', nextForwardToken: 'f' };
}
export async function filterLogEvents(region, group, { pattern = '' } = {}) {
  await wait();
  const events = Array.from({ length: 30 }, (_, i) => ({ timestamp: now - (30 - i) * 6e4, logStreamName: `2026/10/28/[$LATEST]a1b2c3d4e5f6${i % 3}`, message: LINES[i % LINES.length] }))
    .filter((e) => !pattern || e.message.toLowerCase().includes(pattern.toLowerCase()));
  return { events, nextToken: '' };
}

export async function checkAccess() {
  return { s3: 'allowed', sqs: 'allowed', cloudwatch: 'allowed', logs: 'allowed', ecs: 'allowed', ec2: 'denied', lambda: 'allowed', dynamodb: 'allowed', rds: 'denied', sns: 'allowed', iam: 'denied', ce: 'unchecked' };
}

export async function costAndUsage() {
  const out = [];
  const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1));
  for (let d = new Date(start); d <= new Date(); d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.getUTCDate();
    out.push({
      TimePeriod: { Start: d.toISOString().slice(0, 10) },
      Groups: [['Amazon Elastic Container Service', 9.4], ['Amazon Relational Database Service', 6.1], ['Amazon Simple Storage Service', 1.2], ['AWS Lambda', 0.4], ['Amazon CloudWatch', 0.9]]
        .map(([name, base]) => ({ Keys: [name], Metrics: { UnblendedCost: { Amount: String(base * (1 + Math.sin(k / 3) * 0.2)), Unit: 'USD' } } })),
    });
  }
  return out;
}

export async function ecsClusters() {
  return [
    { clusterName: 'prod', status: 'ACTIVE', activeServicesCount: 6, runningTasksCount: 14, pendingTasksCount: 1 },
    { clusterName: 'staging', status: 'ACTIVE', activeServicesCount: 4, runningTasksCount: 4, pendingTasksCount: 0 },
  ];
}

export async function ecsServices() {
  const s = (serviceName, desiredCount, runningCount, extra = {}) => ({
    serviceName, desiredCount, runningCount, pendingCount: desiredCount - runningCount, status: 'ACTIVE', launchType: 'FARGATE',
    taskDefinition: `arn:aws:ecs:ap-southeast-1:123456789012:task-definition/${serviceName}:42`, createdAt: now / 1000 - 9e6,
    deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED', desiredCount, runningCount, taskDefinition: `task-definition/${serviceName}:42`, updatedAt: now / 1000 - 7200 }],
    events: [{ createdAt: now / 1000 - 600, message: `(service ${serviceName}) has reached a steady state.` }], ...extra,
  });
  return [s('checkout-api', 4, 4), s('image-detector', 3, 1), s('worker', 2, 2, { deployments: [{ status: 'PRIMARY', rolloutState: 'IN_PROGRESS', desiredCount: 2, runningCount: 1, taskDefinition: 'worker:43', updatedAt: now / 1000 - 120 }, { status: 'ACTIVE', desiredCount: 2, runningCount: 2, taskDefinition: 'worker:42', updatedAt: now / 1000 - 9e4 }] }), s('cron', 0, 0)];
}

export async function ecsTasks() {
  return [{ taskArn: 'arn:aws:ecs:x:1:task/prod/0a1b2c3d4e5f60718293', lastStatus: 'RUNNING', healthStatus: 'HEALTHY', cpu: '512', memory: '1024', startedAt: now / 1000 - 5000 },
    { taskArn: 'arn:aws:ecs:x:1:task/prod/9f8e7d6c5b4a39281706', lastStatus: 'STOPPED', stoppedReason: 'Essential container in task exited', stopCode: 'EssentialContainerExited', containers: [{ name: 'app', exitCode: 137 }], stoppedAt: now / 1000 - 900 }];
}
