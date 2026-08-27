import { gitRoot } from "../up/git.ts";
import {
  acknowledgeAuditStatus,
  auditStatus,
  formatSupervisorStatus,
  silentDeploymentStatus,
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
    if (result.unloaded) {
      console.log("Supervisor unloaded (no enabled repos)");
    } else if (result.managed) {
      console.log("No enabled repos remain; supervisor was already unloaded");
    } else {
      console.log("No enabled repos remain; supervisor lifecycle is externally managed");
    }
  }
  return 0;
}

export async function status(args: string[] = []): Promise<number> {
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== "--ack" || !/^[a-f0-9]{64}$/.test(args[1]!)) {
      console.error("argus status: expected --ack <64-character audit id>");
      return 1;
    }
    if (!(await acknowledgeAuditStatus(args[1]!))) {
      console.error(`argus status: audit not found: ${args[1]}`);
      return 1;
    }
  }
  const [rows, audits, silent] = await Promise.all([
    supervisorStatus(),
    auditStatus(),
    silentDeploymentStatus(),
  ]);
  console.log(formatSupervisorStatus(rows, audits, silent).trimEnd());
  // A silent deployment exits non-zero for the same reason #85's unreported
  // watcher does: an operator who only reads the exit code must still learn
  // that something registered is producing nothing.
  return rows.some(({ state }) => state === "degraded") ||
    audits.length > 0 ||
    silent.length > 0
    ? 1
    : 0;
}
