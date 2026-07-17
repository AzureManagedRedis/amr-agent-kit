// In-memory fake of the local RP's HTTP surface, exposed as a fetch-shaped
// function so it can be injected into LocalRpHttpAdapter without any real
// network call or socket. This is what makes the whole test suite run with
// "no Azure calls" and no real network at all.

export function createFakeRp({ initialCaches = [], skuCatalog } = {}) {
  const caches = new Map(initialCaches.map((c) => [c.name, { ...c }]));
  const operations = new Map();
  let opCounter = 0;

  function jsonResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    };
  }

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const path = u.pathname;

    if (path === '/catalog/skus' && method === 'GET') {
      return jsonResponse(200, skuCatalog ?? { skus: [] });
    }

    if (path === '/caches' && method === 'GET') {
      return jsonResponse(200, { caches: [...caches.values()] });
    }

    const cacheMatch = path.match(/^\/caches\/([^/]+)$/);
    if (cacheMatch) {
      const name = decodeURIComponent(cacheMatch[1]);
      if (method === 'GET') {
        if (!caches.has(name)) return jsonResponse(404, { error: 'not found' });
        return jsonResponse(200, caches.get(name));
      }
      if (method === 'PUT') {
        const body = init.body ? JSON.parse(init.body) : {};
        caches.set(name, { name, ...body, provisioningState: 'Succeeded' });
        return jsonResponse(200, caches.get(name));
      }
      if (method === 'DELETE') {
        if (!caches.has(name)) return jsonResponse(404, { error: 'not found' });
        caches.delete(name);
        return jsonResponse(200, { name, deleted: true });
      }
    }

    const topologyMatch = path.match(/^\/caches\/([^/]+)\/topology$/);
    if (topologyMatch && method === 'PATCH') {
      const name = decodeURIComponent(topologyMatch[1]);
      if (!caches.has(name)) return jsonResponse(404, { error: 'not found' });
      const body = init.body ? JSON.parse(init.body) : {};
      caches.set(name, { ...caches.get(name), ...body });
      const opId = `op-${++opCounter}`;
      operations.set(opId, { id: opId, state: 'Running', pollsRemaining: 1 });
      return jsonResponse(200, { operationId: opId, ...caches.get(name) });
    }

    const opMatch = path.match(/^\/operations\/([^/]+)$/);
    if (opMatch && method === 'GET') {
      const id = decodeURIComponent(opMatch[1]);
      const op = operations.get(id);
      if (!op) return jsonResponse(404, { error: 'not found' });
      if (op.pollsRemaining > 0) {
        op.pollsRemaining -= 1;
        return jsonResponse(200, { id, state: 'Running' });
      }
      op.state = 'Succeeded';
      return jsonResponse(200, { id, state: 'Succeeded' });
    }

    return jsonResponse(404, { error: `no fake route for ${method} ${path}` });
  }

  return {
    fetchImpl,
    // Exposed for direct test assertions/manipulation (e.g. simulating a
    // crash by creating a cache "behind the adapter's back").
    _caches: caches,
    _operations: operations,
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
