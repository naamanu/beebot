import type { CommandContext } from "./types.ts";

// Context belongs to the browser tab. Freeze it when speech starts so a task
// switch while the transcript is arriving cannot redirect that spoken turn.
export class OperatorInput {
  focused: string | null = null;
  context: CommandContext = { template: "general", attachments: [], plan: true, taskId: null, uploading: false };
  private turn: { focused: string | null; context: CommandContext } | null = null;

  beginVoiceTurn(): void {
    this.turn = { focused: this.focused, context: structuredClone(this.context) };
  }

  endVoiceTurn(): { focused: string | null; context: CommandContext } {
    const turn = this.turn ?? { focused: this.focused, context: structuredClone(this.context) };
    this.turn = null;
    return turn;
  }
}
