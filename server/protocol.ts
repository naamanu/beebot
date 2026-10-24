import { z } from "zod";
import type { ClientMsg } from "./types.ts";

const id = z.string().min(1).max(100);
const text = z.string().trim().min(1).max(100_000);
const template = z.enum(["general", "coding", "incident"]);
const attachments = z.array(z.string().regex(/^[\w-]{1,100}$/)).max(20);
const incidentStatus = z.enum(["investigating", "identified", "mitigated", "resolved"]);

export const commandContextSchema = z.object({
  template,
  attachments,
  plan: z.boolean(),
  taskId: id.nullable(),
  uploading: z.boolean().default(false),
});

export const clientMessageSchema: z.ZodType<ClientMsg> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), tasks: z.array(text).max(4) }),
  z.object({ type: z.literal("say"), text, template: template.optional(), attachments: attachments.optional(), plan: z.boolean().optional(), taskId: id.nullable().optional() }),
  z.object({ type: z.literal("command_context"), context: commandContextSchema }),
  z.object({ type: z.literal("mic"), on: z.boolean() }),
  z.object({ type: z.literal("reset") }),
  z.object({ type: z.literal("complete_task"), taskId: id }),
  z.object({ type: z.literal("focus"), id: id.nullable() }),
  z.object({ type: z.literal("select_task"), id: id.nullable() }),
  z.object({ type: z.literal("direct"), id, text }),
  z.object({ type: z.literal("control"), id, action: z.enum(["stop", "approve"]) }),
  z.object({ type: z.literal("approval"), id, decision: z.enum(["approve", "deny"]) }),
  z.object({ type: z.literal("plan_decision"), missionId: id, decision: z.enum(["approve", "revise", "cancel"]), note: text.optional() }),
  z.object({ type: z.literal("cancel_start"), id }),
  z.object({ type: z.literal("declare_incident"), title: z.string().trim().max(1000) }),
  z.object({ type: z.literal("incident_status"), status: incidentStatus }),
  z.object({ type: z.literal("clear_rules") }),
]);

export const previewSchema = z.object({ text, attachments: z.array(z.string().max(255)).max(20).optional(), taskId: id.nullable().optional() });

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function parseJson(body: string): unknown {
  try { return JSON.parse(body); }
  catch { throw new HttpError(400, "Invalid JSON."); }
}
