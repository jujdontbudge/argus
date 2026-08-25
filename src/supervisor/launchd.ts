import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

import {
  renderSupervisorPlist,
  type SupervisorPlistOptions,
} from "./plist.ts";

export interface Launchctl {
  bootstrap(plistPath: string): Promise<void>;
  bootout(): Promise<void>;
  isLoaded(): Promise<boolean>;
  kickstart(): Promise<void>;
}

export interface SupervisorJobOptions extends SupervisorPlistOptions {
  dryRun?: boolean;
  plistPath: string;
}

export interface SupervisorJobResult {
  changed: boolean;
  reloaded: boolean;
}

export interface SupervisorJobDryRunResult {
  plist: string;
}

export function convergeSupervisorJob(
  options: SupervisorJobOptions & { dryRun: true },
  launchctl: Launchctl,
): Promise<SupervisorJobDryRunResult>;
export function convergeSupervisorJob(
  options: SupervisorJobOptions,
  launchctl: Launchctl,
): Promise<SupervisorJobResult>;
export async function convergeSupervisorJob(
  options: SupervisorJobOptions,
  launchctl: Launchctl,
): Promise<SupervisorJobDryRunResult | SupervisorJobResult> {
  const plist = renderSupervisorPlist(options);
  if (options.dryRun) return { plist };

  const file = Bun.file(options.plistPath);
  const previous = (await file.exists()) ? await file.text() : null;
  const changed = previous !== plist;
  const loaded = await launchctl.isLoaded();
  let reloaded = false;

  if (changed) {
    await mkdir(dirname(options.plistPath), { recursive: true });
    const temporaryPath = `${options.plistPath}.${process.pid}.tmp`;
    await Bun.write(temporaryPath, plist);
    await rename(temporaryPath, options.plistPath);
    if (loaded) {
      await launchctl.bootout();
      reloaded = true;
    }
  }

  if (!loaded || reloaded) {
    await launchctl.bootstrap(options.plistPath);
    await launchctl.kickstart();
  }
  return { changed, reloaded };
}

export async function unloadSupervisorJob(
  launchctl: Launchctl,
): Promise<boolean> {
  if (!(await launchctl.isLoaded())) return false;
  await launchctl.bootout();
  return true;
}
