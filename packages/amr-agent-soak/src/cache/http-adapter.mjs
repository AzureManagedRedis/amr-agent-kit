// Local-RP HTTP adapter for the live-cache safety subsystem.
//
// This adapter is hard-locked to http://localhost:8443 -- there is no
// fallback to 8444 (or any other port), and no remote host is ever
// permitted. That is deliberate: an accidental "helpful" retry against a
// different port or host must never be able to reach a real Azure endpoint.

import { LOCAL_RP_HOST, LOCAL_RP_PORT } from './config.mjs';
import { redactForLog } from './redact.mjs';

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

export class LocalRpHttpAdapter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.host] - must equal LOCAL_RP_HOST or this throws.
   * @param {number} [opts.port] - must equal LOCAL_RP_PORT or this throws.
   * @param {typeof fetch} [opts.fetchImpl] - injectable for tests; defaults to the global fetch.
   * @param {(event: string, detail: object) => void} [opts.logger] - injectable, receives already-redacted detail.
   */
  constructor({ host = LOCAL_RP_HOST, port = LOCAL_RP_PORT, fetchImpl = fetch, logger = () => {} } = {}) {
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
  }

  async #request(method, path, { body, headers = {} } = {}) {
    const url = `${this.baseUrl}${path}`;
    this.logger('http-adapter.request', redactForLog({ method, url, headers }));

    const res = await this.fetchImpl(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
  }

  getCache(name) {
    return this.#request('GET', `/caches/${encodeURIComponent(name)}`);
  }

  listCaches() {
    return this.#request('GET', '/caches');
  }

  createCache(name, spec) {
    return this.#request('PUT', `/caches/${encodeURIComponent(name)}`, { body: spec });
  }

  patchCacheTopology(name, patch) {
    return this.#request('PATCH', `/caches/${encodeURIComponent(name)}/topology`, { body: patch });
  }

  deleteCache(name) {
    return this.#request('DELETE', `/caches/${encodeURIComponent(name)}`);
  }

  getOperationStatus(operationId) {
    return this.#request('GET', `/operations/${encodeURIComponent(operationId)}`);
  }

  getSkuCatalog() {
    return this.#request('GET', '/catalog/skus');
  }
}
