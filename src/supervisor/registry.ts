import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

export async function readEnabledRepos(path: string): Promise<string[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return [
    ...new Set(
      (await file.text())
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

async function writeEnabledRepos(path: string, repos: readonly string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await Bun.write(temporaryPath, repos.length > 0 ? `${repos.join("\n")}\n` : "");
  await rename(temporaryPath, path);
}

export async function enableRepo(path: string, repo: string): Promise<string[]> {
  const repos = await readEnabledRepos(path);
  if (repos.includes(repo)) return repos;
  const enabled = [...repos, repo];
  await writeEnabledRepos(path, enabled);
  return enabled;
}

export async function disableRepo(path: string, repo: string): Promise<string[]> {
  const repos = await readEnabledRepos(path);
  const enabled = repos.filter((candidate) => candidate !== repo);
  if (enabled.length !== repos.length) await writeEnabledRepos(path, enabled);
  return enabled;
}
