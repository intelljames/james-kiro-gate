# Tool Call Debugging Knowhow

## Scope

This note captures the concrete debugging workflow and root causes found while investigating the OpenAI -> Kiro multi-turn tool-call regression in KiroGate.

The failure pattern was:

- the user sends a new message
- the compiled payload contains that message
- the model replies to the previous message anyway

## Where To Look

The live process is managed by PM2, so the authoritative logs are:

- `/Users/wangchang/.pm2/logs/kirogate-out.log`
- `/Users/wangchang/.pm2/logs/kirogate-error.log`

The repo-local `kirogate.out` and `kirogate.err` files are not the primary source when PM2 is running the service.

## Minimum Logging Needed

Enable both flags before reproducing:

- `DEBUG_KIRO_PAYLOAD=true`
- `DEBUG_KIRO_FULL_PAYLOAD=true`

Restart with:

```bash
pm2 restart kirogate --update-env
```

Useful log lines per OpenAI request id:

- `OpenAI ingress id=...`
- `Payload`
- `PayloadFull`
- `KiroAPI Request debug requestID=...`
- `OpenAI egress id=...`
- `OpenAI egress preview id=...`

For Claude requests, the added deep-debug path is `PayloadFull`; there is no matching `Claude egress preview` log today.

## How To Read A Failing Turn

For one `oa-...` request id, compare three things:

1. The raw OpenAI request tail in `PayloadFull.requestBody.messages`
2. The compiled Kiro payload in `PayloadFull.kiroPayload`
3. The final model output in `OpenAI egress preview`

The key question is always:

- which user message is the latest one in the raw request?
- which user message is the last semantic anchor in Kiro history?
- which user message does the response preview actually talk about?

## Root Causes We Confirmed

### 1. Empty tool-result user turns were not upstream-compatible

Bad shape:

- history user turn with `toolResults`
- `content === ''`

Observed effect:

- upstream handling became unstable during tool continuation

Fix:

- rewrite empty tool-result user content to `Tool results provided.`

Relevant files:

- `lib/kiroApi.ts`
- `lib/kiroCompiler.ts`

### 2. Terminal tool results were being moved into history when they should stay in current

Bad shape:

- OpenAI request ends with `assistant(tool_calls) -> tool`
- no new natural user continuation text
- compiler moved tool results into history
- current became only injected prompt text

Observed effect:

- upstream treated the next turn as a fresh prompt instead of a continuation of the tool loop

Fix:

- only split current tool results into history when there is real continuation text or images after the tool results
- otherwise keep tool results on `currentMessage.userInputMessage.userInputMessageContext.toolResults`

Relevant file:

- `lib/kiroCompiler.ts`

### 3. Latest plain user turn was only present in current, not mirrored into history

This turned out to be the decisive bug for the "always replies to the previous message" symptom.

Bad shape:

- history ended with:
  - previous user message
  - assistant reply to that previous user message
- latest user message existed only in `currentMessage`

Observed effect:

- Kiro consistently anchored on the last user turn in history
- the model answered the previous user message instead of the newest one

Concrete reproduced pattern:

- previous user: `为什么不包装成 skill  让 agent 自己写代码?`
- latest user: `你研究一下现在 的 skill`
- final response still explained the previous `skill` question

Fix:

- when prior turns exist, the current input is a plain user turn, and the last historical turn is an assistant turn, mirror that latest plain user turn into history as the last user anchor
- do not apply this rule to tool-result continuations

Relevant file:

- `lib/kiroCompiler.ts`

## Practical Debugging Workflow

### Step 1: Reproduce on one request id

Do not mix multiple parallel OpenCode sessions. Pick a single `oa-...` id and follow only that chain.

### Step 2: Verify raw request really contains the new user message

Use `PayloadFull` and inspect the last `user` entry.

If the new message is not there, the bug is upstream from KiroGate.

If it is there, continue.

### Step 3: Verify whether the newest user message is the last semantic user anchor in compiled history

Inspect:

- `kiroPayload.conversationState.history`
- `kiroPayload.conversationState.currentMessage.userInputMessage`

If history still ends on the previous user turn while current contains the latest message, Kiro may answer the previous message.

### Step 4: Verify whether the wrong answer comes from Kiro or from our stream conversion

Inspect `OpenAI egress preview id=...`.

If the preview already contains the wrong semantic answer, the problem is before or inside Kiro response generation.

If the preview is correct but the client sees the wrong text, the bug is in OpenAI SSE conversion.

In this incident, the wrong semantic answer was already present in `OpenAI egress preview`, so the fault was not downstream display corruption.

## Useful One-Off Checks

Show the latest request ids and previews:

```bash
grep "OpenAI ingress id=\|OpenAI egress preview id=" /Users/wangchang/.pm2/logs/kirogate-out.log
```

Inspect a single request payload deeply:

```bash
python - <<'PY'
from pathlib import Path
import json, re

request_id = 'oa-EXAMPLE'
path = Path('/Users/wangchang/.pm2/logs/kirogate-out.log')
line = next(l for l in path.read_text(errors='replace').splitlines() if f'PayloadFull] OpenAI id={request_id} ' in l)
obj = json.loads(re.search(r'PayloadFull\] OpenAI id=' + re.escape(request_id) + r' (\{.*\})$', line).group(1))
print(obj['requestBody']['messages'][-4:])
print(obj['kiroPayload']['conversationState']['history'][-4:])
print(obj['kiroPayload']['conversationState']['currentMessage'])
PY
```

## Regression Coverage Added

Key regression tests live in:

- `lib/kiroCompiler_test.ts`
- `lib/translator_test.ts`
- `lib/gateway_integration_test.ts`
- `lib/http_handlers_test.ts`

Most important cases:

- tool-result-only turns stay non-empty
- terminal tool results stay in current when there is no continuation text
- latest plain user turn is mirrored into history when prior turns exist
- payload and response preview logging stay available for future incidents

## Summary

The reliable way to debug this class of bug is:

1. isolate one `oa-...` chain
2. compare raw request tail vs compiled Kiro history/current
3. check the final egress preview to see whether Kiro already answered the wrong message

The final bug was not missing transport of the latest user text. The latest user text reached `current`, but because the latest plain user turn was not mirrored into history, Kiro anchored on the previous user turn and replied to the previous message.
