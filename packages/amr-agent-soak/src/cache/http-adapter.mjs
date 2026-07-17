// Local-RP HTTP adapter for the live-cache safety subsystem.
//
// This adapter is hard-locked to http://localhost:8443 -- there is no
// fallback to 8444 (or any other port), and no remote host is ever
// permitted. That is deliberate: an accidental "helpful" retry against a
// different port or host must never be able to reach a real Azure endpoint.
//
// Every mutating call (create/delete/patch topology) requires a validated
// mutation context (see mutation-context.mjs): customer-subscription
// acknowledgement, kill switch, ownership + denylist, lease-class
// authorization, and a live (non-stale) fencing token are all re-checked
// here, at the transport boundary, so a caller cannot bypass safety simply
// by calling the adapter directly instead of going through an orchestrator.
// createCache uses create-only semantics: it refuses to proceed if the
// target name already exists, so a PUT can never silently overwrite
// something already live. Mutating calls are serialized (one in flight at a
// time per adapter instance) because the local RP itself has no concept of
// our fencing tokens and cannot enforce them server-side. Every request --
// read or write -- is bounded by an AbortController-backed timeout so a
// hung request can never bypass the caller's overall deadline.

import { LOCAL_RP_HOST, LOCAL_RP_PORT } from './config.mjs';
import { redactForLog } from './redact.mjs';
import { assertValidMutationContext } from './mutation-context.mjs';

export class AdapterError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'AdapterError';
    this.status = status;
    this.body = body;
  }
}

// Explicitly enumerated so the "no 8444 fallback" rule is testable and
// self-documenting, in addition to the general "must equal LOCAL_RP_PORT" check.
const FORBIDDEN_FALLBACK_PORTS = new Set([8444]);

/** Default per-request timeout applied via AbortController when the caller
 * does not specify one. Bounds every single fetch, not just polling loops. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

async function withAbortTimeout(timeoutMs, externalSignal, fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', onExternalAbort);
  }
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', onExternalAbort);
  }
}

export class LocalRpHttpAdapter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.host] - must equal LOCAL_RP_HOST or this throws.
   * @param {number} [opts.port] - must equal LOCAL_RP_PORT or this throws.
   * @param {typeof fetch} [opts.fetchImpl] - injectable for tests; defaults to the global fetch.
   * @param {(event: string, detail: object) => void} [opts.logger] - injectable, receives already-redacted detail.
   * @param {number} [opts.defaultTimeoutMs] - default per-request AbortController timeout.
   */
  constructor({
    host = LOCAL_RP_HOST,
    port = LOCAL_RP_PORT,
    fetchImpl = fetch,
    logger = () => {},
    defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {}) {
    if (FORBIDDEN_FALLBACK_PORTS.has(port)) {
      throw new AdapterError(`Port ${port} is an explicitly forbidden fallback port for the local RP adapter.`);
    }
    if (host !== LOCAL_RP_HOST) {
      throw new AdapterError(`Refusing non-local RP host "${host}". Only "${LOCAL_RP_HOST}" is permitted.`);
    }
    if (port !== LOCAL_RP_PORT) {
      throw new AdapterError(
        `Refusing to bind the local RP adapter to port ${port}. This adapter is fixed to ${LOCAL_RP_PORT} with no fallback.`
      );
    }
    this.host = host;
    this.port = port;
    this.baseUrl = `http://${host}:${port}`;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.defaultTimeoutMs = defaultTimeoutMs;
    // Serializes mutating calls: the local RP has no server-side concept of
    // our fencing tokens, so client-side serialization is what prevents two
    // overlapping mutations (e.g. from a stale caller racing a fresh one)
    // from ever being in flight at the same time.
    this.#mutationLock = Promise.resolve();
  }

  #mutationLock;

  async #withMutationLock(fn) {
    const previous = this.#mutationLock;
    let release;
    this.#mutationLock = new Promise((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async #request(method, path, { body, headers = {}, signal, timeoutMs = this.defaultTimeoutMs } = {}) {
    const url = `${this.baseUrl}${path}`;
    this.logger('http-adapter.request', redactForLog({ method, url, headers }));

    return withAbortTimeout(timeoutMs, signal, async (abortSignal) => {
      const res = await this.fetchImpl(url, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: abortSignal,
      });

      const text = await res.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = text;
      }

      if (!res.ok) {
        throw new AdapterError(`Local RP request failed: ${method} ${path} -> ${res.status}`, {
          status: res.status,
          body: parsed,
        });
      }
      return parsed;
    });
  }

  // ---- Read-only operations: bounded by a timeout, but do not require a
  // mutation context and are not serialized against each other. ----

  getCache(name, { signal, timeoutMs } = {}) {
    return this.#request('GET', `/caches/${encodeURIComponent(name)}`, { signal, timeoutMs });
  }

  listCaches({ signal, timeoutMs } = {}) {
    return this.#request('GET', '/caches', { signal, timeoutMs });
  }

  getOperationStatus(operationId, { signal, timeoutMs } = {}) {
    return this.#request('GET', `/operations/${encodeURIComponent(operationId)}`, { signal, timeoutMs });
  }

  getSkuCatalog({ signal, timeoutMs } = {}) {
    return this.#request('GET', '/catalog/skus', { signal, timeoutMs });
  }

  async #existsAlready(name) {
    try {
      await this.getCache(name);
      return true;
    } catch (err) {
      if (err instanceof AdapterError && err.status === 404) return false;
      throw err;
    }
  }

  // ---- Mutating operations: require a validated mutation context (see
  // mutation-context.mjs), and are serialized against one another. ----

  /**
   * Creates a cache. Create-ONLY semantics: refuses (AdapterError) if a
   * cache with this name already exists -- a PUT here can never silently
   * overwrite something already live. When `context.dryRunOnly` is true
   * (the requested SKU is over the live ceiling -- see sku-catalog.mjs),
   * every guard still runs, but no real request is ever issued; a simulated
   * result is returned instead.
   *
   * @param {string} name
   * @param {object} spec
   * @param {object} context - see mutation-context.mjs; must include `dryRunOnly` when applicable.
   */
  async createCache(name, spec, context) {
    assertValidMutationContext(context, name, 'write');
    return this.#withMutationLock(async () => {
      if (context.dryRunOnly) {
        return { name, simulated: true, dryRun: true, spec };
      }
      if (await this.#existsAlready(name)) {
        throw new AdapterError(`Refusing to create "${name}": a cache with this name already exists (create-only semantics).`, {
          status: 409,
        });
      }
      return this.#request('PUT', `/caches/${encodeURIComponent(name)}`, { body: spec });
    });
  }

  /** @param {string} name @param {object} patch @param {object} context */
  async patchCacheTopology(name, patch, context) {
    assertValidMutationContext(context, name, 'topology');
    return this.#withMutationLock(() =>
      this.#request('PATCH', `/caches/${encodeURIComponent(name)}/topology`, { body: patch })
    );
  }

  /** @param {string} name @param {object} context */
  async deleteCache(name, context) {
    assertValidMutationContext(context, name, 'write');
    return this.#withMutationLock(() => this.#request('DELETE', `/caches/${encodeURIComponent(name)}`));
  }
}

