// GraphQL documents for the W&B API, shared by the browser app and `npm run check`.
// Field names follow the queries in the official wandb SDK (wandb/apis/public and
// tools/graphql_codegen), so they track what the public API actually serves.

export const RUN_LIST_FIELDS = `
fragment RunListFields on Run {
  id name displayName state createdAt heartbeatAt group jobType tags sweepName
  historyLineCount summaryMetrics user { username }
}`;

const SWEEP_FIELDS = `
fragment SweepFields on Sweep {
  id name displayName method state description bestLoss config createdAt updatedAt runCount runCountExpected
}`;

const ARTIFACT_FIELDS = `
fragment ArtifactFields on Artifact {
  id versionIndex state size createdAt updatedAt description fileCount digest metadata
  artifactType { name }
  artifactSequence { name project { name entity { name } } }
  aliases { alias }
}`;

const COLLECTION_FIELDS = `
fragment CollectionFields on ArtifactCollection {
  id name description createdAt updatedAt
  type: defaultArtifactType { name }
}`;

export const Q = {
  viewer: `query Viewer {
  viewer { id name username email entity teams { edges { node { name } } } }
}`,

  projects: `query Projects($entity: String, $cursor: String, $perPage: Int = 100) {
  models(entityName: $entity, after: $cursor, first: $perPage) {
    pageInfo { endCursor hasNextPage }
    edges { node { id name entityName description createdAt updatedAt } }
  }
}`,

  projectOverview: `query ProjectOverview($entity: String!, $project: String!, $fRunning: JSONString, $fFinished: JSONString, $fCrashed: JSONString, $fFailed: JSONString) {
  project(name: $project, entityName: $entity) {
    id name entityName description createdAt updatedAt totalSweeps
    total: runCount
    running: runCount(filters: $fRunning)
    finished: runCount(filters: $fFinished)
    crashed: runCount(filters: $fCrashed)
    failed: runCount(filters: $fFailed)
    runs(first: 8, order: "-created_at") { edges { node { ...RunListFields } } }
  }
}
${RUN_LIST_FIELDS}`,

  runs: `query Runs($entity: String!, $project: String!, $cursor: String, $perPage: Int = 25, $order: String, $filters: JSONString) {
  project(name: $project, entityName: $entity) {
    runCount(filters: $filters)
    runs(filters: $filters, after: $cursor, first: $perPage, order: $order) {
      edges { node { ...RunListFields } }
      pageInfo { endCursor hasNextPage }
    }
  }
}
${RUN_LIST_FIELDS}`,

  run: `query Run($entity: String!, $project: String!, $name: String!) {
  project(name: $project, entityName: $entity) {
    run(name: $name) {
      id name displayName state createdAt heartbeatAt group jobType tags notes description commit sweepName
      historyLineCount config summaryMetrics historyKeys user { username name }
    }
  }
}`,

  sampledHistory: `query RunSampledHistory($entity: String!, $project: String!, $name: String!, $specs: [JSONString!]!) {
  project(name: $project, entityName: $entity) { run(name: $name) { sampledHistory(specs: $specs) } }
}`,

  // The newest console lines, live while a run is going. Same query as the SDK's
  // Run.console_logs(last=N); output.log files lag behind and their bucket URLs are private.
  consoleLog: `query RunConsoleLogTail($entity: String!, $project: String!, $runName: String!, $last: Int!) {
  project(name: $project, entityName: $entity) {
    run(name: $runName) {
      logLineCount
      logLines(last: $last) { edges { node { number timestamp level label line } } }
    }
  }
}`,

  systemEvents: `query RunSystemMetrics($entity: String!, $project: String!, $name: String!, $samples: Int) {
  project(name: $project, entityName: $entity) { run(name: $name) { events(samples: $samples) } }
}`,

  runFiles: `query RunFiles($entity: String!, $project: String!, $name: String!, $cursor: String, $perPage: Int = 50) {
  project(name: $project, entityName: $entity) {
    run(name: $name) {
      fileCount
      files(names: [], after: $cursor, first: $perPage) {
        edges { node { id name sizeBytes mimetype updatedAt } }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
}`,

  runArtifacts: `query RunArtifacts($entity: String!, $project: String!, $run: String!) {
  project(entityName: $entity, name: $project) {
    run(name: $run) {
      outputs: outputArtifacts(first: 50) { totalCount edges { node { ...ArtifactFields } } }
      inputs: inputArtifacts(first: 50) { totalCount edges { node { ...ArtifactFields } } }
    }
  }
}
${ARTIFACT_FIELDS}`,

  sweeps: `query Sweeps($entity: String!, $project: String!, $filters: JSONString!, $cursor: String, $perPage: Int = 50) {
  project(name: $project, entityName: $entity) {
    totalSweeps
    sweeps(after: $cursor, first: $perPage, filters: $filters) {
      pageInfo { endCursor hasNextPage }
      edges { node { ...SweepFields } }
    }
  }
}
${SWEEP_FIELDS}`,

  sweep: `query Sweep($entity: String, $project: String, $name: String!) {
  project(name: $project, entityName: $entity) { sweep(sweepName: $name) { ...SweepFields } }
}
${SWEEP_FIELDS}`,

  artifactTypes: `query ArtifactTypes($entity: String!, $project: String!) {
  project(name: $project, entityName: $entity) {
    artifactTypes(first: 50) { edges { node { id name description createdAt } } }
  }
}`,

  typeCollections: `query TypeCollections($entity: String!, $project: String!, $type: String!, $cursor: String, $perPage: Int = 50) {
  project(entityName: $entity, name: $project) {
    artifactType(name: $type) {
      artifactCollections(after: $cursor, first: $perPage) {
        totalCount
        pageInfo { endCursor hasNextPage }
        edges { node { ...CollectionFields } }
      }
    }
  }
}
${COLLECTION_FIELDS}`,

  projectCollections: `query ProjectCollections($entity: String!, $project: String!, $cursor: String, $perPage: Int = 50) {
  project(entityName: $entity, name: $project) {
    artifactCollections(after: $cursor, first: $perPage) {
      totalCount
      pageInfo { endCursor hasNextPage }
      edges { node { ...CollectionFields } }
    }
  }
}
${COLLECTION_FIELDS}`,

  artifactVersions: `query ArtifactVersions($entity: String!, $project: String!, $type: String!, $collection: String!, $cursor: String, $perPage: Int = 50) {
  project(entityName: $entity, name: $project) {
    artifactType(name: $type) {
      artifactCollection(name: $collection) {
        artifacts(after: $cursor, first: $perPage) {
          totalCount
          pageInfo { endCursor hasNextPage }
          edges { version node { ...ArtifactFields } }
        }
      }
    }
  }
}
${ARTIFACT_FIELDS}`,

  reports: `query Reports($entity: String!, $project: String!, $cursor: String, $perPage: Int! = 50) {
  project(name: $project, entityName: $entity) {
    allViews(viewType: "runs", first: $perPage, after: $cursor) {
      edges { node { id name displayName description updatedAt createdAt user { username } } }
      pageInfo { endCursor hasNextPage }
    }
  }
}`,

  orgInfo: `query OrgInfo($entity: String!) {
  entity(name: $entity) {
    organization { name orgEntity { name } }
    user { organizations { name orgEntity { name } } }
  }
}`,

  registries: `query Registries($organization: String!, $filters: JSONString, $cursor: String, $perPage: Int = 50) {
  organization(name: $organization) {
    orgEntity {
      name
      projects(filters: $filters, after: $cursor, first: $perPage) {
        pageInfo { endCursor hasNextPage }
        edges { node { id name description createdAt updatedAt artifactTypes(includeAll: true) { edges { node { name } } } } }
      }
    }
  }
}`,
};

// Filter values are JSON strings in the W&B API (MongoDB-style operators).
export const F = {
  state: (state) => JSON.stringify({ state }),
  overviewFilters: () => ({
    fRunning: F.state('running'),
    fFinished: F.state('finished'),
    fCrashed: F.state('crashed'),
    fFailed: F.state('failed'),
  }),
  registries: () => JSON.stringify({ name: { $regex: '^wandb-registry-' } }),
};

// The only two write operations the app performs, each behind a confirmation.
export const STOP_RUN = `mutation StopRun($id: ID!) { stopRun(input: { id: $id }) { success } }`;

export const SWEEP_STATE = `mutation UpsertSweepState($id: ID!, $state: String!) {
  upsertSweep(input: { id: $id, state: $state }) { sweep { state } }
}`;

export const SWEEP_TARGET_STATES = ['RUNNING', 'PAUSED', 'FINISHED'];

// Base URLs for W&B multi-tenant cloud, or derived from a Dedicated / self-managed host.
export function wandbUrls(baseUrl) {
  const base = String(baseUrl || 'https://api.wandb.ai').trim().replace(/\/+$/, '');
  const saas = /^https:\/\/api\.wandb\.ai$/i.test(base);
  return {
    baseUrl: base,
    traceUrl: saas ? 'https://trace.wandb.ai' : `${base}/traces`,
    appUrl: saas ? 'https://wandb.ai' : base,
  };
}

// Only fields the trace server accepts as columns (wb_username, for one, is rejected).
// Callers retry without `columns` if the server still answers 422.
const WEAVE_LIST_COLUMNS = [
  'id', 'op_name', 'display_name', 'trace_id', 'parent_id', 'started_at', 'ended_at', 'exception', 'summary',
];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Builds a Weave `calls/stream_query` body from the app's request. Throws on a bad project id. */
export function weaveQueryBody(req) {
  const projectId = String(req.project || '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(projectId)) throw new Error('project must look like entity/project.');
  const filter = {};
  const f = req.filter && typeof req.filter === 'object' ? req.filter : {};
  if (f.trace_roots_only === true) filter.trace_roots_only = true;
  for (const key of ['trace_ids', 'call_ids', 'parent_ids', 'op_names']) {
    if (Array.isArray(f[key])) filter[key] = f[key].filter((v) => typeof v === 'string' && v.length < 300).slice(0, 100);
  }
  const body = {
    project_id: projectId,
    filter,
    limit: clamp(Number(req.limit) || 50, 1, 250),
    offset: Math.max(0, Number(req.offset) || 0),
    sort_by: [{ field: 'started_at', direction: req.ascending ? 'asc' : 'desc' }],
    include_costs: true,
  };
  if (!req.full) body.columns = WEAVE_LIST_COLUMNS;
  return body;
}

export function parseJsonl(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip a partial line.
    }
  }
  return out;
}

export function weaveErrorReason(text) {
  try {
    const j = JSON.parse(text);
    return String(j.reason || j.detail || text);
  } catch {
    return String(text || '');
  }
}

// JSON string literals are valid GraphQL string literals, which keeps names safe to inline.
const lit = (s) => JSON.stringify(String(s));

// One request for the project lists of every entity the viewer belongs to.
export function dashProjectsQuery(entities) {
  const parts = entities.map((e, i) =>
    `e${i}: models(entityName: ${lit(e)}, first: 100) { edges { node { id name entityName createdAt updatedAt } } }`);
  return `query DashProjects {\n${parts.join('\n')}\n}`;
}

// One request for live and recent runs across the most active projects.
export function dashRunsQuery(projects) {
  const parts = projects.map((p, i) => `p${i}: project(name: ${lit(p.name)}, entityName: ${lit(p.entityName)}) {
    name entityName
    live: runs(filters: $running, first: 15, order: "-created_at") { edges { node { ...RunListFields config } } }
    recent: runs(first: 10, order: "-created_at") { edges { node { ...RunListFields } } }
  }`);
  return `query DashRuns($running: JSONString) {\n${parts.join('\n')}\n}\n${RUN_LIST_FIELDS}`;
}

// One request for a sparkline per live run. Pass specs as $s0, $s1, ...
export function sparkQuery(items) {
  const vars = items.map((_, i) => `$s${i}: [JSONString!]!`).join(', ');
  const parts = items.map((it, i) =>
    `r${i}: project(name: ${lit(it.project)}, entityName: ${lit(it.entity)}) { run(name: ${lit(it.run)}) { sampledHistory(specs: $s${i}) } }`);
  return `query DashSpark(${vars}) {\n${parts.join('\n')}\n}`;
}
