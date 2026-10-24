import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { addScratchDir, addWorktree, createRun, nextAgentId } from "../server/workspace.ts";
import { writeJsonAtomic } from "../server/persistence.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { cwd, stdio: "pipe" });

function workspace(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "beebot-workspace-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return createRun(root, resolve("demo/template"));
}

test("undoing an unstarted coding agent never reuses its branch", (t) => {
  const run = workspace(t);
  assert.equal(nextAgentId(run), "1");
  const previous = addWorktree(run, "1");
  writeFileSync(join(previous, "keep.txt"), "Preserve cancelled work");
  const next = nextAgentId(run);
  assert.equal(next, "2");
  assert.doesNotThrow(() => addWorktree(run, next));
  assert.equal(readFileSync(join(previous, "keep.txt"), "utf8"), "Preserve cancelled work");
});

test("scratch folders and partially created branches reserve IDs after restart", (t) => {
  const run = workspace(t);
  addScratchDir(run, "4");
  git(run.repo, "branch", "agent-7");
  assert.equal(nextAgentId(run), "8");
});

test("a coding worker inherits every prerequisite branch", (t) => {
  const run = workspace(t);
  for (const [id, filename] of [["1", "alpha.txt"], ["2", "beta.txt"]] as const) {
    const cwd = addWorktree(run, id);
    writeFileSync(join(cwd, filename), id);
    git(cwd, "add", filename);
    git(cwd, "commit", "-qm", `Add ${filename}`);
  }
  const combined = addWorktree(run, "3", ["1", "2"]);
  assert.equal(readFileSync(join(combined, "alpha.txt"), "utf8"), "1");
  assert.equal(readFileSync(join(combined, "beta.txt"), "utf8"), "2");
  for (const id of ["1", "2"]) assert.doesNotThrow(() => git(combined, "merge-base", "--is-ancestor", `agent-${id}`, "HEAD"));
});

test("conflicting prerequisites fail before agent execution and remain inspectable", (t) => {
  const run = workspace(t);
  for (const id of ["1", "2"]) {
    const cwd = addWorktree(run, id);
    writeFileSync(join(cwd, "conflict.txt"), id);
    git(cwd, "add", "conflict.txt");
    git(cwd, "commit", "-qm", `Change from ${id}`);
  }
  assert.throws(() => addWorktree(run, "3", ["1", "2"]));
  assert.match(git(join(run.dir, "agent-3"), "status", "--porcelain").toString(), /AA conflict.txt/);
  assert.equal(nextAgentId(run), "4");
});

test("session writes preserve the previous document when serialization fails", (t) => {
  const run = workspace(t);
  const file = join(run.dir, "session.json");
  writeJsonAtomic(file, { revision: 1 });
  assert.throws(() => writeJsonAtomic(file, { invalid: 1n }));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { revision: 1 });
  assert.equal(readdirSync(run.dir).some((name) => name.endsWith(".tmp")), false);
  writeJsonAtomic(file, { revision: 2 });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { revision: 2 });
});
