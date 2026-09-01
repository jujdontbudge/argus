import { describe, expect, test } from "bun:test";

import { waitForCondition } from "./poll.ts";

describe("waitForCondition", () => {
  test("keeps polling past the first short window until the condition is true", async () => {
    let now = 0;
    let polls = 0;

    const result = await waitForCondition(
      () => {
        polls += 1;
        return now >= 1_000;
      },
      {
        intervalMs: 100,
        timeoutMs: 2_000,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      },
    );

    expect(result).toBe(true);
    expect(polls).toBe(11);
  });
});
