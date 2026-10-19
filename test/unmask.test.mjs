/**
 * pi-antigravity-unmask 逻辑测试(不启动 pi)。
 * 用包内 devDependency 的 jiti 加载 TS 插件本体,alias @earendil-works/pi-ai
 * 到真实包,mock pi-antigravity 的 streamSimple,模拟 PROHIBITED_CONTENT
 * 中断与续写。先 npm install 再跑:npm test
 */
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const JITI = here("../node_modules/jiti/lib/jiti.mjs");
const PI_AI = here("../node_modules/@earendil-works/pi-ai/dist/index.js");
const PLUGIN = here("../src/index.ts");

const { createJiti } = await import(JITI);

const jiti = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-ai": PI_AI },
  interopDefault: true,
});

const { createAssistantMessageEventStream } = await import(PI_AI);
const mod = await jiti.import(PLUGIN);
const factory = mod.default;

const MODEL = {
  id: "gemini-3.8-flash",
  name: "Gemini 3.8 Flash",
  api: "antigravity-api",
  provider: "antigravity",
  baseUrl: "https://example",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function usage(n) {
  return {
    input: 10,
    output: n,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 10 + n,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function baseMessage(extra = {}) {
  return {
    role: "assistant",
    content: [],
    api: "antigravity-api",
    provider: "antigravity",
    model: MODEL.id,
    usage: usage(0),
    stopReason: "stop",
    timestamp: Date.now(),
    ...extra,
  };
}

/** 把一段"剧本"事件推入一条新流并返回。 */
function scriptedStream(events) {
  const s = createAssistantMessageEventStream();
  for (const ev of events) s.push(ev);
  if (!events.some((e) => e.type === "done" || e.type === "error")) s.end();
  return s;
}

const textEvents = (text, offset = 0) => {
  const partials = [];
  const build = (content) => baseMessage({ content });
  const events = [
    { type: "start", partial: build([]) },
    { type: "text_start", contentIndex: offset, partial: build([{ type: "text", text: "" }]) },
  ];
  let acc = "";
  for (const ch of text) {
    acc += ch;
    events.push({
      type: "text_delta",
      contentIndex: offset,
      delta: ch,
      partial: build([{ type: "text", text: acc }]),
    });
  }
  events.push({
    type: "text_end",
    contentIndex: offset,
    content: text,
    partial: build([{ type: "text", text }]),
  });
  return events;
};

async function collect(stream) {
  const events = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail ?? "" });
}

// ---------------------------------------------------------------- harness ---

function installPlugin(script) {
  let sessionStartHandler = null;
  let registered = null;
  const pi = {
    on: (ev, handler) => {
      if (ev === "session_start") sessionStartHandler = handler;
    },
    registerCommand: () => {},
    registerProvider: (name, config) => {
      registered = { name, config };
    },
  };
  factory(pi);
  const ctx = {
    hasUI: false,
    ui: { notify: () => {} },
    modelRegistry: {
      getRegisteredProviderConfig: (name) =>
        name === "antigravity"
          ? { api: "antigravity-api", name: "Antigravity", streamSimple: script, models: [{ id: MODEL.id }] }
          : undefined,
    },
  };
  if (!sessionStartHandler) throw new Error("session_start not registered");
  sessionStartHandler({ type: "session_start" }, ctx);
  return registered;
}

function makeContext(messages = [{ role: "user", content: "hi", timestamp: Date.now() }]) {
  return { messages };
}

// ------------------------------------------------- 场景 A:正常回复透传 ---

{
  const script = () =>
    scriptedStream([
      ...textEvents("hello world"),
      { type: "done", reason: "stop", message: baseMessage({ content: [{ type: "text", text: "hello world" }], usage: usage(5) }) },
    ]);
  const reg = installPlugin(script);
  const out = reg.config.streamSimple(MODEL, makeContext());
  const events = await collect(out);
  const final = events.at(-1);
  check("A 透传 done", final.type === "done" && final.message.content[0].text === "hello world");
  check("A stopReason stop", final.message.stopReason === "stop");
  // start+text_start+11×delta+text_end+done = 15,事件应无损耗透传
  check("A 事件数无损耗", events.length === 15, String(events.length));
}

// ------------------------- 场景 B:中途 PROHIBITED_CONTENT → 自动续写拼接 ---

{
  const calls = [];
  const script = (model, context) => {
    calls.push(context.messages);
    if (calls.length === 1) {
      return scriptedStream([
        ...textEvents("The answer is 4"),
        {
          type: "error",
          reason: "error",
          error: baseMessage({
            content: [{ type: "text", text: "The answer is 4" }],
            stopReason: "error",
            rawStopReason: "PROHIBITED_CONTENT",
            errorMessage: "Provider stopped with: PROHIBITED_CONTENT",
          }),
        },
      ]);
    }
    // 续写段:不带 start 语义也行,drive 会吞 start;给正常文本
    return scriptedStream([
      { type: "start", partial: baseMessage({ content: [] }) },
      ...textEvents("2. Great.", 0),
      { type: "done", reason: "stop", message: baseMessage({ content: [{ type: "text", text: "2. Great." }], usage: usage(3) }) },
    ]);
  };
  const reg = installPlugin(script);
  const out = reg.config.streamSimple(MODEL, makeContext());
  const events = await collect(out);
  const final = events.at(-1);

  check("B 最终 done 而非 error", final.type === "done");
  check(
    "B 文本并入同一 block 无缝拼接",
    final.message.content.length === 1 && final.message.content[0].text === "The answer is 42. Great.",
    JSON.stringify(final.message.content),
  );
  check("B stopReason 正常", final.message.stopReason === "stop");
  check("B errorMessage 清除", final.message.errorMessage === undefined && final.message.rawStopReason === undefined);
  check("B usage 合并", final.message.usage.output === 3);
  const contMessages = calls[1];
  check("B 续写上下文含 partial assistant", contMessages.some((m) => m.role === "assistant" && m.stopReason === "stop" && m.content[0]?.text === "The answer is 4"));
  check("B 续写上下文含 continue user", contMessages.at(-1).role === "user" && contMessages.at(-1).content.includes("[continue]"));
  // 事件流:text_start 应被映射到 contentIndex 1(接在已有 text block 之后)
  const starts = events.filter((e) => e.type === "text_start").map((e) => e.contentIndex);
  check("B contentIndex 重映射(续写并入尾块 0)", JSON.stringify(starts) === "[0,0]", JSON.stringify(starts));
  const deltas = events.filter((e) => e.type === "text_delta");
  check("B 续写 delta partial 含累积全文", deltas.at(-1).partial.content[0].text === "The answer is 42. Great.");
}

// ----------------------- 场景 C:两次零内容 masked → 透传原始 error ---

{
  const calls = [];
  const errEv = () => ({
    type: "error",
    reason: "error",
    error: baseMessage({ stopReason: "error", rawStopReason: "PROHIBITED_CONTENT", errorMessage: "Provider stopped with: PROHIBITED_CONTENT" }),
  });
  const script = (_m, context) => {
    calls.push(context.messages);
    return scriptedStream([{ type: "start", partial: baseMessage({ content: [] }) }, errEv()]);
  };
  const reg = installPlugin(script);
  const out = reg.config.streamSimple(MODEL, makeContext());
  const events = await collect(out);
  const final = events.at(-1);
  check("C 透传原始 error", final.type === "error" && final.error.rawStopReason === "PROHIBITED_CONTENT");
  check("C 只重试一次(共2次调用)", calls.length === 2, String(calls.length));
}

// ----------------- 场景 D:反复 masked 有内容 → 额度尽合成 stop ---
// budget=2:初始段 seg1 + 两次续写 seg2/seg3,第三次 masked 后额度用尽,
// 以已拼内容合成正常 stop(seg4 不会发生)。

{
  process.env.PI_UNMASK_MAX_CONTINUATIONS = "2";
  let n = 0;
  const script = (_m, context) => {
    n++;
    const text = `seg${n} `;
    const msg = baseMessage({
      content: [{ type: "text", text }],
      stopReason: "error",
      rawStopReason: "PROHIBITED_CONTENT",
      errorMessage: "Provider stopped with: PROHIBITED_CONTENT",
    });
    const events = n === 1 ? textEvents(text) : [{ type: "start", partial: baseMessage({ content: [] }) }, ...textEvents(text, 0)];
    events.push({ type: "error", reason: "error", error: msg });
    return scriptedStream(events);
  };
  const reg = installPlugin(script);
  const out = reg.config.streamSimple(MODEL, makeContext());
  const events = await collect(out);
  const final = events.at(-1);
  check(
    "D 额度尽后合成 stop 且内容全保留",
    final.type === "done" && final.message.stopReason === "stop" && final.message.content[0].text === "seg1 seg2 seg3 ",
    JSON.stringify({ type: final.type, stop: final.message.stopReason, text: final.message.content?.[0]?.text }),
  );
  check("D 总调用数 = 1+2 次续写", n === 3, String(n));
  delete process.env.PI_UNMASK_MAX_CONTINUATIONS;
}

// ---------------------- 场景 E:非 masked 网络错误 → 原样透传 ---

{
  const script = () =>
    scriptedStream([
      { type: "start", partial: baseMessage({ content: [] }) },
      { type: "error", reason: "error", error: baseMessage({ stopReason: "error", errorMessage: "Antigravity API error (500): boom" }) },
    ]);
  const reg = installPlugin(script);
  const out = reg.config.streamSimple(MODEL, makeContext());
  const events = await collect(out);
  const final = events.at(-1);
  check("E 非 masked 原样透传", final.type === "error" && final.error.errorMessage.includes("500"));
}

// ------------------------------------- 幂等:二次 session_start 不重复包 ---

{
  let sessionStartHandler = null;
  let registered = [];
  const pi = {
    on: (ev, h) => ev === "session_start" && (sessionStartHandler = h),
    registerCommand: () => {},
    registerProvider: (name, config) => registered.push({ name, config }),
  };
  factory(pi);
  const inner = () => scriptedStream([]);
  let currentConfig = { api: "antigravity-api", streamSimple: inner };
  const ctx = {
    hasUI: false,
    ui: { notify: () => {} },
    modelRegistry: { getRegisteredProviderConfig: () => currentConfig },
  };
  sessionStartHandler({}, ctx);
  check("幂等 首次注册一次", registered.length === 1 && registered[0].name === "antigravity");
  // 模拟 pi 的合并注册:streamSimple 换成 wrapped 后再次 session_start
  currentConfig = { ...currentConfig, streamSimple: registered[0].config.streamSimple };
  sessionStartHandler({}, ctx);
  check("幂等 二次 session_start 不再注册", registered.length === 1, String(registered.length));
}

// ------------------------------------------------------------------ 汇总 ---

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  [" + r.detail + "]" : ""}`);
}
console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
