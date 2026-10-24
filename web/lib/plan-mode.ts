// When new work should get a plan to approve before any agent starts.

export type PlanMode = "auto" | "on" | "off";

// Multi-part typed requests ("do X, then Y, and Z") benefit from a plan;
// short ones should just start.
export function looksMultiPart(text: string): boolean {
  const t = text.trim();
  return t.length > 160 || /(^|\s)(\(?\d\)|\d\.)\s/.test(t) || (t.match(/,|;|\band\b|\bthen\b/g)?.length ?? 0) >= 3;
}

// Spoken work always starts right away in auto mode: voice is for steering
// in real time, not for drafting plans.
export function shouldPlan(mode: PlanMode, text: string, spoken: boolean): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return !spoken && looksMultiPart(text);
}
