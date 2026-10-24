import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "./persistence.ts";

// Standing rules the operator has spoken ("no new dependencies").
// Persisted so they carry over to future sessions.
export class RuleBook {
  private rules: string[] = [];

  constructor(private file: string) {
    if (existsSync(file)) {
      try {
        const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
        this.rules = Array.isArray(saved) ? saved.filter((rule): rule is string => typeof rule === "string") : [];
      } catch {
        this.rules = [];
      }
    }
  }

  list(): string[] {
    return [...this.rules];
  }

  add(rule: string): void {
    this.rules.push(rule);
    this.save();
  }

  clear(): void {
    this.rules = [];
    this.save();
  }

  asPrompt(): string {
    if (this.rules.length === 0) return "";
    return `\n\nStanding rules from the operator (always follow):\n${this.rules.map((r) => `- ${r}`).join("\n")}`;
  }

  private save(): void {
    writeJsonAtomic(this.file, this.rules);
  }
}
