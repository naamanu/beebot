import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// A short, scannable title for the task list ("Q4 sales forecast"), from the
// operator's own words. Falls back to null on any error; the caller keeps
// the first sentence of the request instead.
export async function shortTitle(request: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await client.messages.create({
      model: process.env.ROUTER_MODEL || "claude-haiku-5-5",
      max_tokens: 200,
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content: `Write a title of 2 to 6 words for this task, for a task list. Sentence case, no quotes, no trailing period. Reply with the title only.\n\n<task>${request.slice(0, 2000)}</task>`,
        },
      ],
    }, { signal, timeout: 10_000, maxRetries: 0 });
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    return text && text.length <= 60 ? text.replace(/^["“]|["”.]$/g, "") : null;
  } catch {
    return null;
  }
}
