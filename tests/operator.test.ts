import assert from "node:assert/strict";
import { test } from "node:test";
import { OperatorInput } from "../server/operator.ts";
import { clientMessageSchema } from "../server/protocol.ts";

test("voice preserves General, plan-first, attachments and the selected task", () => {
  const operator = new OperatorInput();
  const message = clientMessageSchema.parse({ type: "command_context", context: {
    template: "general", plan: true, attachments: ["file-123"], taskId: "task-1", uploading: false,
  } });
  assert.equal(message.type, "command_context");
  if (message.type !== "command_context") throw new Error("Wrong message type");
  operator.context = message.context;
  operator.focused = "2";
  operator.beginVoiceTurn();
  operator.context = { template: "coding", plan: false, attachments: [], taskId: "task-2", uploading: false };
  operator.focused = "3";
  assert.deepEqual(operator.endVoiceTurn(), { focused: "2", context: message.context });
  operator.beginVoiceTurn();
  assert.equal(operator.endVoiceTurn().context.taskId, "task-2");
});

test("an in-progress attachment stays marked unavailable for the entire spoken turn", () => {
  const operator = new OperatorInput();
  operator.context.uploading = true;
  operator.beginVoiceTurn();
  operator.context.uploading = false;
  operator.context.attachments.push("new-upload");
  const turn = operator.endVoiceTurn();
  assert.equal(turn.context.uploading, true);
  assert.deepEqual(turn.context.attachments, []);
});

test("malformed control messages and invalid enum values are rejected", () => {
  for (const message of [null, {}, { type: "say", text: 123 }, { type: "control", id: "1", action: "delete" }, { type: "plan_decision", missionId: "x", decision: "yes" }, { type: "start", tasks: Array(5).fill("task") }]) {
    assert.equal(clientMessageSchema.safeParse(message).success, false);
  }
});
