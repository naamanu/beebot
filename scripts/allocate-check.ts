// Runs the allocator on a fixed plan, to check how it splits work (one API call).
import "dotenv/config";
import { allocate } from "../server/missions/planner.ts";
import type { Plan } from "../server/types.ts";

const plan: Plan = {
  summary: "Add three independent features to the taskboard library: due dates, a CLI, and a Markdown/CSV export module, each with tests.",
  steps: [
    { id: "S1", title: "Inspect store API and test setup", detail: "Read src/store.js and the tests to learn the data model.", dependsOn: [] },
    { id: "S2", title: "Add due dates and listOverdue", detail: "Optional ISO dueDate on createTodo; listOverdue(now); tests.", dependsOn: ["S1"] },
    { id: "S3", title: "Implement CLI bin/todo.js", detail: "add, list, done commands persisting to todos.json; tests.", dependsOn: ["S1"] },
    { id: "S4", title: "Implement src/export.js", detail: "toMarkdown and toCSV renderers; tests.", dependsOn: ["S1"] },
    { id: "S5", title: "Integrate, document, run full suite", detail: "Merge the features, update README, run all tests.", dependsOn: ["S2", "S3", "S4"] },
  ],
  risks: [],
};
const { data, costUsd } = await allocate({ template: "coding", request: plan.summary, files: [], repoFiles: ["src/store.js", "test/store.test.js", "README.md", "package.json"] }, plan);
console.log(JSON.stringify(data, null, 2), `\ncost $${costUsd.toFixed(4)}`);
