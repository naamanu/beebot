import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const DEFAULT_TASKS = [
  "Add due dates: createTodo should accept an optional ISO dueDate, and add listOverdue(now) returning undone todos past due. Add tests.",
  "Add input validation: createTodo must reject empty, whitespace-only, or over-200-character titles with a clear error. Add tests.",
  "Fix search(): it is case-sensitive and ignores tags. Make it case-insensitive and also match tags. Add tests.",
  "Add a CLI at bin/todo.js with `add <title>`, `list`, and `done <id>` commands that persist to todos.json. Add a test.",
];

export interface Run {
  dir: string;
  repo: string;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

// A fresh copy of the demo repo for each session.
export function createRun(root: string, template: string): Run {
  const dir = join(root, ".runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  const repo = join(dir, "repo");
  mkdirSync(dir, { recursive: true });
  cpSync(template, repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=Control Tower", "-c", "user.email=tower@localhost", "commit", "-q", "-m", "Initial commit");
  return { dir, repo };
}

// One git worktree per agent so they never trample each other's files.
// Inherit all prerequisite commits. Conflicts fail before an agent starts,
// leaving the worktree on disk for inspection.
export function addWorktree(run: Run, agentId: string, baseAgentIds: string[] = []): string {
  const dir = join(run.dir, `agent-${agentId}`);
  const [base, ...others] = [...new Set(baseAgentIds)];
  git(run.repo, "worktree", "add", "-q", "-b", `agent-${agentId}`, dir, base ? `agent-${base}` : "main");
  for (const dependency of others) {
    git(dir, "-c", "user.name=Control Tower", "-c", "user.email=tower@localhost", "-c", "commit.gpgsign=false", "merge", "--no-edit", `agent-${dependency}`);
  }
  return dir;
}

// Keep cancelled and partially-created workspaces reserved across restarts.
// Undo never deletes work or reuses a branch/directory belonging to an old agent.
export function nextAgentId(run: Run): string {
  const branches = git(run.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/agent-*").toString().split("\n");
  const ids = [...readdirSync(run.dir), ...branches].flatMap((name) => {
    const match = /^agent-(\d+)$/.exec(name);
    return match ? [Number(match[1])] : [];
  });
  return String(Math.max(0, ...ids) + 1);
}

// The repo's tracked files, for planning code tasks.
export function repoFiles(template: string): string[] {
  try {
    return execFileSync("git", ["ls-files"], { cwd: template, stdio: "pipe" }).toString().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// A plain working directory, for agents that don't need a code checkout.
export function addScratchDir(run: Run, agentId: string): string {
  const dir = join(run.dir, `agent-${agentId}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
