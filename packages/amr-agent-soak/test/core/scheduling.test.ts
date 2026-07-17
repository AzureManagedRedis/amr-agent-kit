import assert from "node:assert/strict";
import test from "node:test";
import { randomizedArmOrder } from "../../src/core/controller.js";

test("arm randomization is stable for resume and balanced across pairs", () => {
  const first = Array.from({ length: 100 }, (_, index) =>
    randomizedArmOrder("run-1", `pair-${index}`),
  );
  const second = Array.from({ length: 100 }, (_, index) =>
    randomizedArmOrder("run-1", `pair-${index}`),
  );
  assert.deepEqual(first, second);
  const withoutFirst = first.filter(([arm]) => arm === "without-skill").length;
  assert.ok(withoutFirst > 35 && withoutFirst < 65, `unexpected distribution: ${withoutFirst}`);
  assert.ok(first.every((order) => new Set(order).size === 2));
});
