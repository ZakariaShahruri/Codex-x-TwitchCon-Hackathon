import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventBus } from "../../shared/bus.js";
import { loadConfig } from "../../shared/config.js";
import type { EventMap } from "../../shared/events.js";
import { detectCustomRules } from "../detectors/index.js";
import type { OCRTextLine } from "../ocr/types.js";
import { createWatchlistService } from "../watchlist/service.js";
import { compileRule } from "./compiler.js";
import { listenForRuleCompiles } from "./handler.js";
import { validateDraft, type RuleDraft } from "./validate.js";

function line(text: string): OCRTextLine {
  let x = 0;
  const words = text.split(/\s+/u).map((word) => {
    const box = { x, y: 10, w: word.length * 10, h: 12 };
    x += box.w + 4;
    return { text: word, box };
  });
  return { text, box: { x: 0, y: 10, w: x, h: 12 }, words };
}

const momRule: RuleDraft = {
  supported: true, reason: "", description: "your mom's name",
  terms: ["Rosalind Achterberg", "Rosalind"], patterns: [],
  positiveExamples: ["Rosalind Achterberg sent you a message", "call Rosalind later", "Gift for Rosalind Achterberg"],
  negativeExamples: ["Rosa sent you a message", "Achtung baby", "call the bank later"],
};
const studentIdRule: RuleDraft = {
  supported: true, reason: "", description: "your student ID",
  terms: [], patterns: ["\\br\\d{7}\\b"],
  positiveExamples: ["Student: r1021440", "login r7654321 failed", "ID r0000001"],
  negativeExamples: ["r102144", "rr1021440x", "room 1021440"],
};

test("valid drafts become rules; the detector masks only the matched words", () => {
  const mom = validateDraft(momRule);
  assert.ok("rule" in mom);
  const observation = line("New message from Rosalind Achterberg about dinner");
  const [hit] = detectCustomRules([observation], [{ ...mom.rule, id: "r1" }]);
  assert.ok(hit);
  assert.equal(hit.kind, "custom_rule");
  assert.equal(hit.preview, "rule: your mom's name");
  assert.equal(hit.box.x, observation.words[3]!.box.x);
  assert.equal(hit.box.x + hit.box.w, observation.words[4]!.box.x + observation.words[4]!.box.w);

  const id = validateDraft(studentIdRule);
  assert.ok("rule" in id);
  assert.equal(detectCustomRules([line("Logged in as r1021440 today")], [{ ...id.rule, id: "r2" }]).length, 1);
  assert.equal(detectCustomRules([line("Room 1021440")], [{ ...id.rule, id: "r2" }]).length, 0);
});

test("validation rejects unsafe, broad, leaky or self-contradicting drafts", () => {
  const cases: Array<[Partial<RuleDraft>, RegExp]> = [
    [{ supported: false, reason: "Twitchy can't see faces." }, /faces/],
    [{ terms: [], patterns: [] }, /no phrases or patterns/],
    [{ terms: [], patterns: ["(a+)+$"] }, /freeze/],
    [{ terms: [], patterns: ["(\\w*)*x"] }, /freeze/],
    [{ terms: [], patterns: ["("] }, /not a valid/],
    [{ terms: [], patterns: ["x*"] }, /empty text/],
    [{ terms: ["the"], positiveExamples: ["the cat", "the dog"], negativeExamples: ["a cat", "a dog"] }, /too broad/],
    [{ terms: [], patterns: ["\\w+"] }, /description repeats|catches one of its own|too broad/],
    [{ description: "Rosalind Achterberg" }, /description repeats/],
    [{ positiveExamples: ["nothing to see"] }, /at least two/],
    [{ positiveExamples: ["call Rosalind later", "nothing here at all"] }, /does not catch/],
    [{ ...studentIdRule, negativeExamples: ["login r7654321 failed", "fine"] }, /catches one of its own examples to leave alone/],
    [{ terms: ["Settings"], positiveExamples: ["Settings saved", "Open Settings"], negativeExamples: ["Saved", "Open"] }, /too broad/],
  ];
  for (const [change, expected] of cases) {
    const result = validateDraft({ ...momRule, ...change });
    assert.ok("error" in result, JSON.stringify(change));
    assert.match(result.error, expected, JSON.stringify(change));
  }
});

function fakeOpenAI(drafts: RuleDraft[], seen: unknown[] = []): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)));
    const draft = drafts.shift();
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draft) } }] }), { status: 200 });
  }) as typeof fetch;
}

test("compiler retries once with the validation error, then succeeds", async () => {
  const seen: Array<{ model: string; messages: Array<{ role: string; content: string }>; response_format: { type: string } }> = [];
  const result = await compileRule("hide my mom's name, Rosalind Achterberg", {
    apiKey: "test-key", model: "test-model", fetch: fakeOpenAI([{ ...momRule, description: "Rosalind" }, momRule], seen),
  });
  assert.ok("rule" in result);
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.model, "test-model");
  assert.equal(seen[0]!.response_format.type, "json_schema");
  assert.match(seen[1]!.messages.at(-1)!.content, /description repeats/);

  // The streamer's own phrases may appear in an example to leave alone; the retry quotes a failing example to the model.
  assert.ok("rule" in validateDraft({ ...momRule, negativeExamples: ["Rosalind is a character in the book", "fine"] }));
  const retried: typeof seen = [];
  await compileRule("hide my student ID", {
    apiKey: "k", model: "m", fetch: fakeOpenAI([{ ...studentIdRule, negativeExamples: ["login r7654321 failed", "fine"] }, studentIdRule], retried),
  });
  assert.match(retried[1]!.messages.at(-1)!.content, /leave alone \("login r7654321 failed"\)/);
});

test("compiler errors are readable and never contain the key or the rule text", async () => {
  const text = "hide Rosalind Achterberg";
  assert.match(("error" in (await compileRule(text, { apiKey: undefined, model: "m" })) ? (await compileRule(text, { apiKey: undefined, model: "m" }) as { error: string }).error : ""), /OPENAI_API_KEY/);
  for (const status of [401, 429, 500]) {
    const result = await compileRule(text, {
      apiKey: "sk-secret-test", model: "m", fetch: (async () => new Response("{\"error\":\"sk-secret-test\"}", { status })) as typeof fetch,
    });
    assert.ok("error" in result);
    assert.doesNotMatch(result.error, /sk-secret-test|Rosalind/);
  }
  const broke = await compileRule(text, {
    apiKey: "k", model: "m",
    fetch: (async () => new Response(JSON.stringify({ error: { type: "insufficient_quota", code: "credit_balance_exhausted" } }), { status: 429 })) as typeof fetch,
  });
  assert.ok("error" in broke);
  assert.match(broke.error, /no credits/);
  const unsafe = await compileRule(text, { apiKey: "k", model: "m", fetch: fakeOpenAI([{ ...momRule, patterns: ["(a+)+"] }, { ...momRule, patterns: ["(a+)+"] }]) });
  assert.ok("error" in unsafe);
  assert.match(unsafe.error, /couldn't make a safe rule/);
  assert.doesNotMatch(unsafe.error, /Rosalind/);
});

test("handler saves the rule privately, publishes only its summary, and removal works", async () => {
  const folder = await mkdtemp(join(tmpdir(), "twitchy-rules-"));
  const file = join(folder, "private.json");
  const bus = new EventBus();
  const compiled: Array<EventMap["rules.compiled"]> = [];
  const states: Array<EventMap["private.state"]> = [];
  const answered = new Promise<void>((resolve) => bus.on("rules.compiled", (payload) => { compiled.push(payload); resolve(); }));
  bus.on("private.state", (payload) => { states.push(payload); });
  const service = await createWatchlistService(bus, file);
  const config = await loadConfig({ envPath: "/missing/twitchy-test.env" });
  const stop = listenForRuleCompiles(bus, config, service, async () => validateDraft(momRule));
  try {
    bus.emit("rules.compile", { requestId: "req-1", text: "hide my mom's name, Rosalind Achterberg" });
    await answered;
    assert.equal(compiled[0]?.ok, true);
    assert.deepEqual(compiled[0]?.rules?.map(({ description, detector }) => ({ description, detector })), [{ description: "your mom's name", detector: "2 phrases" }]);
    assert.equal(service.rules.length, 1);
    assert.doesNotMatch(JSON.stringify([compiled, states]), /Rosalind/);
    assert.equal(states.at(-1)?.rules.length, 1);
    assert.match(await readFile(file, "utf8"), /Rosalind Achterberg/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);

    const reopened = await createWatchlistService(new EventBus(), file);
    assert.equal(reopened.rules.length, 1);
    await reopened.stop();

    bus.emit("config.updated", { removedRuleIds: [service.rules[0]!.id] });
    await service.flush();
    assert.equal(service.rules.length, 0);
    assert.deepEqual(states.at(-1)?.rules, []);
  } finally {
    stop();
    await service.stop();
    await rm(folder, { recursive: true, force: true });
  }
});

test("handler refuses a second compile while one runs", async () => {
  const bus = new EventBus();
  const compiled: Array<EventMap["rules.compiled"]> = [];
  bus.on("rules.compiled", (payload) => { compiled.push(payload); });
  const config = await loadConfig({ envPath: "/missing/twitchy-test.env" });
  let finish!: () => void;
  const stop = listenForRuleCompiles(bus, config, { addRule: async (rule) => ({ id: "x", ...rule }) },
    () => new Promise((resolve) => { finish = () => resolve(validateDraft(momRule)); }));
  bus.emit("rules.compile", { requestId: "a", text: "one" });
  bus.emit("rules.compile", { requestId: "b", text: "two" });
  assert.deepEqual(compiled.map(({ requestId, ok }) => [requestId, ok]), [["b", false]]);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(compiled.map(({ requestId, ok }) => [requestId, ok]), [["b", false], ["a", true]]);
  stop();
});
