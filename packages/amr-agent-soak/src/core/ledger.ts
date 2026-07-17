import { createReadStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
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
      const handle = await open(this.#filePath, "a+", 0o600);
      try {
        const { size } = await handle.stat();
        let prefix = "";
        if (size > 0) {
          const lastByte = Buffer.alloc(1);
          await handle.read(lastByte, 0, 1, size - 1);
          if (lastByte[0] !== 0x0a && lastByte[0] !== 0x0d) {
            prefix = "\n";
          }
        }
        await handle.writeFile(`${prefix}${JSON.stringify(event)}\n`);
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
  try {
    const handle = await open(filePath, "r");
    const { size } = await handle.stat();
    await handle.close();
    if (size === 0) {
      return 0;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  let lastMonotonicSequence = 0;
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as { sequence?: unknown };
      if (
        Number.isSafeInteger(event.sequence) &&
        (event.sequence as number) > lastMonotonicSequence
      ) {
        lastMonotonicSequence = event.sequence as number;
      }
    } catch {
      // A controller crash may leave one torn line. Earlier valid fsynced events remain authoritative.
    }
  }
  if (lastMonotonicSequence === 0) {
    throw new Error(`Ledger contains no valid monotonic event: ${filePath}`);
  }
  return lastMonotonicSequence;
}
