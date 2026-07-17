"use strict";

// Consumer-only reference. Install node-redis outside this retained corpus.
const { createClient } = require("redis");

function createRetainedClient(endpoint, timeoutMs) {
  return createClient({
    url: endpoint,
    socket: {
      connectTimeout: timeoutMs,
      tls: true,
      rejectUnauthorized: true,
      reconnectStrategy: retries => retries >= 3 ? new Error("retry budget exhausted") : Math.min(250 * (2 ** retries), timeoutMs)
    }
  });
}

module.exports = { createRetainedClient };
