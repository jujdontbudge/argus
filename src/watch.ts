import { EYE_NAMES, type EyeName } from "./supervisor/runtime.ts";

function isEyeName(value: string | undefined): value is EyeName {
  return EYE_NAMES.some((eye) => eye === value);
}

export async function runWatcher(args: string[]): Promise<number> {
  const eye = args[0];
  if (!isEyeName(eye)) {
    console.error(
      `argus watch: unknown eye '${eye ?? ""}'; expected one of ${EYE_NAMES.join(", ")}`,
    );
    return 1;
  }

  console.error(`argus watch ${eye}: --repo is required`);
  return 1;
}
