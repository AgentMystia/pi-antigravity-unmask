/**
 * pi-antigravity-unmask — treat provider-side content stops as a normal finish.
 *
 * The Antigravity provider (pi-antigravity) sometimes terminates a response
 * mid-stream with `Error: Provider stopped with: PROHIBITED_CONTENT`. Two
 * things then go wrong:
 *
 *   1. The partial output already streamed is dropped from subsequent requests:
 *      pi-antigravity skips assistant messages whose `stopReason` is `"error"`
 *      when converting the transcript, so the salvageable text never re-enters
 *      the model context.
 *   2. The agent loop treats the stop as a hard failure and ends the turn.
 *
 * This extension wraps the provider's registered `streamSimple` handler and
 * turns masked stops into a normal finish:
 *
 *   - When a masked `error` event arrives, the accumulated partial message is
 *     demoted to a regular assistant turn (error fields stripped, so it stays
 *     in context), a short user continuation prompt is appended, and the
 *     request is re-issued.
 *   - Continuation deltas are remapped into the same message (text merges into
 *     the trailing text block), so the UI sees one message that keeps growing.
 *   - The stream then completes with a normal `done` event; usage from every
 *     segment is summed. Non-masked failures (network, quota, auth) and aborts
 *     pass through untouched.
 *
 * The wrapper is installed on `session_start` by re-registering the provider:
 * pi's `registerProvider` merges fields, so only the stream handler is
 * replaced — models, OAuth accounts, and model refresh from pi-antigravity are
 * preserved, and the pi-antigravity package itself is never modified.
 *
 * Configuration (environment variables):
 *   PI_UNMASK_STOPS              Comma-separated stop reasons to intercept
 *                                (default: PROHIBITED_CONTENT).
 *   PI_UNMASK_MAX_CONTINUATIONS  Max auto-continuations per response (default 5).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";

/** pi-antigravity's fixed provider id (PROVIDER_ID in its src/models/models.ts). */
const ANTIGRAVITY_PROVIDER = "antigravity";

/** Fallback api id only used if the registered config does not carry one. */
const FALLBACK_API = "antigravity-api" as Api;

const DEFAULT_STOPS = ["PROHIBITED_CONTENT"];

const CONTINUE_PROMPT =
  "[continue] Your previous reply was cut off mid-text by a transient stop. " +
  "Resume exactly where it stopped. Do not repeat or re-summarize content already written.";

/** Identity marker preventing double wrapping across repeated session_start. */
const WRAP_TAG = Symbol.for("antigravity-unmask.wrapped");

type StreamSimpleFn = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

interface FinalOutcome {
  kind: "done" | "error";
  message: AssistantMessage;
}

function configuredStops(): string[] {
  const raw = process.env.PI_UNMASK_STOPS;
  if (!raw) return DEFAULT_STOPS;
  return raw
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
}

function configuredMaxContinuations(): number {
  const value = Number(process.env.PI_UNMASK_MAX_CONTINUATIONS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 5;
}

/** True when a finalized message carries one of the configured masked stop reasons. */
function isMaskedStop(message: AssistantMessage): boolean {
  if (message.stopReason !== "error") return false;
  const stops = configuredStops();
  const raw = (message.rawStopReason ?? "").trim().toUpperCase();
  if (raw && stops.includes(raw)) return true;
  const errorText = message.errorMessage ?? "";
  return stops.some((stop) => errorText.includes(stop));
}

function hasVisibleContent(message: AssistantMessage): boolean {
  return message.content.some(
    (block) =>
      (block.type === "text" && block.text.trim().length > 0) ||
      (block.type === "thinking" && block.thinking.trim().length > 0) ||
      block.type === "toolCall",
  );
}

function hasToolCall(message: AssistantMessage): boolean {
  return message.content.some((block) => block.type === "toolCall");
}

function indexMapHasValue(map: Map<number, number>, value: number): boolean {
  for (const mapped of map.values()) if (mapped === value) return true;
  return false;
}

/**
 * Strip error traces so the message survives pi-antigravity's transcript
 * conversion and can continue the conversation as a normal assistant turn.
 */
function demoteError(message: AssistantMessage): void {
  message.stopReason = "stop";
  delete message.errorMessage;
  delete message.rawStopReason;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(base: Usage, extra?: Usage): Usage {
  if (!extra) return base;
  const sum = (a?: number, b?: number) => (a ?? 0) + (b ?? 0);
  const usage: Usage = {
    input: sum(base.input, extra.input),
    output: sum(base.output, extra.output),
    cacheRead: sum(base.cacheRead, extra.cacheRead),
    cacheWrite: sum(base.cacheWrite, extra.cacheWrite),
    totalTokens: sum(base.totalTokens, extra.totalTokens),
    cost: {
      input: sum(base.cost?.input, extra.cost?.input),
      output: sum(base.cost?.output, extra.cost?.output),
      cacheRead: sum(base.cost?.cacheRead, extra.cost?.cacheRead),
      cacheWrite: sum(base.cost?.cacheWrite, extra.cost?.cacheWrite),
      total: sum(base.cost?.total, extra.cost?.total),
    },
  };
  if (base.reasoning !== undefined || extra.reasoning !== undefined)
    usage.reasoning = sum(base.reasoning, extra.reasoning);
  return usage;
}

function freshErrorMessage(model: Model<Api>, errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}

/** TranscriptContext is branded; at runtime it is a plain object with messages. */
function withMessages(context: TranscriptContext, messages: Message[]): TranscriptContext {
  return { ...context, messages } as TranscriptContext;
}

function finalizeAs(
  acc: AssistantMessage,
  stopReason: AssistantMessage["stopReason"] = hasToolCall(acc) ? "toolUse" : "stop",
  errorMessage?: string,
): AssistantMessage {
  const message = structuredClone(acc);
  message.stopReason = stopReason;
  if (errorMessage !== undefined) message.errorMessage = errorMessage;
  else delete message.errorMessage;
  return message;
}

function pushFinal(out: AssistantMessageEventStream, outcome: FinalOutcome): void {
  if (outcome.kind === "done") {
    out.push({
      type: "done",
      reason: outcome.message.stopReason as "stop" | "length" | "toolUse" | "deferred",
      message: outcome.message,
    });
  } else {
    out.push({ type: "error", reason: "error", error: outcome.message });
  }
  out.end();
}

/**
 * First segment: forward every event unchanged; the terminal event is handed
 * back to the caller, which decides whether it is masked and intercepted.
 */
async function forwardPassthrough(
  stream: AssistantMessageEventStream,
  out: AssistantMessageEventStream,
  model: Model<Api>,
): Promise<FinalOutcome> {
  for await (const event of stream) {
    if (event.type === "done" || event.type === "error") {
      return { kind: event.type, message: event.type === "done" ? event.message : event.error };
    }
    out.push(event);
  }
  // Unreachable per protocol (a stream must terminate with done/error);
  // synthesize an error so consumers never hang.
  return { kind: "error", message: freshErrorMessage(model, "stream ended without a final event") };
}

/**
 * Continuation segment: merge incremental events into `acc`. Content indexes
 * are remapped onto the merged message, and every forwarded event carries a
 * snapshot of `acc` as `partial`, so upstream sees one message still growing.
 *
 * The first same-typed block of the continuation folds into the trailing
 * block of `acc` (prefix preserved), producing one seamless text run instead
 * of two adjacent fragments.
 */
async function forwardMapped(
  stream: AssistantMessageEventStream,
  out: AssistantMessageEventStream,
  acc: AssistantMessage,
): Promise<FinalOutcome> {
  const indexMap = new Map<number, number>();
  // A reused trailing block keeps its original text; text_end.content only
  // covers the continuation segment, so the prefix must be re-attached.
  const prefixMap = new Map<number, string>();
  const snap = (): AssistantMessage => ({ ...acc });

  const takeBlock = (type: "text" | "thinking"): { index: number; prefix: string } => {
    const last = acc.content[acc.content.length - 1];
    if (last && last.type === type && !indexMapHasValue(indexMap, acc.content.length - 1)) {
      return {
        index: acc.content.length - 1,
        prefix: type === "text" ? (last as TextContent).text : (last as ThinkingContent).thinking,
      };
    }
    const index =
      acc.content.push(type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" }) - 1;
    return { index, prefix: "" };
  };

  for await (const event of stream) {
    switch (event.type) {
      case "start":
        // The opening start was already forwarded with the first segment;
        // swallow it here so upstream does not open a second message.
        continue;
      case "text_start": {
        const { index, prefix } = takeBlock("text");
        indexMap.set(event.contentIndex, index);
        prefixMap.set(index, prefix);
        out.push({ type: "text_start", contentIndex: index, partial: snap() });
        break;
      }
      case "text_delta": {
        const mapped = indexMap.get(event.contentIndex);
        if (mapped === undefined) break;
        (acc.content[mapped] as TextContent).text += event.delta;
        out.push({ type: "text_delta", contentIndex: mapped, delta: event.delta, partial: snap() });
        break;
      }
      case "text_end": {
        const mapped = indexMap.get(event.contentIndex);
        if (mapped === undefined) break;
        (acc.content[mapped] as TextContent).text = (prefixMap.get(mapped) ?? "") + event.content;
        out.push({ type: "text_end", contentIndex: mapped, content: event.content, partial: snap() });
        break;
      }
      case "thinking_start": {
        const { index, prefix } = takeBlock("thinking");
        indexMap.set(event.contentIndex, index);
        prefixMap.set(index, prefix);
        out.push({ type: "thinking_start", contentIndex: index, partial: snap() });
        break;
      }
      case "thinking_delta": {
        const mapped = indexMap.get(event.contentIndex);
        if (mapped === undefined) break;
        (acc.content[mapped] as ThinkingContent).thinking += event.delta;
        out.push({ type: "thinking_delta", contentIndex: mapped, delta: event.delta, partial: snap() });
        break;
      }
      case "thinking_end": {
        const mapped = indexMap.get(event.contentIndex);
        if (mapped === undefined) break;
        (acc.content[mapped] as ThinkingContent).thinking = (prefixMap.get(mapped) ?? "") + event.content;
        out.push({ type: "thinking_end", contentIndex: mapped, content: event.content, partial: snap() });
        break;
      }
      case "toolcall_start": {
        const index = acc.content.push({ type: "toolCall", id: "", name: "", arguments: {} }) - 1;
        indexMap.set(event.contentIndex, index);
        out.push({ type: "toolcall_start", contentIndex: index, partial: snap() });
        break;
      }
      case "toolcall_delta": {
        const mapped = indexMap.get(event.contentIndex);
        if (mapped === undefined) break;
        out.push({ type: "toolcall_delta", contentIndex: mapped, delta: event.delta, partial: snap() });
        break;
      }
      case "toolcall_end": {
        const mapped = indexMap.get(event.contentIndex);
        if (mapped === undefined) break;
        acc.content[mapped] = event.toolCall as ToolCall;
        out.push({ type: "toolcall_end", contentIndex: mapped, toolCall: event.toolCall, partial: snap() });
        break;
      }
      case "done":
      case "error":
        return { kind: event.type, message: event.type === "done" ? event.message : event.error };
    }
  }
  // Unreachable per protocol; same fallback as forwardPassthrough.
  return {
    kind: "error",
    message: finalizeAs(acc, "error", "continuation stream ended without a final event"),
  };
}

async function drive(
  original: StreamSimpleFn,
  out: AssistantMessageEventStream,
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  notify: (text: string) => void,
): Promise<void> {
  // Segment 1: pass through untouched and inspect the terminal event.
  const firstOutcome = await forwardPassthrough(original(model, context, options), out, model);

  if (firstOutcome.kind === "done" || !isMaskedStop(firstOutcome.message)) {
    pushFinal(out, firstOutcome);
    return;
  }

  // Masked stop: keep evolving one accumulated message from here on.
  const acc = structuredClone(firstOutcome.message);
  demoteError(acc);
  const stopLabel = (firstOutcome.message.rawStopReason ?? "masked").toUpperCase();
  notify(`antigravity-unmask: ${stopLabel} intercepted; salvaging partial output`);

  const budget = configuredMaxContinuations();
  let continuations = 0;

  while (true) {
    if (options?.signal?.aborted) {
      pushFinal(out, { kind: "error", message: finalizeAs(acc, "aborted") });
      return;
    }
    // Do not auto-continue a truncation that already carries tool calls:
    // a re-issued request tends to duplicate them; leave them to the normal
    // tool flow instead.
    if (hasToolCall(acc)) break;
    if (continuations >= budget) break;
    // Two consecutive zero-output attempts mean the request itself is hard
    // blocked; re-trying is pointless, so surface the original error.
    if (!hasVisibleContent(acc) && continuations >= 1) {
      pushFinal(out, firstOutcome);
      return;
    }
    continuations++;

    const nextMessages: Message[] = [...context.messages];
    if (hasVisibleContent(acc)) nextMessages.push(structuredClone(acc));
    nextMessages.push({ role: "user", content: CONTINUE_PROMPT, timestamp: Date.now() });

    const inner = original(model, withMessages(context, nextMessages), options);
    const outcome = await forwardMapped(inner, out, acc);

    if (outcome.kind === "done") {
      acc.usage = addUsage(acc.usage, outcome.message.usage);
      if (outcome.message.responseModel) acc.responseModel = outcome.message.responseModel;
      if (outcome.message.responseId) acc.responseId = outcome.message.responseId;
      pushFinal(out, { kind: "done", message: finalizeAs(acc, outcome.message.stopReason) });
      return;
    }
    if (!isMaskedStop(outcome.message)) {
      acc.usage = addUsage(acc.usage, outcome.message.usage);
      pushFinal(out, {
        kind: "error",
        message: finalizeAs(acc, "error", outcome.message.errorMessage),
      });
      return;
    }
    // Masked again: strip the error traces and keep going.
    demoteError(acc);
    notify(`antigravity-unmask: ${stopLabel} again (${continuations}/${budget}); continuing`);
  }

  // Budget exhausted or continuation unsuitable: finish normally with the
  // salvaged content instead of failing the turn.
  pushFinal(out, { kind: "done", message: finalizeAs(acc) });
}

/** Wrap a streamSimple handler with interception; tags itself for idempotency. */
function wrapStreamSimple(original: StreamSimpleFn, notify: (text: string) => void): StreamSimpleFn {
  const wrapped: StreamSimpleFn = (model, context, options) => {
    const out = createAssistantMessageEventStream();
    drive(original, out, model, context, options, notify).catch((error: unknown) => {
      // Driver failure must not hang consumers: degrade to an error event.
      const text = error instanceof Error ? error.message : String(error);
      const message = freshErrorMessage(model, `antigravity-unmask internal error: ${text}`);
      out.push({ type: "error", reason: "error", error: message });
      out.end();
    });
    return out;
  };
  (wrapped as { [WRAP_TAG]?: boolean })[WRAP_TAG] = true;
  return wrapped;
}

export default function antigravityUnmask(pi: ExtensionAPI): void {
  let notify: (text: string) => void = () => {};
  const state = { wrapped: false };

  pi.registerCommand("unmask.status", {
    description: "Show antigravity-unmask (PROHIBITED_CONTENT interceptor) state",
    handler: async (_args, ctx) => {
      const config = ctx.modelRegistry.getRegisteredProviderConfig(ANTIGRAVITY_PROVIDER);
      const lines = [
        `provider=${ANTIGRAVITY_PROVIDER}`,
        `registered=${config ? "yes" : "no (pi-antigravity not loaded)"}`,
        `wrapActive=${state.wrapped}`,
        `stops=${configuredStops().join(",")}`,
        `maxContinuations=${configuredMaxContinuations()}`,
      ];
      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
      else console.log(lines.join("\n"));
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      notify = (text) => {
        try {
          ctx.ui.notify(text, "info");
        } catch {
          // Notification failures while the TUI is busy are harmless.
        }
      };
    }

    const config = ctx.modelRegistry.getRegisteredProviderConfig(ANTIGRAVITY_PROVIDER);
    const original = config?.streamSimple as StreamSimpleFn | undefined;
    // pi-antigravity not installed or not registered: stay silent.
    if (!config || !original) return;
    // Already wrapped (session resume / repeated session_start): don't stack.
    if ((original as { [WRAP_TAG]?: boolean })[WRAP_TAG]) {
      state.wrapped = true;
      return;
    }

    // Re-registration merges fields, so only the stream handler is replaced;
    // models, OAuth, and refreshModels from pi-antigravity are preserved.
    // The streamSimple cast bridges the host's bundled pi-ai typings (its
    // branded TranscriptContext) with this package's declared peer types.
    pi.registerProvider(ANTIGRAVITY_PROVIDER, {
      api: (config.api as Api | undefined) ?? FALLBACK_API,
      streamSimple: wrapStreamSimple(original, notify),
    } as unknown as Parameters<ExtensionAPI["registerProvider"]>[1]);
    state.wrapped = true;
  });
}
