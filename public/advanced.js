// Advanced mode views: ECS, EC2, Lambda, DynamoDB, RDS, SNS, Cost Explorer and the user's own
// IAM permissions. All read-only. Shared UI helpers come in as `H` from app.js.

const ts = (sec) => (sec ? sec * 1000 : null); // ECS and DynamoDB use epoch seconds
const last = (s, sep = '/') => String(s || '').split(sep).pop();

function header(H, ctx, title, back = '') {
  H.setHeader({ title, crumb: back ? `${H.regionName(ctx.region)}` : `${H.regionName(ctx.region)} · Advanced`, back });
}

function denied(H, err) {
  return H.errorState(err);
}

function listOrEmpty(H, rows, empty, ic, tone) {
  return rows.length ? `<div class="list">${rows.join('')}</div>` : H.emptyState(empty, '', '', ic, tone);
}

function filterable(H, ctx, { placeholder, items, row, match, empty, ic, tone, chipsDef }) {
  let q = ctx.query.get('q') || '';
  let f = ctx.query.get('f') || 'all';
  ctx.root.insertAdjacentHTML('beforeend', `
    <div class="toolbar">${H.searchBox('xq', placeholder, q)}</div>
    ${chipsDef ? H.chips(chipsDef.list(items), f, 'data-xf') : ''}
    <p class="count" id="xcount"></p><div id="xlist"></div>`);
  const paint = () => {
    const needle = q.trim().toLowerCase();
    const list = items
      .filter((x) => !chipsDef || f === 'all' || chipsDef.test(x, f))
      .filter((x) => !needle || match(x).toLowerCase().includes(needle));
    H.$('#xcount', ctx.root).textContent = `${H.num(list.length)} shown`;
    H.$('#xlist', ctx.root).innerHTML = list.length ? `<div class="list">${list.map(row).join('')}</div>`
      : items.length ? '<p class="note">Nothing matches.</p>' : H.emptyState(empty, '', '', ic, tone);
    ctx.replaceQuery({ q, f: f === 'all' ? '' : f });
  };
  paint();
  H.$('#xq', ctx.root).addEventListener('input', H.debounce((e) => { q = e.target.value; paint(); }, 120));
  if (chipsDef) H.bindChips(ctx.root, 'data-xf', (v) => { f = v; paint(); });
}

function chartsSection(H, ctx, panels, { title = 'Activity', keys, fallback = '3h', minPeriod = 60 } = {}) {
  let range = ctx.query.get('r') || fallback;
  ctx.root.insertAdjacentHTML('beforeend', `${H.sectionHead(title)}${H.rangeChips(range, keys)}
    <div class="chart-grid">${panels.map((p) => H.chartPanel(p.id, p.title)).join('')}</div>`);
  const draw = () => H.drawMetricPanels(ctx, ctx.region, panels, H.rangeMs(range), minPeriod);
  draw();
  H.bindChips(ctx.root, 'data-range', (v) => {
    range = v;
    const qs = Object.fromEntries(ctx.query);
    ctx.replaceQuery({ ...qs, r: v });
    H.$$('.chart-box', ctx.root).forEach((el) => { el.innerHTML = '<span class="skel chart-skel"></span>'; });
    draw();
  });
}

// ---------------------------------------------------------------------------
// ECS

function ecsHealth(s) {
  const rolling = (s.deployments || []).length > 1 || (s.deployments || []).some((d) => d.rolloutState === 'IN_PROGRESS');
  if (s.status && s.status !== 'ACTIVE') return { label: s.status, tone: 'muted', icon: 'clock' };
  if (rolling) return { label: 'Deploying', tone: 'info', icon: 'refresh' };
  if (s.desiredCount === 0) return { label: 'Scaled to zero', tone: 'muted', icon: 'pause' };
  if (s.runningCount < s.desiredCount) return { label: 'Below desired', tone: 'warning', icon: 'alert' };
  return { label: 'Steady', tone: 'good', icon: 'checkCircle' };
}

export async function viewEcs(ctx, H) {
  header(H, ctx, 'ECS');
  ctx.root.innerHTML = H.skelList(4);
  const clusters = await H.memo(`ecs:${ctx.region}`, 30e3, () => H.aws.ecsClusters(ctx.region));
  if (ctx.stale()) return;
  const running = clusters.reduce((s, c) => s + (c.runningTasksCount || 0), 0);
  const pending = clusters.reduce((s, c) => s + (c.pendingTasksCount || 0), 0);
  const services = clusters.reduce((s, c) => s + (c.activeServicesCount || 0), 0);
  ctx.root.innerHTML = `
    <div class="tiles three" style="margin-top:4px">
      ${H.tile({ tone: 'compute', ic: 'container', label: 'Services', n: H.num(services) })}
      ${H.tile({ tone: 'good', ic: 'play', label: 'Running tasks', n: H.num(running) })}
      ${H.tile({ tone: pending ? 'warning' : 'ink-3', ic: 'clock', label: 'Pending', n: H.num(pending) })}
    </div>
    ${H.sectionHead('Clusters')}
    ${listOrEmpty(H, clusters.sort((a, b) => a.clusterName.localeCompare(b.clusterName)).map((c) => `<a class="row" href="#/x/ecs/c/${H.enc(c.clusterName)}">
      ${H.svc('compute', 'container')}
      <span class="row-main"><span class="row-title">${H.esc(c.clusterName)}</span>
        <span class="row-meta"><span>${H.esc(H.plural(c.activeServicesCount || 0, 'service'))}</span><span>${H.esc(H.num(c.runningTasksCount))} running</span>${c.pendingTasksCount ? `<span>${H.esc(H.num(c.pendingTasksCount))} pending</span>` : ''}${c.status !== 'ACTIVE' ? `<span class="tag">${H.esc(c.status)}</span>` : ''}</span></span>
      ${H.icon('chevron', 'ic chev')}</a>`), `No ECS clusters in ${ctx.region}`, 'container', 'compute')}`;
}

export async function viewEcsCluster(ctx, H) {
  const cluster = ctx.params.cluster;
  header(H, ctx, cluster, '#/x/ecs');
  ctx.root.innerHTML = H.skelList(5);
  const services = await H.memo(`ecs:${ctx.region}:${cluster}`, 30e3, () => H.aws.ecsServices(ctx.region, cluster));
  if (ctx.stale()) return;
  ctx.root.innerHTML = '';
  const counts = (k) => services.filter((s) => ecsHealth(s).label === k).length;
  filterable(H, ctx, {
    placeholder: 'Search services',
    items: services.sort((a, b) => a.serviceName.localeCompare(b.serviceName)),
    match: (s) => s.serviceName,
    empty: 'No services in this cluster',
    ic: 'container',
    tone: 'compute',
    chipsDef: {
      list: (items) => [['all', 'All', items.length], ['Below desired', 'Below desired', counts('Below desired')], ['Deploying', 'Deploying', counts('Deploying')], ['Steady', 'Steady', counts('Steady')]],
      test: (s, f) => ecsHealth(s).label === f,
    },
    row: (s) => {
      const h = ecsHealth(s);
      const dep = (s.deployments || [])[0];
      const td = last(s.taskDefinition);
      return `<a class="row" href="#/x/ecs/s/${H.enc(cluster)}/${H.enc(s.serviceName)}">${H.mark(h)}
        <span class="row-main"><span class="row-title">${H.esc(s.serviceName)}</span>
          <span class="row-meta"><span>${H.esc(s.launchType || (s.capacityProviderStrategy?.length ? 'Capacity provider' : ''))}</span><span class="clip">${H.esc(td)}</span>${dep ? `<span>${H.esc(H.ago(ts(dep.updatedAt)))}</span>` : ''}</span></span>
        <span class="row-side"><span class="side-val ${h.tone === 'warning' ? 'hot' : ''}">${H.num(s.runningCount)}/${H.num(s.desiredCount)}</span><span class="side-key">running</span></span></a>`;
    },
  });
}

export async function viewEcsService(ctx, H) {
  const { cluster, service } = ctx.params;
  header(H, ctx, service, `#/x/ecs/c/${H.enc(cluster)}`);
  ctx.root.innerHTML = H.skelList(4);
  const all = await H.memo(`ecs:${ctx.region}:${cluster}`, 30e3, () => H.aws.ecsServices(ctx.region, cluster));
  const s = all.find((x) => x.serviceName === service);
  if (ctx.stale()) return;
  if (!s) {
    ctx.root.innerHTML = H.emptyState('Service not found', '', `<a class="btn" href="#/x/ecs/c/${H.enc(cluster)}">Back to cluster</a>`, 'container');
    return;
  }
  const h = ecsHealth(s);
  ctx.root.innerHTML = `
    <section class="head">
      <div class="head-line">${H.badge(h)}<span class="tag">${H.esc(s.launchType || 'Capacity provider')}</span>${s.schedulingStrategy === 'DAEMON' ? '<span class="tag">Daemon</span>' : ''}</div>
      <h2 class="head-name">${H.esc(s.serviceName)}</h2>
      <p class="head-sub">Cluster ${H.esc(cluster)}</p>
    </section>
    <div class="tiles three">
      ${H.tile({ tone: 'good', ic: 'play', label: 'Running', n: H.num(s.runningCount) })}
      ${H.tile({ tone: 'smile', ic: 'container', label: 'Desired', n: H.num(s.desiredCount) })}
      ${H.tile({ tone: s.pendingCount ? 'warning' : 'ink-3', ic: 'clock', label: 'Pending', n: H.num(s.pendingCount) })}
    </div>
    ${H.facts([
      ['Task definition', `<span class="mono">${H.esc(last(s.taskDefinition))}</span>`],
      s.platformVersion ? ['Platform', H.esc(s.platformVersion)] : null,
      ['Created', H.esc(H.fmtDate(ts(s.createdAt)))],
      s.healthCheckGracePeriodSeconds ? ['Health grace', H.esc(H.formatSeconds(s.healthCheckGracePeriodSeconds))] : null,
      s.deploymentConfiguration?.deploymentCircuitBreaker ? ['Circuit breaker', s.deploymentConfiguration.deploymentCircuitBreaker.enable ? 'On' : 'Off'] : null,
      s.loadBalancers?.length ? ['Load balancers', H.esc(H.num(s.loadBalancers.length))] : null,
    ])}
    ${H.sectionHead('Deployments')}
    <div class="list">${(s.deployments || []).map((d) => `<div class="row">
      ${H.mark(d.status === 'PRIMARY' ? (d.rolloutState === 'FAILED' ? { label: 'Failed', tone: 'critical', icon: 'xCircle' } : d.rolloutState === 'IN_PROGRESS' ? { label: 'Rolling out', tone: 'info', icon: 'refresh' } : { label: 'Primary', tone: 'good', icon: 'checkCircle' }) : { label: d.status, tone: 'muted', icon: 'clock' })}
      <span class="row-main"><span class="row-title">${H.esc(d.status === 'PRIMARY' ? 'Primary' : d.status[0] + d.status.slice(1).toLowerCase())} · ${H.esc(last(d.taskDefinition))}</span>
        <span class="row-meta"><span>${H.num(d.runningCount)}/${H.num(d.desiredCount)} running</span>${d.failedTasks ? `<span>${H.num(d.failedTasks)} failed</span>` : ''}<span>${H.esc(d.rolloutState || '')}</span><span>${H.esc(H.ago(ts(d.updatedAt)))}</span></span>
        ${d.rolloutStateReason ? `<span class="row-meta"><span>${H.esc(d.rolloutStateReason)}</span></span>` : ''}</span></div>`).join('')}</div>`;

  chartsSection(H, ctx, [
    { id: 'c-cpu', title: 'CPU %', series: [{ name: 'CPU', namespace: 'AWS/ECS', metric: 'CPUUtilization', dims: [{ name: 'ClusterName', value: cluster }, { name: 'ServiceName', value: service }], stat: 'Average' }] },
    { id: 'c-mem', title: 'Memory %', series: [{ name: 'Memory', namespace: 'AWS/ECS', metric: 'MemoryUtilization', dims: [{ name: 'ClusterName', value: cluster }, { name: 'ServiceName', value: service }], stat: 'Average', color: 'var(--series-2)' }] },
  ]);

  ctx.root.insertAdjacentHTML('beforeend', `${H.sectionHead('Tasks')}<div id="tasks">${H.skelList(3)}</div>
    ${H.sectionHead('Recent events')}
    <div class="list">${(s.events || []).slice(0, 15).map((e) => `<div class="row"><span class="row-main"><span class="row-title wrap" style="font-weight:500;font-size:14px">${H.esc(e.message)}</span>
      <span class="row-meta"><span>${H.esc(H.fmtDate(ts(e.createdAt)))}</span></span></span></div>`).join('') || '<div class="row"><span class="muted">No events.</span></div>'}</div>`);

  try {
    const tasks = await H.aws.ecsTasks(ctx.region, cluster, service);
    if (ctx.stale()) return;
    tasks.sort((a, b) => (a.lastStatus === 'RUNNING' ? 0 : 1) - (b.lastStatus === 'RUNNING' ? 0 : 1) || (b.startedAt || b.createdAt || 0) - (a.startedAt || a.createdAt || 0));
    H.$('#tasks', ctx.root).innerHTML = tasks.length ? `<div class="list">${tasks.slice(0, 30).map((t) => {
      const tone = t.lastStatus === 'RUNNING' ? (t.healthStatus === 'UNHEALTHY' ? 'warning' : 'good') : t.lastStatus === 'STOPPED' ? (t.stopCode === 'EssentialContainerExited' || /error|fail/i.test(t.stoppedReason || '') ? 'critical' : 'muted') : 'info';
      const st = { label: t.lastStatus, tone, icon: tone === 'good' ? 'checkCircle' : tone === 'critical' ? 'xCircle' : tone === 'warning' ? 'alert' : 'clock' };
      const exits = (t.containers || []).filter((c) => c.exitCode !== undefined && c.exitCode !== 0).map((c) => `${c.name} exit ${c.exitCode}`);
      return `<div class="row">${H.mark(st)}<span class="row-main"><span class="row-title mono">${H.esc(last(t.taskArn).slice(0, 12))}</span>
        <span class="row-meta"><span>${H.esc(t.lastStatus.toLowerCase())}</span>${t.healthStatus && t.healthStatus !== 'UNKNOWN' ? `<span>${H.esc(t.healthStatus.toLowerCase())}</span>` : ''}<span>${H.esc(H.ago(ts(t.stoppedAt || t.startedAt || t.createdAt)))}</span>${t.cpu ? `<span>${H.esc(t.cpu)} CPU · ${H.esc(t.memory)} MB</span>` : ''}</span>
        ${t.stoppedReason ? `<span class="row-meta"><span>${H.esc(t.stoppedReason)}${exits.length ? ` (${H.esc(exits.join(', '))})` : ''}</span></span>` : ''}</span></div>`;
    }).join('')}</div>` : '<p class="note">No running or recently stopped tasks.</p>';
  } catch (err) {
    if (!ctx.stale()) H.$('#tasks', ctx.root).innerHTML = H.inlineError(err);
  }
}

// ---------------------------------------------------------------------------
// EC2

const EC2_STATES = {
  running: { label: 'Running', tone: 'good', icon: 'checkCircle' },
  stopped: { label: 'Stopped', tone: 'muted', icon: 'pause' },
  pending: { label: 'Pending', tone: 'warning', icon: 'clock' },
  stopping: { label: 'Stopping', tone: 'warning', icon: 'clock' },
  'shutting-down': { label: 'Shutting down', tone: 'warning', icon: 'clock' },
  terminated: { label: 'Terminated', tone: 'muted', icon: 'xCircle' },
};
const ec2State = (i) => EC2_STATES[i.state] || { label: i.state, tone: 'muted', icon: 'clock' };

export async function viewEc2(ctx, H) {
  header(H, ctx, 'EC2');
  ctx.root.innerHTML = H.skelList(5);
  const list = await H.memo(`ec2:${ctx.region}`, 30e3, () => H.aws.ec2Instances(ctx.region));
  if (ctx.stale()) return;
  const n = (s) => list.filter((i) => i.state === s).length;
  ctx.root.innerHTML = `<div class="tiles three" style="margin-top:4px">
    ${H.tile({ tone: 'good', ic: 'play', label: 'Running', n: H.num(n('running')) })}
    ${H.tile({ tone: 'ink-3', ic: 'pause', label: 'Stopped', n: H.num(n('stopped')) })}
    ${H.tile({ tone: 'compute', ic: 'server', label: 'Total', n: H.num(list.length) })}</div>`;
  filterable(H, ctx, {
    placeholder: 'Search name, ID, IP or type',
    items: list.sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || (a.name || a.id).localeCompare(b.name || b.id)),
    match: (i) => `${i.name} ${i.id} ${i.privateIp} ${i.publicIp} ${i.type}`,
    empty: `No instances in ${ctx.region}`,
    ic: 'server',
    tone: 'compute',
    chipsDef: {
      list: () => [['all', 'All', list.length], ['running', 'Running', n('running')], ['stopped', 'Stopped', n('stopped')]],
      test: (i, f) => i.state === f,
    },
    row: (i) => `<a class="row" href="#/x/ec2/${H.enc(i.id)}">${H.mark(ec2State(i))}
      <span class="row-main"><span class="row-title">${H.esc(i.name || i.id)}</span>
        <span class="row-meta"><span>${H.esc(i.type)}</span>${i.name ? `<span class="mono">${H.esc(i.id)}</span>` : ''}${i.privateIp ? `<span class="mono">${H.esc(i.privateIp)}</span>` : ''}${i.spot ? '<span class="tag orange">Spot</span>' : ''}</span></span>
      ${H.icon('chevron', 'ic chev')}</a>`,
  });
}

export async function viewEc2Instance(ctx, H) {
  const id = ctx.params.id;
  header(H, ctx, id, '#/x/ec2');
  ctx.root.innerHTML = H.skelList(3);
  const i = (await H.memo(`ec2:${ctx.region}`, 30e3, () => H.aws.ec2Instances(ctx.region))).find((x) => x.id === id);
  if (ctx.stale()) return;
  if (!i) {
    ctx.root.innerHTML = H.emptyState('Instance not found', '', '<a class="btn" href="#/x/ec2">All instances</a>', 'server');
    return;
  }
  H.setHeader({ title: i.name || i.id, crumb: `EC2 · ${ctx.region}`, back: '#/x/ec2' });
  const tags = Object.entries(i.tags).filter(([k]) => k !== 'Name').map(([k, v]) => [k, H.esc(v)]);
  ctx.root.innerHTML = `
    <section class="head">
      <div class="head-line">${H.badge(ec2State(i))}<span class="tag">${H.esc(i.type)}</span>${i.spot ? '<span class="tag orange">Spot</span>' : ''}</div>
      <h2 class="head-name">${H.esc(i.name || i.id)}</h2>
      <p class="head-sub mono">${H.esc(i.id)}</p>
      ${i.stateReason ? `<p class="reason">${H.esc(i.stateReason)}</p>` : ''}
      ${H.facts([
        ['Private IP', `<span class="mono">${H.esc(i.privateIp || '-')}</span>`],
        ['Public IP', `<span class="mono">${H.esc(i.publicIp || '-')}</span>`],
        ['Zone', H.esc(i.az)],
        ['Launched', H.esc(H.ago(i.launched))],
        ['Platform', H.esc(i.platform || '-')],
        ['Architecture', H.esc(i.arch)],
        ['VPC', `<span class="mono">${H.esc(i.vpc || '-')}</span>`],
        ['Key pair', H.esc(i.keyName || '-')],
      ])}
    </section>
    ${H.sectionHead('Details')}
    ${H.kvTable([
      ['AMI', `<span class="mono">${H.esc(i.image)}</span>`],
      ['Subnet', `<span class="mono">${H.esc(i.subnet)}</span>`],
      i.groups.length ? ['Security groups', H.esc(i.groups.join(', '))] : null,
      i.profile ? ['Instance profile', `<span class="mono">${H.esc(last(i.profile))}</span>`] : null,
    ])}
    ${tags.length ? `${H.sectionHead('Tags')}${H.kvTable(tags)}` : ''}`;
  if (i.state !== 'running') return;
  const dims = [{ name: 'InstanceId', value: i.id }];
  chartsSection(H, ctx, [
    { id: 'c-cpu', title: 'CPU %', series: [{ name: 'CPU', namespace: 'AWS/EC2', metric: 'CPUUtilization', dims, stat: 'Average' }] },
    { id: 'c-net', title: 'Network', format: 'bytes', series: [{ name: 'In', namespace: 'AWS/EC2', metric: 'NetworkIn', dims, stat: 'Sum', color: 'var(--series-2)' }, { name: 'Out', namespace: 'AWS/EC2', metric: 'NetworkOut', dims, stat: 'Sum', color: 'var(--series-1)' }] },
    { id: 'c-status', title: 'Status check failures', series: [{ name: 'Failed', namespace: 'AWS/EC2', metric: 'StatusCheckFailed', dims, stat: 'Maximum', color: 'var(--series-8)' }] },
  ], { minPeriod: 300 });
}

// ---------------------------------------------------------------------------
// Lambda

export async function viewLambda(ctx, H) {
  header(H, ctx, 'Lambda');
  ctx.root.innerHTML = H.skelList(5);
  const fns = await H.memo(`lambda:${ctx.region}`, 60e3, () => H.aws.lambdaFunctions(ctx.region));
  if (ctx.stale()) return;
  ctx.root.innerHTML = '';
  const runtimes = [...new Set(fns.map((f) => f.Runtime || f.PackageType))].filter(Boolean).sort();
  filterable(H, ctx, {
    placeholder: 'Search functions',
    items: fns.sort((a, b) => a.FunctionName.localeCompare(b.FunctionName)),
    match: (f) => `${f.FunctionName} ${f.Description || ''} ${f.Runtime || ''}`,
    empty: `No Lambda functions in ${ctx.region}`,
    ic: 'lambda',
    tone: 'compute',
    chipsDef: runtimes.length > 1 ? {
      list: (items) => [['all', 'All', items.length], ...runtimes.map((r) => [r, r, items.filter((f) => (f.Runtime || f.PackageType) === r).length])],
      test: (f, v) => (f.Runtime || f.PackageType) === v,
    } : null,
    row: (f) => `<a class="row" href="#/x/lambda/${H.enc(f.FunctionName)}">${H.svc('compute', 'lambda')}
      <span class="row-main"><span class="row-title">${H.esc(f.FunctionName)}</span>
        <span class="row-meta"><span>${H.esc(f.Runtime || f.PackageType || '')}</span><span>${H.esc(f.MemorySize)} MB</span><span>${H.esc(H.formatSeconds(f.Timeout))}</span><span>${H.esc(H.ago(f.LastModified))}</span></span></span>
      ${H.icon('chevron', 'ic chev')}</a>`,
  });
}

export async function viewLambdaFn(ctx, H) {
  const name = ctx.params.name;
  header(H, ctx, name, '#/x/lambda');
  ctx.root.innerHTML = H.skelList(3);
  const f = await H.aws.lambdaFunction(ctx.region, name);
  if (ctx.stale()) return;
  const env = Object.entries(f.Environment?.Variables || {});
  const logGroup = f.LoggingConfig?.LogGroup || `/aws/lambda/${name}`;
  const stateTone = f.State === 'Active' || !f.State ? 'good' : f.State === 'Failed' ? 'critical' : 'warning';
  ctx.root.innerHTML = `
    <section class="head">
      <div class="head-line">${H.badge({ label: f.State || 'Active', tone: stateTone, icon: stateTone === 'good' ? 'checkCircle' : 'alert' })}<span class="tag">${H.esc(f.Runtime || f.PackageType)}</span>${(f.Architectures || []).map((a) => `<span class="tag">${H.esc(a)}</span>`).join('')}</div>
      <h2 class="head-name">${H.esc(f.FunctionName)}</h2>
      ${f.Description ? `<p class="head-sub">${H.esc(f.Description)}</p>` : ''}
      ${f.StateReason ? `<p class="reason">${H.esc(f.StateReason)}</p>` : ''}
      ${H.facts([
        ['Memory', `${H.esc(f.MemorySize)} MB`],
        ['Timeout', H.esc(H.formatSeconds(f.Timeout))],
        ['Code size', H.esc(H.bytes(f.CodeSize))],
        ['Modified', H.esc(H.ago(f.LastModified))],
        f.Handler ? ['Handler', `<span class="mono">${H.esc(f.Handler)}</span>`] : null,
        ['Ephemeral storage', `${H.esc(f.EphemeralStorage?.Size || 512)} MB`],
        f.VpcConfig?.VpcId ? ['VPC', `<span class="mono">${H.esc(f.VpcConfig.VpcId)}</span>`] : null,
        f.Layers?.length ? ['Layers', H.esc(H.num(f.Layers.length))] : null,
      ])}
      <div class="actions"><a class="btn" href="#/cw/group?g=${H.enc(logGroup)}">${H.icon('logs')}View logs</a></div>
    </section>`;
  const dims = [{ name: 'FunctionName', value: name }];
  const m = (metric, stat, label, color) => ({ name: label, namespace: 'AWS/Lambda', metric, dims, stat, color });
  chartsSection(H, ctx, [
    { id: 'c-inv', title: 'Invocations', series: [m('Invocations', 'Sum', 'Invocations')] },
    { id: 'c-err', title: 'Errors and throttles', series: [m('Errors', 'Sum', 'Errors', 'var(--series-8)'), m('Throttles', 'Sum', 'Throttles', 'var(--series-7)')] },
    { id: 'c-dur', title: 'Duration (ms)', series: [m('Duration', 'Average', 'Average', 'var(--series-2)'), m('Duration', 'Maximum', 'Max', 'var(--series-4)')] },
    { id: 'c-conc', title: 'Concurrent executions', series: [m('ConcurrentExecutions', 'Maximum', 'Concurrency', 'var(--series-5)')] },
  ]);
  if (env.length) {
    ctx.root.insertAdjacentHTML('beforeend', `${H.sectionHead('Environment', '<button type="button" id="env-show">Show values</button>')}
      <div id="env">${H.kvTable(env.map(([k]) => [k, '<span class="muted">••••••</span>']))}</div>`);
    H.$('#env-show', ctx.root).addEventListener('click', (e) => {
      H.$('#env', ctx.root).innerHTML = H.kvTable(env.map(([k, v]) => [k, `<span class="mono">${H.esc(v)}</span>`]));
      e.target.remove();
    });
  }
}

// ---------------------------------------------------------------------------
// DynamoDB

export async function viewDynamo(ctx, H) {
  header(H, ctx, 'DynamoDB');
  ctx.root.innerHTML = H.skelList(5);
  const tables = await H.memo(`ddb:${ctx.region}`, 60e3, async () => {
    const names = await H.aws.ddbTables(ctx.region);
    const res = await H.mapLimit(names, 6, (n) => H.aws.ddbTable(ctx.region, n));
    return names.map((n, i) => (res[i].ok ? res[i].value : { TableName: n, error: res[i].error }));
  });
  if (ctx.stale()) return;
  ctx.root.innerHTML = '';
  filterable(H, ctx, {
    placeholder: 'Search tables',
    items: tables,
    match: (t) => t.TableName,
    empty: `No DynamoDB tables in ${ctx.region}`,
    ic: 'table',
    tone: 'db',
    row: (t) => `<a class="row" href="#/x/dynamodb/${H.enc(t.TableName)}">${H.svc('db', 'table')}
      <span class="row-main"><span class="row-title">${H.esc(t.TableName)}</span>
        <span class="row-meta">${t.error ? '<span>no access to details</span>' : `<span>${H.esc(H.num(t.ItemCount))} items</span><span>${H.esc(H.bytes(t.TableSizeBytes))}</span><span>${t.BillingModeSummary?.BillingMode === 'PAY_PER_REQUEST' ? 'On-demand' : 'Provisioned'}</span>${t.TableStatus !== 'ACTIVE' ? `<span class="tag">${H.esc(t.TableStatus)}</span>` : ''}`}</span></span>
      ${H.icon('chevron', 'ic chev')}</a>`,
  });
}

export async function viewDynamoTable(ctx, H) {
  const name = ctx.params.table;
  header(H, ctx, name, '#/x/dynamodb');
  ctx.root.innerHTML = H.skelList(3);
  const t = await H.aws.ddbTable(ctx.region, name);
  if (ctx.stale()) return;
  const key = (role) => (t.KeySchema || []).find((k) => k.KeyType === role)?.AttributeName;
  const typeOf = (a) => ({ S: 'string', N: 'number', B: 'binary' }[(t.AttributeDefinitions || []).find((d) => d.AttributeName === a)?.AttributeType] || '');
  const onDemand = t.BillingModeSummary?.BillingMode === 'PAY_PER_REQUEST';
  const indexes = [...(t.GlobalSecondaryIndexes || []).map((i) => ({ ...i, kind: 'Global' })), ...(t.LocalSecondaryIndexes || []).map((i) => ({ ...i, kind: 'Local' }))];
  ctx.root.innerHTML = `
    <section class="head">
      <div class="head-line">${H.badge({ label: t.TableStatus, tone: t.TableStatus === 'ACTIVE' ? 'good' : 'warning', icon: t.TableStatus === 'ACTIVE' ? 'checkCircle' : 'clock' })}<span class="tag">${onDemand ? 'On-demand' : 'Provisioned'}</span>${t.DeletionProtectionEnabled ? '<span class="tag">Deletion protected</span>' : ''}</div>
      <h2 class="head-name">${H.esc(t.TableName)}</h2>
      ${H.facts([
        ['Items', H.esc(H.num(t.ItemCount))],
        ['Size', H.esc(H.bytes(t.TableSizeBytes))],
        ['Partition key', `<span class="mono">${H.esc(key('HASH'))}</span> <span class="muted">${H.esc(typeOf(key('HASH')))}</span>`],
        key('RANGE') ? ['Sort key', `<span class="mono">${H.esc(key('RANGE'))}</span> <span class="muted">${H.esc(typeOf(key('RANGE')))}</span>`] : null,
        !onDemand ? ['Read capacity', H.esc(H.num(t.ProvisionedThroughput?.ReadCapacityUnits))] : null,
        !onDemand ? ['Write capacity', H.esc(H.num(t.ProvisionedThroughput?.WriteCapacityUnits))] : null,
        ['Created', H.esc(H.fmtDate(ts(t.CreationDateTime)))],
        ['Table class', H.esc((t.TableClassSummary?.TableClass || 'STANDARD').replace(/_/g, ' ').toLowerCase())],
        t.StreamSpecification?.StreamEnabled ? ['Stream', H.esc(t.StreamSpecification.StreamViewType)] : null,
        t.SSEDescription ? ['Encryption', H.esc(t.SSEDescription.SSEType || 'AWS owned')] : null,
      ])}
    </section>
    ${indexes.length ? `${H.sectionHead('Indexes')}<div class="list">${indexes.map((i) => `<div class="row">${H.svc('db', 'table')}
      <span class="row-main"><span class="row-title">${H.esc(i.IndexName)}</span>
        <span class="row-meta"><span>${H.esc(i.kind)}</span><span class="mono">${H.esc((i.KeySchema || []).map((k) => k.AttributeName).join(' + '))}</span><span>${H.esc(i.Projection?.ProjectionType || '')}</span>${i.IndexStatus && i.IndexStatus !== 'ACTIVE' ? `<span class="tag">${H.esc(i.IndexStatus)}</span>` : ''}</span></span></div>`).join('')}</div>` : ''}`;
  const dims = [{ name: 'TableName', value: name }];
  chartsSection(H, ctx, [
    { id: 'c-read', title: 'Read capacity used', series: [{ name: 'Read', namespace: 'AWS/DynamoDB', metric: 'ConsumedReadCapacityUnits', dims, stat: 'Sum' }] },
    { id: 'c-write', title: 'Write capacity used', series: [{ name: 'Write', namespace: 'AWS/DynamoDB', metric: 'ConsumedWriteCapacityUnits', dims, stat: 'Sum', color: 'var(--series-2)' }] },
  ], { minPeriod: 60 });
}

// ---------------------------------------------------------------------------
// RDS

const rdsTone = (status) => (status === 'available' ? { label: 'Available', tone: 'good', icon: 'checkCircle' }
  : status === 'stopped' ? { label: 'Stopped', tone: 'muted', icon: 'pause' }
    : /fail|incompatible|inaccessible/.test(status) ? { label: status, tone: 'critical', icon: 'xCircle' }
      : { label: status, tone: 'warning', icon: 'clock' });

export async function viewRds(ctx, H) {
  header(H, ctx, 'RDS');
  ctx.root.innerHTML = H.skelList(4);
  const [inst, clus] = await Promise.allSettled([
    H.memo(`rds:${ctx.region}`, 30e3, () => H.aws.rdsInstances(ctx.region)),
    H.memo(`rdsc:${ctx.region}`, 30e3, () => H.aws.rdsClusters(ctx.region)),
  ]);
  if (ctx.stale()) return;
  if (inst.status === 'rejected') throw inst.reason;
  const instances = inst.value;
  const clusters = clus.status === 'fulfilled' ? clus.value : [];
  ctx.root.innerHTML = `
    ${clusters.length ? `${H.sectionHead('Clusters')}<div class="list">${clusters.map((c) => `<a class="row" href="#/x/rds/c/${H.enc(c.id)}">${H.mark(rdsTone(c.status))}
      <span class="row-main"><span class="row-title">${H.esc(c.id)}</span>
        <span class="row-meta"><span>${H.esc(c.engine)} ${H.esc(c.version)}</span><span>${H.esc(H.plural(c.members.length, 'instance'))}</span>${c.mode && c.mode !== 'provisioned' ? `<span class="tag">${H.esc(c.mode)}</span>` : ''}</span></span>
      ${H.icon('chevron', 'ic chev')}</a>`).join('')}</div>` : ''}
    ${H.sectionHead('Instances')}
    ${listOrEmpty(H, instances.map((i) => `<a class="row" href="#/x/rds/${H.enc(i.id)}">${H.mark(rdsTone(i.status))}
      <span class="row-main"><span class="row-title">${H.esc(i.id)}</span>
        <span class="row-meta"><span>${H.esc(i.engine)} ${H.esc(i.version)}</span><span>${H.esc(i.class)}</span>${i.multiAz ? '<span class="tag">Multi-AZ</span>' : ''}${i.cluster ? `<span class="clip">in ${H.esc(i.cluster)}</span>` : ''}</span></span>
      ${H.icon('chevron', 'ic chev')}</a>`), `No RDS instances in ${ctx.region}`, 'database', 'db')}`;
}

export async function viewRdsInstance(ctx, H) {
  const id = ctx.params.id;
  header(H, ctx, id, '#/x/rds');
  ctx.root.innerHTML = H.skelList(3);
  const i = (await H.memo(`rds:${ctx.region}`, 30e3, () => H.aws.rdsInstances(ctx.region))).find((x) => x.id === id);
  if (ctx.stale()) return;
  if (!i) {
    ctx.root.innerHTML = H.emptyState('Instance not found', '', '<a class="btn" href="#/x/rds">All databases</a>', 'database');
    return;
  }
  ctx.root.innerHTML = `
    <section class="head">
      <div class="head-line">${H.badge(rdsTone(i.status))}<span class="tag">${H.esc(i.engine)} ${H.esc(i.version)}</span>${i.multiAz ? '<span class="tag">Multi-AZ</span>' : ''}</div>
      <h2 class="head-name">${H.esc(i.id)}</h2>
      ${i.endpoint ? `<p class="head-sub mono">${H.esc(i.endpoint)}:${H.esc(i.port)}</p>` : ''}
      ${H.facts([
        ['Class', H.esc(i.class)],
        ['Storage', `${H.esc(i.storage)} GB ${H.esc(i.storageType)}`],
        ['Zone', H.esc(i.az || '-')],
        ['Created', H.esc(H.fmtDate(i.created))],
        ['Encrypted', i.encrypted ? 'Yes' : 'No'],
        ['Public', i.publiclyAccessible ? 'Yes' : 'No'],
        ['Backups kept', i.backupRetention ? `${i.backupRetention} days` : 'Off'],
        i.cluster ? ['Cluster', `<a href="#/x/rds/c/${H.enc(i.cluster)}">${H.esc(i.cluster)}</a>`] : null,
      ])}
      ${i.endpoint ? `<div class="actions"><button class="btn" type="button" id="copy-ep">${H.icon('copy')}Copy endpoint</button></div>` : ''}
    </section>`;
  H.$('#copy-ep', ctx.root)?.addEventListener('click', () => H.copyWithToast(`${i.endpoint}:${i.port}`, 'Endpoint copied'));
  const dims = [{ name: 'DBInstanceIdentifier', value: id }];
  const m = (metric, stat, label, color) => ({ name: label, namespace: 'AWS/RDS', metric, dims, stat, color });
  chartsSection(H, ctx, [
    { id: 'c-cpu', title: 'CPU %', series: [m('CPUUtilization', 'Average', 'CPU')] },
    { id: 'c-conn', title: 'Connections', series: [m('DatabaseConnections', 'Maximum', 'Connections', 'var(--series-2)')] },
    { id: 'c-mem', title: 'Freeable memory', format: 'bytes', series: [m('FreeableMemory', 'Minimum', 'Free memory', 'var(--series-3)')] },
    ...(i.cluster ? [] : [{ id: 'c-disk', title: 'Free storage', format: 'bytes', series: [m('FreeStorageSpace', 'Minimum', 'Free storage', 'var(--series-5)')] }]),
  ]);
}

export async function viewRdsCluster(ctx, H) {
  const id = ctx.params.id;
  header(H, ctx, id, '#/x/rds');
  ctx.root.innerHTML = H.skelList(3);
  const c = (await H.memo(`rdsc:${ctx.region}`, 30e3, () => H.aws.rdsClusters(ctx.region))).find((x) => x.id === id);
  if (ctx.stale()) return;
  if (!c) {
    ctx.root.innerHTML = H.emptyState('Cluster not found', '', '<a class="btn" href="#/x/rds">All databases</a>', 'database');
    return;
  }
  ctx.root.innerHTML = `
    <section class="head">
      <div class="head-line">${H.badge(rdsTone(c.status))}<span class="tag">${H.esc(c.engine)} ${H.esc(c.version)}</span></div>
      <h2 class="head-name">${H.esc(c.id)}</h2>
      ${H.kvTable([
        c.endpoint ? ['Writer endpoint', `<span class="mono">${H.esc(c.endpoint)}</span>`] : null,
        c.reader ? ['Reader endpoint', `<span class="mono">${H.esc(c.reader)}</span>`] : null,
        ['Port', H.esc(c.port)],
        ['Created', H.esc(H.fmtDate(c.created))],
        ['Encrypted', c.encrypted ? 'Yes' : 'No'],
      ])}
    </section>
    ${H.sectionHead('Members')}
    <div class="list">${c.members.map((m) => `<a class="row" href="#/x/rds/${H.enc(m.id)}">${H.svc('db', 'database')}
      <span class="row-main"><span class="row-title">${H.esc(m.id)}</span><span class="row-meta"><span>${m.writer ? 'Writer' : 'Reader'}</span></span></span>${H.icon('chevron', 'ic chev')}</a>`).join('') || '<div class="row muted">No instances.</div>'}</div>`;
  const dims = [{ name: 'DBClusterIdentifier', value: id }];
  chartsSection(H, ctx, [
    { id: 'c-cpu', title: 'CPU %', series: [{ name: 'CPU', namespace: 'AWS/RDS', metric: 'CPUUtilization', dims, stat: 'Average' }] },
    { id: 'c-conn', title: 'Connections', series: [{ name: 'Connections', namespace: 'AWS/RDS', metric: 'DatabaseConnections', dims, stat: 'Maximum', color: 'var(--series-2)' }] },
  ]);
}

// ---------------------------------------------------------------------------
// SNS

export async function viewSns(ctx, H) {
  header(H, ctx, 'SNS');
  ctx.root.innerHTML = H.skelList(5);
  const arns = await H.memo(`sns:${ctx.region}`, 60e3, () => H.aws.snsTopics(ctx.region));
  if (ctx.stale()) return;
  ctx.root.innerHTML = '';
  filterable(H, ctx, {
    placeholder: 'Search topics',
    items: arns.sort((a, b) => last(a, ':').localeCompare(last(b, ':'))),
    match: (a) => last(a, ':'),
    empty: `No SNS topics in ${ctx.region}`,
    ic: 'megaphone',
    tone: 'sqs',
    row: (a) => `<a class="row" href="#/x/sns/${H.enc(last(a, ':'))}">${H.svc('sqs', 'megaphone')}
      <span class="row-main"><span class="row-title">${H.esc(last(a, ':'))}</span>${last(a, ':').endsWith('.fifo') ? '<span class="row-meta"><span class="tag">FIFO</span></span>' : ''}</span>
      ${H.icon('chevron', 'ic chev')}</a>`,
  });
}

export async function viewSnsTopic(ctx, H) {
  const name = ctx.params.topic;
  header(H, ctx, name, '#/x/sns');
  ctx.root.innerHTML = H.skelList(3);
  const ident = await H.ensureIdentity();
  const arn = `arn:aws:sns:${ctx.region}:${ident.account}:${name}`;
  const { attrs, subs } = await H.aws.snsTopic(ctx.region, arn);
  if (ctx.stale()) return;
  ctx.root.innerHTML = `
    <section class="head">
      <div class="head-line">${H.svc('sqs', 'megaphone')}${attrs.FifoTopic === 'true' ? '<span class="tag pink">FIFO</span>' : '<span class="tag pink">Standard</span>'}${attrs.KmsMasterKeyId ? '<span class="tag">KMS encrypted</span>' : ''}</div>
      <h2 class="head-name">${H.esc(attrs.DisplayName || name)}</h2>
      <p class="head-sub mono">${H.esc(arn)}</p>
      ${H.facts([
        ['Confirmed', H.esc(H.num(attrs.SubscriptionsConfirmed))],
        ['Pending', H.esc(H.num(attrs.SubscriptionsPending))],
        ['Deleted', H.esc(H.num(attrs.SubscriptionsDeleted))],
      ])}
    </section>
    ${H.sectionHead('Subscriptions')}
    ${subs.error ? H.inlineError(subs.error) : listOrEmpty(H, subs.map((s) => `<div class="row">${H.svc(s.arn === 'PendingConfirmation' ? 'warning' : 'sqs', s.protocol === 'sqs' ? 'queue' : s.protocol === 'lambda' ? 'lambda' : 'megaphone')}
      <span class="row-main"><span class="row-title">${H.esc(s.protocol === 'sqs' || s.protocol === 'lambda' ? last(s.endpoint, ':') : s.endpoint)}</span>
        <span class="row-meta"><span class="tag">${H.esc(s.protocol)}</span>${s.arn === 'PendingConfirmation' ? '<span>pending confirmation</span>' : ''}</span></span></div>`), 'No subscriptions', 'megaphone')}`;
  const dims = [{ name: 'TopicName', value: name }];
  chartsSection(H, ctx, [
    { id: 'c-pub', title: 'Messages published', series: [{ name: 'Published', namespace: 'AWS/SNS', metric: 'NumberOfMessagesPublished', dims, stat: 'Sum' }] },
    { id: 'c-del', title: 'Deliveries', series: [
      { name: 'Delivered', namespace: 'AWS/SNS', metric: 'NumberOfNotificationsDelivered', dims, stat: 'Sum', color: 'var(--series-3)' },
      { name: 'Failed', namespace: 'AWS/SNS', metric: 'NumberOfNotificationsFailed', dims, stat: 'Sum', color: 'var(--series-8)' },
    ] },
  ], { minPeriod: 300 });
}

// ---------------------------------------------------------------------------
// Cost Explorer

const COST_TTL = 6 * 3600e3;

export async function viewCost(ctx, H) {
  H.setHeader({ title: 'Cost', crumb: 'Cost Explorer · all regions' });
  const cached = H.store.get('cost', null);
  const fmtMoney = (n, unit = 'USD') => new Intl.NumberFormat(undefined, { style: 'currency', currency: unit, maximumFractionDigits: n < 10 ? 2 : 0 }).format(n);

  const paint = (data, at) => {
    const thisMonth = new Date().toISOString().slice(0, 7);
    const byDay = data.map((r) => {
      const sum = (r.Groups || []).reduce((s, g) => s + Number(g.Metrics?.UnblendedCost?.Amount || 0), 0) + Number(r.Total?.UnblendedCost?.Amount || 0);
      return { day: r.TimePeriod.Start, sum, estimated: r.Estimated, groups: r.Groups || [] };
    });
    const unit = data.flatMap((r) => r.Groups || []).find((g) => g.Metrics?.UnblendedCost?.Unit)?.Metrics.UnblendedCost.Unit || 'USD';
    const cur = byDay.filter((d) => d.day.startsWith(thisMonth));
    const prev = byDay.filter((d) => !d.day.startsWith(thisMonth));
    const total = cur.reduce((s, d) => s + d.sum, 0);
    const prevTotal = prev.reduce((s, d) => s + d.sum, 0);
    const daysIn = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const elapsed = Math.max(1, cur.length - 1 + new Date().getHours() / 24);
    const pace = (total / elapsed) * daysIn;
    const services = new Map();
    for (const d of cur) for (const g of d.groups) services.set(g.Keys[0], (services.get(g.Keys[0]) || 0) + Number(g.Metrics?.UnblendedCost?.Amount || 0));
    const ranked = [...services.entries()].filter(([, v]) => v >= 0.005).sort((a, b) => b[1] - a[1]);
    const max = ranked[0]?.[1] || 1;
    ctx.root.innerHTML = `
      <section class="hero">
        <h2><em>${H.esc(fmtMoney(total, unit))}</em> so far this month.</h2>
        <p>On pace for about ${H.esc(fmtMoney(pace, unit))}. Last month was ${H.esc(fmtMoney(prevTotal, unit))}.</p>
        <p class="stamp">Updated ${H.esc(H.ago(at))}</p>
      </section>
      <div class="actions"><button class="btn sm" type="button" id="cost-refresh">${H.icon('refresh')}Refresh ($0.01)</button></div>
      ${H.sectionHead('Daily spend')}
      <div class="panel"><div class="chart-box" id="c-cost"></div></div>
      ${H.sectionHead('By service this month')}
      <div class="list">${ranked.map(([name, v]) => `<div class="row"><span class="row-main"><span class="row-title">${H.esc(name)}</span>
        <span class="bar"><span style="width:${(v / max * 100).toFixed(1)}%"></span></span></span>
        <span class="row-side"><span class="side-val">${H.esc(fmtMoney(v, unit))}</span><span class="side-key">${total ? `${Math.round(v / total * 100)}%` : ''}</span></span></div>`).join('') || '<div class="row muted">No spend recorded yet this month.</div>'}</div>`;
    const chart = H.lineChart(H.$('#c-cost', ctx.root), {
      series: [{ name: 'Spend', points: byDay.map((d) => [Date.parse(`${d.day}T12:00:00Z`), d.sum]) }],
      time: true,
      height: 190,
      valueFormat: (v) => fmtMoney(v, unit),
      yFormat: (v) => fmtMoney(v, unit),
    });
    ctx.cleanup(() => chart.destroy());
    H.$('#cost-refresh', ctx.root).addEventListener('click', load);
  };

  const load = async () => {
    ctx.root.innerHTML = H.skelList(4);
    try {
      const data = await H.aws.costAndUsage();
      H.store.set('cost', { at: Date.now(), data });
      if (!ctx.stale()) paint(data, Date.now());
    } catch (err) {
      if (!ctx.stale()) ctx.root.innerHTML = H.errorState(err);
      H.$('[data-retry]', ctx.root)?.addEventListener('click', load);
    }
  };

  if (cached && Date.now() - cached.at < COST_TTL * 4) {
    paint(cached.data, cached.at);
    return;
  }
  ctx.root.innerHTML = H.emptyState('Cost Explorer', '',
    '<button class="btn primary" type="button" id="cost-load">Load costs ($0.01)</button>', 'dollar', 'cost');
  H.$('#cost-load', ctx.root).addEventListener('click', load);
}

// ---------------------------------------------------------------------------
// My permissions

const STATUS = {
  allowed: { label: 'Allowed', tone: 'good', icon: 'checkCircle' },
  denied: { label: 'Not allowed', tone: 'critical', icon: 'lock' },
  error: { label: 'Could not check', tone: 'warning', icon: 'alert' },
  unchecked: { label: 'Not checked', tone: 'muted', icon: 'clock' },
};
export const accessStatus = (s) => STATUS[s] || STATUS.unchecked;

export async function viewIam(ctx, H) {
  H.setHeader({ title: 'My permissions', crumb: 'IAM' });
  ctx.root.innerHTML = H.skelList(4);
  const ident = await H.ensureIdentity();
  const principal = H.aws.principalOf(ident.arn);
  ctx.root.innerHTML = `
    <section class="head">
      <div class="head-line">${H.svc('sec', 'user')}<span class="tag">${H.esc({ user: 'IAM user', role: 'Assumed role', root: 'Root user', other: 'Principal' }[principal.kind])}</span></div>
      <h2 class="head-name">${H.esc(principal.name)}</h2>
      <p class="head-sub mono">${H.esc(ident.arn)}</p>
    </section>
    ${H.sectionHead(`Access check · ${ctx.region}`, '<button type="button" id="recheck">Check again</button>')}
    <div id="access">${H.skelList(6)}</div>
    ${H.sectionHead('Policies')}<div id="policies">${H.skelList(3)}</div>`;

  const paintAccess = (res) => {
    H.$('#access', ctx.root).innerHTML = `<div class="list">${H.aws.SERVICES.map((s) => {
      const st = accessStatus(res[s.key]);
      return `<div class="row">${H.mark(st)}<span class="row-main"><span class="row-title">${H.esc(s.label)}</span>
        <span class="row-meta"><span class="mono">${H.esc(s.action)}</span></span></span>
        <span class="row-side"><span class="side-key">${H.esc(st.label)}</span></span></div>`;
    }).join('')}</div>`;
  };
  const runCheck = async (fresh) => {
    if (fresh) H.forget(`access:${ctx.region}`);
    H.$('#access', ctx.root).innerHTML = H.skelList(6);
    const res = await H.loadAccess(ctx.region);
    if (!ctx.stale()) paintAccess(res);
  };
  H.$('#recheck', ctx.root).addEventListener('click', () => runCheck(true));
  runCheck(false);

  if (principal.kind === 'root') {
    H.$('#policies', ctx.root).innerHTML = '<p class="note warn">Root user keys have full access to the account.</p>';
    return;
  }
  const p = await H.aws.iamPolicies(principal);
  if (ctx.stale()) return;
  const policyRow = (title, meta, attrs) => `<details class="row-details" ${attrs}><summary class="row">${H.svc('sec', 'key')}
      <span class="row-main"><span class="row-title">${H.esc(title)}</span><span class="row-meta"><span>${H.esc(meta)}</span></span></span>${H.icon('chevron', 'ic chev')}</summary>
      <div class="details-body" data-doc><span class="skel block"></span></div></details>`;
  const own = principal.kind === 'role' ? 'role' : 'user';
  const allDenied = [p.attached, p.inline, p.groups].every((r) => !r.ok && r.error.denied);
  if (allDenied) {
    H.$('#policies', ctx.root).innerHTML = `<div class="list"><div class="row">${H.svc('muted', 'lock')}<span class="row-main"><span class="row-title wrap">No permission to read IAM policies</span></span></div></div>`;
    return;
  }
  const sections = [];
  const denyNote = (r, what) => (r.ok ? '' : `<p class="note">${H.esc(r.error.denied ? `Your ${own} cannot list its ${what}.` : r.error.message)}</p>`);
  const attached = p.attached.ok ? p.attached.value : [];
  const inline = p.inline.ok ? p.inline.value : [];
  sections.push(`<p class="count">Attached to this ${own}</p>`);
  const rows = [
    ...attached.map((a) => policyRow(a.name, a.arn.includes(':aws:policy/') ? 'AWS managed' : 'Customer managed', `data-managed="${H.esc(a.arn)}"`)),
    ...inline.map((n) => policyRow(n, 'Inline', `data-inline="${own}" data-owner="${H.esc(principal.name)}" data-name="${H.esc(n)}"`)),
  ];
  sections.push(rows.length ? `<div class="list">${rows.join('')}</div>` : (p.attached.ok && p.inline.ok ? '<p class="note">No policies attached directly.</p>' : ''));
  sections.push(denyNote(p.attached, 'attached policies'), denyNote(p.inline, 'inline policies'));
  if (p.groups.ok) {
    for (const g of p.groups.value) {
      const ga = g.attached.ok ? g.attached.value : [];
      const gi = g.inline.ok ? g.inline.value : [];
      sections.push(`<p class="count" style="margin-top:16px">From group ${H.esc(g.name)}</p>`);
      const gr = [
        ...ga.map((a) => policyRow(a.name, a.arn.includes(':aws:policy/') ? 'AWS managed' : 'Customer managed', `data-managed="${H.esc(a.arn)}"`)),
        ...gi.map((n) => policyRow(n, 'Inline', `data-inline="group" data-owner="${H.esc(g.name)}" data-name="${H.esc(n)}"`)),
      ];
      sections.push(gr.length ? `<div class="list">${gr.join('')}</div>` : '<p class="note">No policies.</p>');
    }
  } else {
    sections.push(denyNote(p.groups, 'groups'));
  }
  H.$('#policies', ctx.root).innerHTML = sections.join('');

  H.$$('details[data-managed], details[data-inline]', ctx.root).forEach((d) => d.addEventListener('toggle', async () => {
    if (!d.open || d.dataset.loaded) return;
    d.dataset.loaded = '1';
    const body = H.$('[data-doc]', d);
    try {
      const r = d.dataset.managed
        ? await H.aws.iamManagedDoc(d.dataset.managed)
        : await H.aws.iamInlineDoc(d.dataset.inline, d.dataset.owner, d.dataset.name);
      const text = typeof r.document === 'string' ? r.document : JSON.stringify(r.document, null, 2);
      body.innerHTML = `${r.version ? `<p class="note">Default version ${H.esc(r.version)}</p>` : ''}<pre class="code">${H.esc(text)}</pre>
        <button class="btn sm" type="button" data-copy>${H.icon('copy')}Copy JSON</button>`;
      H.$('[data-copy]', body).addEventListener('click', () => H.copyWithToast(text, 'Policy copied'));
    } catch (err) {
      body.innerHTML = H.inlineError(err);
    }
  }));
}
