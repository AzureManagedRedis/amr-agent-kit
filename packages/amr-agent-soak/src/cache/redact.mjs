// Redaction utilities for the live-cache safety subsystem.
//
// Nothing this subsystem logs may ever contain a raw subscription ID, tenant
// ID, credential, token, or connection string. Every logging path in this
// package must route through these helpers before anything reaches stdout,
// a file, or a returned "safe to display" summary.

const GUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_VALUE_RE =
  /\b((?:api|access|shared|primary|secondary)[-_]?key|password|secret|token|connectionstring)\b\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;
const AUTH_HEADER_RE = /\b(authorization)\s*:\s*\S+/gi;

const REDACTED = '[REDACTED]';

/** Redacts sensitive substrings out of a plain string. */
export function redactString(input) {
  if (typeof input !== 'string') return input;
  let out = input;
  out = out.replace(GUID_RE, REDACTED);
  out = out.replace(BEARER_RE, `Bearer ${REDACTED}`);
  out = out.replace(KEY_VALUE_RE, (_match, key) => `${key}=${REDACTED}`);
  out = out.replace(AUTH_HEADER_RE, (_match, key) => `${key}: ${REDACTED}`);
  return out;
}

const SENSITIVE_KEY_RE = /(subscription|tenant|credential|password|secret|token|key|authorization|connectionstring)/i;

/** Deep-redacts an arbitrary value: strings are pattern-scrubbed, and any
 * object property whose *name* looks sensitive is wholesale replaced. */
export function redactValue(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, seen));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : redactValue(v, seen);
  }
  return out;
}

/** Convenience wrapper: redacts strings or deep-redacts objects, whichever is given. */
export function redactForLog(value) {
  return typeof value === 'string' ? redactString(value) : redactValue(value);
}

/** Wraps a logger (default: console) so every argument passed through it is redacted first. */
export function createRedactingLogger(baseLogger = console) {
  const wrap =
    (level) =>
    (...args) =>
      baseLogger[level](...args.map(redactForLog));
  return {
    log: wrap('log'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
    debug: typeof baseLogger.debug === 'function' ? wrap('debug') : wrap('log'),
  };
}
