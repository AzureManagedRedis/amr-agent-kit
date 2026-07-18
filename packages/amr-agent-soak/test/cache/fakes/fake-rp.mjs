// Contract-faithful, in-memory ARM-shaped fake of the local RP's real
// Microsoft.Cache/redisEnterprise surface -- exposed as a fetch-shaped
// function so it can be injected into LocalRpHttpAdapter without any real
// network call or socket. This replaces the earlier "/caches"-shaped fake:
// paths, the required api-version query parameter, the required Referer
// header, and request/response body shapes all match the real contract.
//
// Provisioning is simulated as asynchronous: a create/delete leaves the
// resource in a non-terminal provisioningState for `pollsUntilSucceeded`/
// `pollsUntilDeleteComplete` subsequent GETs before flipping to terminal
// (Succeeded, or actually removed/404 for deletes). This lets tests exercise
// real polling behavior deterministically without real timers.
//
// `clusterCreateOutcomes`/`databaseCreateOutcomes` let a test force a
// specific resource's create to land on "Failed"/"Canceled" instead of the
// default "Succeeded" (either immediately, or only after `pollsUntilCreate
// Succeeded` polls), so createOwnedCache's terminal-state enforcement can be
// exercised deterministically. `listPageSize`, when set, paginates cluster
// list GETs into chunks via a synthetic `_page` query param + `nextLink`, so
// listClusters' nextLink-following can be exercised deterministically too.
// `staleListGhosts` simulates a real local-RP list index lagging well
// behind a completed DELETE: these entries are ALWAYS included (in a
// "Deleting" state, by default) in every list response, even though they
// do NOT exist in the underlying `clusters` map -- so a direct GET/DELETE
// for one of them correctly 404s, exactly like the real observed bug this
// exists to exercise (confirmCandidateLiveness in reconciliation.mjs /
// janitor.mjs).

const CLUSTER_LIST_RE = /^\/subscriptions\/([^/]+)(?:\/resourceGroups\/([^/]+))?\/providers\/Microsoft\.Cache\/redisEnterprise$/;
const CLUSTER_RE = /^\/subscriptions\/([^/]+)(?:\/resourceGroups\/([^/]+))?\/providers\/Microsoft\.Cache\/redisEnterprise\/([^/]+)$/;
const DATABASE_RE =
  /^\/subscriptions\/([^/]+)(?:\/resourceGroups\/([^/]+))?\/providers\/Microsoft\.Cache\/redisEnterprise\/([^/]+)\/databases\/default$/;
const LIST_KEYS_RE =
  /^\/subscriptions\/([^/]+)(?:\/resourceGroups\/([^/]+))?\/providers\/Microsoft\.Cache\/redisEnterprise\/([^/]+)\/databases\/default\/listKeys$/;
const OPERATION_STATUS_RE = /^\/subscriptions\/([^/]+)\/providers\/Microsoft\.Cache\/locations\/([^/]+)\/operationsStatus\/([^/]+)$/;

export function createFakeRp({
  initialClusters = [],
  pollsUntilCreateSucceeded = 0,
  pollsUntilDeleteComplete = 0,
  clusterCreateOutcomes = {}, // { [clusterName]: 'Failed' | 'Canceled' } -- overrides the normal 'Succeeded' terminal state.
  databaseCreateOutcomes = {}, // { [clusterName]: 'Failed' | 'Canceled' }
  listPageSize, // when set, cluster list GETs are paginated into chunks of this size via a synthetic `_page` query param + nextLink.
  staleListGhosts = [], // [{name[, location, tags, sku, properties]}] -- entries ALWAYS included in list responses (simulating a real local-RP list index lagging well behind a completed DELETE) even though they do NOT exist in the `clusters` map, so a direct GET/DELETE for them correctly 404s.
} = {}) {
  const clusters = new Map(
    initialClusters.map((c) => [
      c.name,
      {
        name: c.name,
        location: c.location ?? 'eastus',
        tags: c.tags ?? {},
        sku: c.sku ?? { name: 'Balanced_B1', capacity: 1 },
        properties: { provisioningState: 'Succeeded', minimumTlsVersion: '1.2', ...(c.properties ?? {}) },
        _createPollsRemaining: 0,
        _deletePollsRemaining: 0,
      },
    ])
  );
  const databases = new Map();
  const operations = new Map();
  const requestLog = [];
  let opCounter = 0;

  function jsonResponse(status, body, headers = {}) {
    const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (key) => lowerHeaders[key.toLowerCase()] ?? null },
      text: async () => JSON.stringify(body),
    };
  }

  function sanitizeCluster(record) {
    const { _createPollsRemaining, _deletePollsRemaining, _createTerminalState, ...rest } = record;
    return JSON.parse(JSON.stringify(rest));
  }

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const headers = init.headers ?? {};
    requestLog.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: { ...headers } });

    // Real ARM contract requirements, enforced here so tests prove the
    // adapter actually sends them.
    const referer = headers.referer ?? headers.Referer;
    if (!referer) return jsonResponse(400, { error: { code: 'MissingReferer', message: 'Referer header is required.' } });
    if (referer !== 'http://localhost:8443') {
      return jsonResponse(400, { error: { code: 'InvalidReferer', message: `Unexpected Referer: ${referer}` } });
    }
    if (!OPERATION_STATUS_RE.test(u.pathname) && !u.searchParams.get('api-version')) {
      return jsonResponse(400, { error: { code: 'MissingApiVersion', message: 'api-version query parameter is required.' } });
    }

    const body = init.body ? JSON.parse(init.body) : undefined;

    // ---- operationsStatus (Azure-AsyncOperation follow-up) ----
    const opMatch = u.pathname.match(OPERATION_STATUS_RE);
    if (opMatch && method === 'GET') {
      const [, , , opId] = opMatch;
      const op = operations.get(opId);
      if (!op) return jsonResponse(404, { error: { code: 'NotFound' } });
      if (op.pollsRemaining > 0) {
        op.pollsRemaining -= 1;
        return jsonResponse(200, { status: 'InProgress' });
      }
      op.onSucceed?.();
      return jsonResponse(200, { status: 'Succeeded' });
    }

    // ---- listKeys ----
    const listKeysMatch = u.pathname.match(LIST_KEYS_RE);
    if (listKeysMatch && method === 'POST') {
      const [, , , clusterName] = listKeysMatch;
      if (!clusters.has(clusterName)) return jsonResponse(404, { error: { code: 'NotFound' } });
      return jsonResponse(200, {
        // Obviously-fake placeholder values -- never real secrets, even in tests.
        primaryKey: 'FAKE-PRIMARY-KEY-0000000000000000000000000000',
        secondaryKey: 'FAKE-SECONDARY-KEY-0000000000000000000000000',
      });
    }

    // ---- database ----
    const dbMatch = u.pathname.match(DATABASE_RE);
    if (dbMatch) {
      const [, , , clusterName] = dbMatch;
      if (method === 'GET') {
        const db = databases.get(clusterName);
        if (!db) return jsonResponse(404, { error: { code: 'NotFound' } });
        if (db._pollsRemaining > 0) {
          db._pollsRemaining -= 1;
          if (db._pollsRemaining === 0) db.properties.provisioningState = db._terminalState ?? 'Succeeded';
        }
        const { _pollsRemaining, _terminalState, ...rest } = db;
        return jsonResponse(200, JSON.parse(JSON.stringify(rest)));
      }
      if (method === 'PUT') {
        if (!clusters.has(clusterName)) return jsonResponse(404, { error: { code: 'NotFound', message: 'Cluster does not exist.' } });
        if (databases.has(clusterName)) {
          return jsonResponse(409, { error: { code: 'DatabaseAlreadyExists' } });
        }
        const terminalState = databaseCreateOutcomes[clusterName] ?? 'Succeeded';
        const record = {
          name: 'default',
          properties: { ...(body?.properties ?? {}), provisioningState: pollsUntilCreateSucceeded > 0 ? 'Creating' : terminalState },
          _pollsRemaining: pollsUntilCreateSucceeded,
          _terminalState: terminalState,
        };
        databases.set(clusterName, record);
        const { _pollsRemaining, _terminalState: _t, ...rest } = record;
        return jsonResponse(pollsUntilCreateSucceeded > 0 ? 202 : 201, JSON.parse(JSON.stringify(rest)));
      }
    }

    // ---- cluster list (paginated via a synthetic _page query param when
    // listPageSize is configured, so tests can exercise nextLink-following
    // deterministically) ----
    const listMatch = u.pathname.match(CLUSTER_LIST_RE);
    if (listMatch && method === 'GET') {
      const ghostItems = staleListGhosts.map((g) => ({
        name: g.name,
        location: g.location ?? 'eastus',
        tags: g.tags ?? {},
        sku: g.sku ?? { name: 'Balanced_B1', capacity: 1 },
        properties: { provisioningState: 'Deleting', ...(g.properties ?? {}) },
      }));
      const allItems = [...clusters.values()].map(sanitizeCluster).concat(ghostItems);
      if (!listPageSize || allItems.length <= listPageSize) {
        return jsonResponse(200, { value: allItems });
      }
      const pageIndex = Number(u.searchParams.get('_page') ?? 0);
      const start = pageIndex * listPageSize;
      const pageItems = allItems.slice(start, start + listPageSize);
      const hasMore = start + listPageSize < allItems.length;
      if (!hasMore) return jsonResponse(200, { value: pageItems });
      const apiVersion = u.searchParams.get('api-version');
      const nextLink = `http://localhost:8443${u.pathname}?api-version=${encodeURIComponent(apiVersion)}&_page=${pageIndex + 1}`;
      return jsonResponse(200, { value: pageItems, nextLink });
    }

    // ---- cluster (single) ----
    const clusterMatch = u.pathname.match(CLUSTER_RE);
    if (clusterMatch) {
      const [, , , name] = clusterMatch;

      if (method === 'GET') {
        const record = clusters.get(name);
        if (!record) return jsonResponse(404, { error: { code: 'NotFound' } });
        if (record._deletePollsRemaining > 0) {
          record._deletePollsRemaining -= 1;
          if (record._deletePollsRemaining === 0) {
            clusters.delete(name);
            databases.delete(name);
            return jsonResponse(404, { error: { code: 'NotFound' } });
          }
          return jsonResponse(200, sanitizeCluster(record));
        }
        if (record._createPollsRemaining > 0) {
          record._createPollsRemaining -= 1;
          if (record._createPollsRemaining === 0) record.properties.provisioningState = record._createTerminalState ?? 'Succeeded';
        }
        return jsonResponse(200, sanitizeCluster(record));
      }

      if (method === 'PUT') {
        if (clusters.has(name)) {
          return jsonResponse(409, { error: { code: 'AlreadyExists', message: 'A cluster with this name already exists.' } });
        }
        const useAsyncHeaders = Boolean(body?._testUseAsyncHeaders);
        const terminalState = clusterCreateOutcomes[name] ?? 'Succeeded';
        const record = {
          name,
          location: body?.location,
          tags: body?.tags ?? {},
          sku: body?.sku,
          properties: { ...(body?.properties ?? {}), provisioningState: pollsUntilCreateSucceeded > 0 ? 'Creating' : terminalState },
          _createPollsRemaining: pollsUntilCreateSucceeded,
          _createTerminalState: terminalState,
          _deletePollsRemaining: 0,
        };
        clusters.set(name, record);

        const responseHeaders = {};
        if (useAsyncHeaders) {
          const opId = `create-op-${++opCounter}`;
          operations.set(opId, {
            pollsRemaining: pollsUntilCreateSucceeded,
            onSucceed: () => {
              record.properties.provisioningState = terminalState;
              record._createPollsRemaining = 0;
            },
          });
          const opUrl = `http://localhost:8443/subscriptions/${encodeURIComponent(clusterMatch[1])}/providers/Microsoft.Cache/locations/${encodeURIComponent(record.location ?? 'eastus')}/operationsStatus/${opId}?api-version=2024-09-01-preview`;
          responseHeaders.location = opUrl;
          responseHeaders['azure-asyncoperation'] = opUrl;
        }

        return jsonResponse(pollsUntilCreateSucceeded > 0 ? 202 : 201, sanitizeCluster(record), responseHeaders);
      }

      if (method === 'DELETE') {
        const record = clusters.get(name);
        if (!record) return jsonResponse(404, { error: { code: 'NotFound' } });
        if (pollsUntilDeleteComplete <= 0) {
          clusters.delete(name);
          databases.delete(name);
          return jsonResponse(200, {});
        }
        record._deletePollsRemaining = pollsUntilDeleteComplete;
        record.properties.provisioningState = 'Deleting';
        return jsonResponse(202, {});
      }
    }

    return jsonResponse(404, { error: { code: 'RouteNotFound', message: `no fake route for ${method} ${u.pathname}` } });
  }

  return {
    fetchImpl,
    _clusters: clusters,
    _databases: databases,
    _requestLog: requestLog,
  };
}

export function fakeSkuCatalog() {
  return {
    skus: [
      { name: 'B0', family: 'Balanced', memoryGb: 0.025 },
      { name: 'B1', family: 'Balanced', memoryGb: 1, capacityGb: 1 },
      { name: 'B3', family: 'Balanced', memoryGb: 3, capacityGb: 3 },
      { name: 'B5', family: 'Balanced', memoryGb: 6, capacityGb: 6 },
      { name: 'B10', family: 'Balanced', memoryGb: 10, capacityGb: 10 },
      { name: 'M10', family: 'MemoryOptimized', memoryGb: 12, capacityGb: 10 },
      { name: 'M20', family: 'MemoryOptimized', memoryGb: 24, capacityGb: 20 },
      { name: 'X5', family: 'ComputeOptimized', memoryGb: 6, capacityGb: 5 },
      { name: 'X50', family: 'ComputeOptimized', memoryGb: 60, capacityGb: 50 },
    ],
  };
}
