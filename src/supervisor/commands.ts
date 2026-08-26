import { gitRoot } from "../up/git.ts";
import {
  acknowledgeAuditStatus,
  auditStatus,
  formatSupervisorStatus,
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
  const [rows, audits] = await Promise.all([
    supervisorStatus(),
    auditStatus(),
  ]);
  console.log(formatSupervisorStatus(rows, audits).trimEnd());
  return rows.some(({ state }) => state === "degraded") || audits.length > 0 ? 1 : 0;
}
