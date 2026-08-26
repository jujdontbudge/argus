import { gitRoot } from "../up/git.ts";
import {
  formatSupervisorStatus,
  originRefusalStatus,
  stopRepo,
  supervisorStatus,
} from "./control.ts";

export async function down(cwd = process.cwd()): Promise<number> {
  const repo = await gitRoot(cwd);
  if (!repo) {
    console.error("argus down: current directory is not inside a git repository");
    return 1;
  }
  const result = await stopRepo(repo);
  console.log(`Argus stopped ${repo}`);
  if (result.remaining.length === 0) {
    console.log("Supervisor unloaded (no enabled repos)");
  }
  return 0;
}

export async function status(): Promise<number> {
  const [rows, refusals] = await Promise.all([
    supervisorStatus(),
    originRefusalStatus(),
  ]);
  console.log(formatSupervisorStatus(rows, refusals).trimEnd());
  return rows.some(({ state }) => state === "degraded") ? 1 : 0;
}
