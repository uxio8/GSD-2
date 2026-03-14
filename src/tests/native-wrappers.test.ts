import test from "node:test";
import assert from "node:assert/strict";

import { truncateHead, truncateTail } from "@gsd/native";
import { xxHash32 } from "@gsd/native/xxhash";

test("native truncate wrappers preserve line boundaries", () => {
  const tail = truncateTail("alpha\nbeta\ngamma\n", 10);
  const head = truncateHead("alpha\nbeta\ngamma\n", 10);

  assert.equal(tail.truncated, true);
  assert.equal(tail.text, "alpha\n");
  assert.equal(head.truncated, true);
  assert.equal(head.text, "gamma\n");
});

test("native xxhash wrapper matches the historical JS value", () => {
  assert.equal(xxHash32("  const x = 42;", 3), 1086197915);
});
