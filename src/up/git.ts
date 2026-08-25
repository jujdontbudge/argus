interface CommandResult {
  exitCode: number;
  stdout: string;
}

export async function gitRoot(cwd: string): Promise<string | null> {
  const child = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    stderr: "ignore",
    stdout: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  const result: CommandResult = { exitCode, stdout };
  return result.exitCode === 0 ? result.stdout.trim() : null;
}
