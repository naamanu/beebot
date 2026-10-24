import { cpSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
  const dir = join(root, ".runs", new Date().toISOString().replace(/[:.]/g, "-"));
  const repo = join(dir, "repo");
  mkdirSync(dir, { recursive: true });
  cpSync(template, repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=Control Tower", "-c", "user.email=tower@localhost", "commit", "-q", "-m", "Initial commit");
  return { dir, repo };
}

// One git worktree per agent so they never trample each other's files.
export function addWorktree(run: Run, agentId: string): string {
  const dir = join(run.dir, `agent-${agentId}`);
  git(run.repo, "worktree", "add", "-q", "-b", `agent-${agentId}`, dir);
  return dir;
}
