// Kill switch for the live-cache safety subsystem.
//
// A kill switch is a simple, filesystem-based sentinel: if the sentinel file
// exists, every mutating operation must refuse to proceed. It must be
// checked immediately before each mutating call -- never cached across
// calls, never skipped "just this once".

import { existsSync } from 'node:fs';

export class KillSwitchEngaged extends Error {
  constructor(message) {
    super(message);
    this.name = 'KillSwitchEngaged';
  }
}

export class KillSwitch {
  /**
   * @param {object} [opts]
   * @param {string|null} [opts.path] - sentinel file path; no path means the switch can never be engaged.
   * @param {(path: string) => boolean} [opts.exists] - injectable for tests.
   */
  constructor({ path = null, exists = existsSync } = {}) {
    this.path = path;
    this.exists = exists;
  }

  isEngaged() {
    if (!this.path) return false;
    return this.exists(this.path);
  }

  /** Throws KillSwitchEngaged if the switch is engaged. Call this immediately before any mutation. */
  assertNotEngaged(context = '') {
    if (this.isEngaged()) {
      throw new KillSwitchEngaged(
        `Kill switch is engaged (${this.path}); refusing to mutate.${context ? ` Context: ${context}` : ''}`
      );
    }
  }
}
