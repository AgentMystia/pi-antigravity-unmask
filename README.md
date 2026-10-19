# pi-antigravity-unmask

[中文文档](README.zh-CN.md)

A [Pi coding agent](https://github.com/earendil-works/pi) extension that stops `pi-antigravity` provider responses from dying mid-stream with:

```
Error: Provider stopped with: PROHIBITED_CONTENT
```

When the Antigravity backend cuts a response short, the partial output that already streamed is normally **dropped from the conversation entirely** (pi-antigravity skips assistant messages marked `stopReason: "error"` when building the next request) and the agent turn fails. This extension treats the masked stop as a normal finish instead: the salvaged output stays in context, and the reply continues seamlessly from where it stopped.

Companion to [pi-antigravity](https://github.com/Rahularya01/pi-antigravity) — it wraps that provider without modifying it, so provider updates never conflict.

## How it works

- On `session_start`, the extension reads the `streamSimple` handler pi-antigravity registered and re-registers the provider with a wrapped copy. Pi's `registerProvider` merges fields, so only the stream handler is replaced — models, OAuth accounts, and model refresh are untouched.
- The wrapper passes every event through unchanged while the stream is healthy.
- When a masked `error` event arrives (`rawStopReason` matching the configured stops), the accumulated partial message is demoted to a regular assistant turn (error fields stripped so it survives transcript conversion), a short user continuation prompt is appended, and the request is re-issued.
- Continuation deltas are remapped into the same message — continuation text merges into the trailing text block, so the UI just sees one reply that keeps growing. Usage from every segment is summed.
- The stream then ends with a normal `done` event and the agent loop continues as if nothing happened.

## Install

Requires [pi](https://github.com/earendil-works/pi) with the [pi-antigravity](https://github.com/Rahularya01/pi-antigravity) provider installed and logged in.

```bash
pi install npm:pi-antigravity-unmask
```

Restart pi (or start a new session). Verify with:

```
/unmask.status
```

Expected output:

```
provider=antigravity
registered=yes
wrapActive=true
stops=PROHIBITED_CONTENT
maxContinuations=5
```

## Configuration

| Environment variable | Default | Meaning |
|---|---|---|
| `PI_UNMASK_STOPS` | `PROHIBITED_CONTENT` | Comma-separated provider stop reasons to intercept (e.g. add `SAFETY`). |
| `PI_UNMASK_MAX_CONTINUATIONS` | `5` | Max automatic continuation requests per response. |

## Behavior boundaries

- Truncations that already contain tool calls are **not** auto-continued (a re-issued request tends to duplicate the calls); they finish normally and go through the regular tool flow.
- Two consecutive attempts that produce zero output stop retrying and surface the original error — that indicates the request itself is hard-blocked, not a mid-stream cut.
- Non-masked failures (network, quota, auth) and aborts pass through untouched.
- Repeated `session_start` (resume, reload) never stacks wrappers.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # 19 assertions: passthrough, merge, remap, usage, idempotency, budget
```

The test suite loads the TypeScript extension through jiti against the real `pi-ai` event stream implementation — no pi process needed.

## License

[MIT](LICENSE)
