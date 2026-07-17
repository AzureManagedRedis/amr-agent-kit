import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { LedgerEvent } from "./contracts.js";

export class EventLedger {
  readonly #filePath: string;
  readonly #runId: string;
  #sequence: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(filePath: string, runId: string, initialSequence = 0) {
    this.#filePath = filePath;
    this.#runId = runId;
    this.#sequence = initialSequence;
  }

  append(
    type: string,
    context: {
      pairId?: string;
      executionId?: string;
      data?: Readonly<Record<string, unknown>>;
    } = {},
  ): Promise<LedgerEvent> {
    const event: LedgerEvent = {
      sequence: ++this.#sequence,
      timestamp: new Date().toISOString(),
      type,
      runId: this.#runId,
      ...context,
    };

    this.#queue = this.#queue.then(async () => {
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      const handle = await open(this.#filePath, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });

    return this.#queue.then(() => event);
  }

  flush(): Promise<void> {
    return this.#queue;
  }
}

export async function readLastLedgerSequence(filePath: string): Promise<number> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  try {
    const { size } = await handle.stat();
    if (size === 0) {
      return 0;
    }
    const chunkSize = Math.min(size, 64 * 1_024);
    const buffer = Buffer.alloc(chunkSize);
    await handle.read(buffer, 0, chunkSize, size - chunkSize);
    const lines = buffer
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const lastLine = lines.at(-1);
    if (!lastLine) {
      return 0;
    }
    const event = JSON.parse(lastLine) as { sequence?: unknown };
    if (!Number.isSafeInteger(event.sequence) || (event.sequence as number) < 1) {
      throw new Error(`Ledger has invalid terminal sequence: ${filePath}`);
    }
    return event.sequence as number;
  } finally {
    await handle.close();
  }
}
