import {
  approveClaudeMemPlan,
  createClaudeMemPlan,
  importClaudeMemPlan,
  retireClaudeMem,
  summarizePlan,
} from "./claude-mem";

function flag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
}

export async function claudeMemCommand(args: string[]): Promise<number> {
  try {
    if (args[0] === "plan") {
      const source = flag(args, "--source");
      const output = flag(args, "--output");
      if (source === null || output === null || args.length !== 5) {
        console.error(
          "Usage: argus memory claude-mem plan --source <db> --output <plan.json>",
        );
        return 1;
      }
      const plan = await createClaudeMemPlan({ source, output });
      console.log(`claude-mem plan written to ${output}: ${summarizePlan(plan)}`);
      return 0;
    }
    if (args[0] === "approve") {
      const planPath = flag(args, "--plan");
      const confirmation = flag(args, "--confirm");
      if (planPath === null || confirmation === null || args.length !== 5) {
        console.error(
          "Usage: argus memory claude-mem approve --plan <plan.json> --confirm <plan-id>",
        );
        return 1;
      }
      const approved = await approveClaudeMemPlan({ planPath, confirmation });
      console.log(
        `claude-mem plan approved: ${approved.plan.id} digest ${approved.digest}`,
      );
      return 0;
    }
    if (args[0] === "import") {
      const planPath = flag(args, "--plan");
      if (planPath === null || args.length !== 3) {
        console.error("Usage: argus memory claude-mem import --plan <plan.json>");
        return 1;
      }
      const imported = await importClaudeMemPlan({ planPath });
      const factWord = imported.receipt.imported === 1 ? "fact" : "facts";
      const repoWord = imported.receipt.repos.length === 1 ? "repo" : "repos";
      console.log(
        `claude-mem import complete: ${imported.receipt.imported} ${factWord} into ` +
          `${imported.receipt.repos.length} ${repoWord}; receipt ${imported.receiptPath}`,
      );
      return 0;
    }
    if (args[0] === "retire") {
      const planPath = flag(args, "--plan");
      const confirmation = flag(args, "--confirm");
      if (planPath === null || confirmation === null || args.length !== 5) {
        console.error(
          "Usage: argus memory claude-mem retire --plan <plan.json> " +
            "--confirm uninstall-claude-mem:<plan-id>",
        );
        return 1;
      }
      const retired = await retireClaudeMem({ planPath, confirmation });
      console.log(
        `claude-mem plugin uninstalled; source archive preserved at ${retired.sourceDatabase}`,
      );
      return 0;
    }
    console.error(
      "Usage: argus memory claude-mem <plan|approve|import|retire> [options]",
    );
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
