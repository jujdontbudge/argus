export interface WaitForConditionOptions {
  intervalMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs: number;
}

/** Poll a condition with a monotonic, injectable deadline. */
export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  options: WaitForConditionOptions,
): Promise<boolean> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const deadline = now() + options.timeoutMs;

  while (true) {
    if (await condition()) return true;
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleep(Math.min(options.intervalMs, remaining));
  }
}
