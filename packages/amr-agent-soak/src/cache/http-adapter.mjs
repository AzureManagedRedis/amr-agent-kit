// Local-RP HTTP adapter for the live-cache safety subsystem.
//
// Speaks the REAL Microsoft.Cache/redisEnterprise ARM contract against the
// local RP simulator -- there is no fake "/caches", "/catalog/skus", or
// "/operations/*" shape here. Paths, the required api-version query
// parameter, and the required Referer header all match what a real ARM
// resource provider expects, so this adapter (and everything built on it)
// is contract-faithful and can point at a real local RP without code
// changes.
//
// This adapter is hard-locked to http://localhost:8443 -- there is no
// fallback to 8444 (or any other port), and no remote host is ever
// permitted. That is deliberate: an accidental "helpful" retry against a
// different port or host must never be able to reach a real Azure endpoint.
// Even Location/Azure-AsyncOperation follow-up URLs are validated to still
// be same-origin before being polled.
//
// Every mutating call (create/delete) requires a validated mutation
// context (see mutation-context.mjs): customer-subscription acknowledgement,
// kill switch, ownership + denylist, lease-class authorization, and a live
// (non-stale) fencing token are all re-checked here, at the transport
// boundary, so a caller cannot bypass safety simply by calling the adapter
// directly instead of going through an orchestrator. createCluster/
// createDatabase use create-only semantics: they refuse to proceed if the
// target already exists (checked via a real GET), so a PUT can never
// silently overwrite something already live -- owned or not. Mutating
// calls are serialized (one in flight at a time per adapter instance)
// because the RP itself has no concept of our fencing tokens and cannot
// enforce them server-side. Every request -- read or write -- is bounded
// by an AbortController-backed timeout so a hung request can never bypass
// the caller's overall deadline.
//
// There is deliberately no SKU-catalog method here: SKU data comes from an
// injected catalog provider (see catalog-provider.mjs), never from a fake
// RP endpoint.
//
// listClusters follows ARM nextLink-style pagination so owned resources are
// never missed among other subscription/resource-group caches spread
// across multiple pages -- every followed nextLink is origin-locked
// (refused if it points outside this adapter's base origin, exactly like
// Location/Azure-AsyncOperation follow-ups) and bounded by a max-page
// guard so an accidental or malicious nextLink cycle can never loop
// forever.

import { LOCAL_RP_HOST, LOCAL_RP_PORT, DEFAULT_API_VERSION } from './config.mjs';
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

/** Default cap on how many nextLink pages listClusters will follow before
 * refusing to continue. Guards against an accidental or malicious nextLink
 * cycle spinning the pagination loop forever. */
export const DEFAULT_MAX_LIST_PAGES = 50;

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

function buildClusterPath({ subscriptionId, resourceGroup, name }) {
  if (!subscriptionId) throw new AdapterError('subscriptionId is required.');
  const rgSegment = resourceGroup ? `/resourceGroups/${encodeURIComponent(resourceGroup)}` : '';
  const base = `/subscriptions/${encodeURIComponent(subscriptionId)}${rgSegment}/providers/Microsoft.Cache/redisEnterprise`;
  return name ? `${base}/${encodeURIComponent(name)}` : base;
}

function buildDatabasePath(coords) {
  return `${buildClusterPath({ ...coords, name: coords.clusterName })}/databases/default`;
}

export class LocalRpHttpAdapter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.host] - must equal LOCAL_RP_HOST or this throws.
   * @param {number} [opts.port] - must equal LOCAL_RP_PORT or this throws.
   * @param {typeof fetch} [opts.fetchImpl] - injectable for tests; defaults to the global fetch.
   * @param {(event: string, detail: object) => void} [opts.logger] - injectable, receives already-redacted detail. Response bodies are never logged (listKeys secrets must never reach logs/artifacts).
   * @param {number} [opts.defaultTimeoutMs] - default per-request AbortController timeout.
   * @param {string} [opts.apiVersion] - ARM api-version query parameter; defaults to DEFAULT_API_VERSION.
   */
  constructor({
    host = LOCAL_RP_HOST,
    port = LOCAL_RP_PORT,
    fetchImpl = fetch,
    logger = () => {},
    defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    apiVersion = DEFAULT_API_VERSION,
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
    this.apiVersion = apiVersion;
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

  /**
   * Low-level request. `pathOrUrl` may be a relative ARM path (api-version is
   * appended automatically) or an absolute URL already under this adapter's
   * base origin (used for Location/Azure-AsyncOperation follow-ups; any
   * other origin is refused). Returns `{ status, headers, body }` -- callers
   * that only need the parsed body (reads) unwrap `.body`.
   */
  async #request(method, pathOrUrl, { body, headers = {}, signal, timeoutMs = this.defaultTimeoutMs, appendApiVersion = true } = {}) {
    let url;
    if (/^https?:\/\//i.test(pathOrUrl)) {
      const parsed = new URL(pathOrUrl);
      if (parsed.origin !== new URL(this.baseUrl).origin) {
        throw new AdapterError(`Refusing to request a URL outside ${this.baseUrl}: ${pathOrUrl}`);
      }
      url = pathOrUrl;
    } else {
      url = `${this.baseUrl}${pathOrUrl}`;
    }
    if (appendApiVersion) {
      url += url.includes('?') ? `&api-version=${encodeURIComponent(this.apiVersion)}` : `?api-version=${encodeURIComponent(this.apiVersion)}`;
    }

    this.logger('http-adapter.request', redactForLog({ method, url, headers }));

    return withAbortTimeout(timeoutMs, signal, async (abortSignal) => {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          'content-type': 'application/json',
          // Required by the real ARM contract on every call.
          referer: this.baseUrl,
          ...headers,
        },
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

      const responseHeaders = {
        location: res.headers?.get?.('location') ?? null,
        azureAsyncOperation: res.headers?.get?.('azure-asyncoperation') ?? null,
      };

      if (!res.ok) {
        throw new AdapterError(`Local RP request failed: ${method} ${pathOrUrl} -> ${res.status}`, {
          status: res.status,
          body: parsed,
        });
      }
      return { status: res.status, headers: responseHeaders, body: parsed };
    });
  }

  // ---- Read-only operations: bounded by a timeout, but do not require a
  // mutation context and are not serialized against each other. ----

  async getCluster({ subscriptionId, resourceGroup, name }, { signal, timeoutMs } = {}) {
    const { body } = await this.#request('GET', buildClusterPath({ subscriptionId, resourceGroup, name }), { signal, timeoutMs });
    return body;
  }

  /**
   * Lists clusters, following ARM `nextLink`-style pagination so that
   * owned resources are never missed among other subscription/RG caches
   * spread across multiple pages. Every followed `nextLink` is
   * origin-locked (via the same same-origin check `#request` already
   * applies to any absolute URL, exactly like Location/Azure-
   * AsyncOperation follow-ups) -- a malicious or buggy `nextLink` pointing
   * outside this adapter's base origin is refused rather than followed.
   * Bounded by `maxPages` so a `nextLink` cycle (accidental or malicious)
   * can never spin this loop forever.
   */
  async listClusters({ subscriptionId, resourceGroup }, { signal, timeoutMs, maxPages = DEFAULT_MAX_LIST_PAGES } = {}) {
    const items = [];
    let requestTarget = buildClusterPath({ subscriptionId, resourceGroup });
    let appendApiVersion = true;
    let page = 0;
    for (;;) {
      page += 1;
      if (page > maxPages) {
        throw new AdapterError(
          `listClusters exceeded the maximum page count (${maxPages}) while following nextLink -- refusing to loop indefinitely (possible nextLink cycle).`
        );
      }
      const { body } = await this.#request('GET', requestTarget, { signal, timeoutMs, appendApiVersion });
      const pageItems = Array.isArray(body) ? body : (body?.value ?? []);
      items.push(...pageItems);

      const nextLink = typeof body?.nextLink === 'string' && body.nextLink.length > 0 ? body.nextLink : null;
      if (!nextLink) break;
      // #request already origin-locks any absolute URL against this
      // adapter's base origin -- a cross-origin nextLink throws
      // AdapterError there before any request to it is ever issued.
      requestTarget = nextLink;
      appendApiVersion = false; // nextLink is already fully qualified by the RP.
    }
    return { value: items };
  }

  async getDatabase({ subscriptionId, resourceGroup, clusterName }, { signal, timeoutMs } = {}) {
    const { body } = await this.#request('GET', buildDatabasePath({ subscriptionId, resourceGroup, clusterName }), {
      signal,
      timeoutMs,
    });
    return body;
  }

  /**
   * Polls an absolute Location/Azure-AsyncOperation follow-up URL (must be
   * same-origin as this adapter -- never trusted blindly). Returns the
   * parsed body; api-version is not re-appended since these URLs are
   * typically already fully qualified by the RP.
   */
  async pollOperationUrl(url, { signal, timeoutMs } = {}) {
    const { body } = await this.#request('GET', url, { signal, timeoutMs, appendApiVersion: false });
    return body;
  }

  async #clusterExists(coords) {
    try {
      await this.getCluster(coords);
      return true;
    } catch (err) {
      if (err instanceof AdapterError && err.status === 404) return false;
      throw err;
    }
  }

  async #databaseExists(coords) {
    try {
      await this.getDatabase(coords);
      return true;
    } catch (err) {
      if (err instanceof AdapterError && err.status === 404) return false;
      throw err;
    }
  }

  // ---- Mutating operations: require a validated mutation context (see
  // mutation-context.mjs), and are serialized against one another. ----

  /**
   * Creates a Microsoft.Cache/redisEnterprise cluster. Create-ONLY
   * semantics: refuses (AdapterError, status 409) if a cluster with this
   * name already exists -- owned by this run or not -- so a PUT can never
   * silently overwrite something already live. When `context.dryRunOnly`
   * is true (the requested SKU is over the live ceiling -- see
   * sku-catalog.mjs/catalog-provider.mjs), every guard still runs, but no
   * real request is ever issued; a simulated result is returned instead.
   *
   * @param {{subscriptionId: string, resourceGroup?: string, name: string}} coords
   * @param {object} body - `{ location, tags, sku: { name[, capacity] }, properties: { minimumTlsVersion: '1.2' } }`
   * @param {object} context - see mutation-context.mjs; must include `dryRunOnly` when applicable.
   */
  async createCluster(coords, body, context) {
    assertValidMutationContext(context, coords.name, 'write');
    return this.#withMutationLock(async () => {
      if (context.dryRunOnly) {
        return { status: 202, headers: {}, body: { name: coords.name, properties: { provisioningState: 'Succeeded' }, simulated: true, dryRun: true } };
      }
      if (await this.#clusterExists(coords)) {
        throw new AdapterError(
          `Refusing to create cluster "${coords.name}": a cluster with this name already exists (create-only semantics).`,
          { status: 409 }
        );
      }
      return this.#request('PUT', buildClusterPath(coords), { body });
    });
  }

  /**
   * Creates the cluster's default database. Create-ONLY semantics, mirroring
   * createCluster. `body` should carry only validated-scenario fields
   * (clientProtocol/encryption, evictionPolicy, clusteringPolicy, and
   * optionally modules/persistence/geo) -- nothing invented here.
   */
  async createDatabase(coords, body, context) {
    assertValidMutationContext(context, coords.clusterName, 'write');
    return this.#withMutationLock(async () => {
      if (context.dryRunOnly) {
        return { status: 202, headers: {}, body: { name: 'default', properties: { provisioningState: 'Succeeded' }, simulated: true, dryRun: true } };
      }
      if (await this.#databaseExists(coords)) {
        throw new AdapterError(
          `Refusing to create the database for "${coords.clusterName}": it already exists (create-only semantics).`,
          { status: 409 }
        );
      }
      return this.#request('PUT', buildDatabasePath(coords), { body });
    });
  }

  /** Deletes a cluster (and, per the real ARM contract, its database cascades with it). */
  async deleteCluster(coords, context) {
    assertValidMutationContext(context, coords.name, 'write');
    return this.#withMutationLock(() => this.#request('DELETE', buildClusterPath(coords)));
  }

  /**
   * Fetches access keys for the cluster's default database. Sensitive:
   * callers must never log or persist the raw returned values (this
   * adapter itself never logs response bodies, only method/url/headers).
   * Classified as a 'read' operation kind (it does not mutate resource
   * state) but still routed through the same mutation-context boundary --
   * ownership/denylist/fencing must hold even for reading secrets.
   */
  async listKeys(coords, context) {
    assertValidMutationContext(context, coords.clusterName, 'read');
    const { body } = await this.#request('POST', `${buildDatabasePath(coords)}/listKeys`, { body: {} });
    return body;
  }
}

