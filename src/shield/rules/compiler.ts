import { validateDraft, type RuleDraft, type ValidRule } from "./validate.js";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
/** The dashboard gives up after 15 s; the whole compile, retry included, has to answer before that. */
const DEADLINE_MS = 13_500;

const INSTRUCTIONS = `You turn a streamer's plain-English privacy rule into a deterministic text matcher for Twitchy, which masks text on a live stream before viewers see it. Twitchy reads the screen with OCR, one line at a time, and can only hide visible text.

Return:
- supported: false only if the rule cannot be expressed as text to find on screen (for example, "hide my face"); say why in reason.
- description: a short, friendly summary of what is hidden (max 60 characters), e.g. "your mom's name" or "tracking numbers". It is shown on stream, so it must NEVER contain the private words, names or numbers themselves.
- terms: exact phrases to hide (names, usernames, addresses, codes the streamer wrote out). Include common variants the streamer implies (first name alone, a nickname), but not ordinary words.
- patterns: JavaScript regular expressions (no slashes or flags; matched case-insensitively) for formats rather than fixed values, e.g. a student ID "r" + 7 digits -> "\\br\\d{7}\\b". Keep them specific; never match ordinary words. No nested quantifiers or backreferences.
- positiveExamples: 3 realistic screen lines that must be hidden.
- negativeExamples: 3 realistic, similar-looking screen lines that must stay visible. They must not contain any of the terms.
Use terms or patterns or both; leave the other array empty.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["supported", "reason", "description", "terms", "patterns", "positiveExamples", "negativeExamples"],
  properties: {
    supported: { type: "boolean" },
    reason: { type: "string" },
    description: { type: "string" },
    terms: { type: "array", items: { type: "string" } },
    patterns: { type: "array", items: { type: "string" } },
    positiveExamples: { type: "array", items: { type: "string" } },
    negativeExamples: { type: "array", items: { type: "string" } },
  },
} as const;

export interface CompileOptions {
  apiKey: string | undefined;
  model: string;
  fetch?: typeof fetch;
  now?: () => number;
}

type Message = { role: "system" | "user" | "assistant"; content: string };

async function askModel(messages: Message[], options: CompileOptions, timeoutMs: number): Promise<RuleDraft> {
  const response = await (options.fetch ?? fetch)(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({
      model: options.model,
      messages,
      response_format: { type: "json_schema", json_schema: { name: "twitchy_rule", strict: true, schema: SCHEMA } },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("OpenAI rejected OPENAI_API_KEY (401). Check the key in .env.");
    if (response.status === 429) {
      // Only the error type is read from the body; it never echoes the key or the rule.
      const type = await response.json().then((body: { error?: { type?: unknown } }) => body.error?.type, () => undefined);
      if (type === "insufficient_quota") throw new Error("The OpenAI account has no credits left (429). Add credits on platform.openai.com, then try again.");
      throw new Error("OpenAI rate limit reached (429). Try again in a minute.");
    }
    throw new Error(`OpenAI request failed (HTTP ${response.status}).`);
  }
  const body = await response.json() as { choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }> };
  const message = body.choices?.[0]?.message;
  if (typeof message?.refusal === "string" && message.refusal) throw new Error("The model declined to write this rule.");
  if (typeof message?.content !== "string") throw new Error("OpenAI returned no rule.");
  return JSON.parse(message.content) as RuleDraft;
}

/**
 * Plain English → a validated rule, or a readable error. Runs once per rule, never per frame. The streamer's text goes to
 * OpenAI; nothing here logs it, and errors never contain it or the key. One retry tells the model what failed validation.
 */
export async function compileRule(text: string, options: CompileOptions): Promise<{ rule: ValidRule } | { error: string }> {
  if (!options.apiKey) return { error: "The rules compiler needs OPENAI_API_KEY in .env, then restart Twitchy." };
  const now = options.now ?? Date.now;
  const deadline = now() + DEADLINE_MS;
  const messages: Message[] = [{ role: "system", content: INSTRUCTIONS }, { role: "user", content: text }];
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = deadline - now();
    if (remaining < 2_000) break;
    let draft: RuleDraft;
    try {
      draft = await askModel(messages, options, remaining);
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return { error: "OpenAI took too long to answer. Try again." };
      return { error: error instanceof Error && !(error instanceof SyntaxError) ? error.message : "OpenAI returned an unreadable rule." };
    }
    const result = validateDraft(draft);
    if ("rule" in result || !draft.supported) return result;
    lastError = result.error;
    const example = result.example === undefined ? "" : ` (${JSON.stringify(result.example)})`;
    messages.push({ role: "assistant", content: JSON.stringify(draft) }, { role: "user", content: `That rule failed Twitchy's check: ${result.error}${example}. Fix it and answer again.` });
  }
  return { error: `Twitchy couldn't make a safe rule from that: ${lastError || "out of time"}. Try wording it more specifically.` };
}
