# Changelog

## Unreleased

### Added
- Added a normalized conversation compiler in `lib/kiroCompiler.ts` to convert OpenAI and Anthropic request histories into a shared Kiro payload shape before transport.
- Added regression coverage for request compilation, gateway compatibility, handler behavior, and upstream API behavior in:
  - `lib/kiroCompiler_test.ts`
  - `lib/translator_test.ts`
  - `lib/gateway_integration_test.ts`
  - `lib/http_handlers_test.ts`
  - `lib/kiroApi_test.ts`
  - `testapi/kiro_api_behavior_test.ts`
- Added `lib/http_handlers.ts` to isolate OpenAI and Anthropic HTTP request handling from `main.ts` for narrower testing.
- Added black-box canary documentation under `testapi/README.md` for validating behavior against the upstream Kiro API.
- Added `TOOL_CALL_DEBUGGING_KNOWHOW.md` documenting the PM2 log workflow, payload inspection method, and confirmed root causes for the OpenAI/Kiro turn-alignment bug.
- Added full payload and response preview debug logging for OpenAI/Claude requests so future reproductions can compare request tails, compiled Kiro history/current state, and final egress text directly.

### Changed
- Reworked OpenAI and Anthropic request translation to use the normalized compiler path instead of ad hoc provider-specific Kiro history shaping.
- Simplified `lib/translator.ts` by removing legacy request-shaping helpers that were superseded by the compiler layer.
- Tightened `lib/kiroApi.ts` payload shaping so empty structural turns stay empty instead of being rewritten into visible placeholder text like `Continue`, `I understand.`, or `understood`.
- Kept tool-loop compatibility while removing semantic placeholder injection from assistant-only tool turns and tool-result turns.
- Adjusted normalized OpenAI compilation so terminal tool results stay on the current turn unless there is real continuation text, and plain latest user turns are mirrored into history when the previous semantic turn is an assistant reply.
- Refactored `callKiroApiStream()` status handling into smaller helpers and a response-decision step for:
  - rate limiting (`429`)
  - auth failures (`401`/`403`)
  - quota exhaustion (`402`)
  - generic bad requests (`400`)
  - content-length retries
  - server-error retries (`5xx`)
- Refactored content-length retry truncation into dedicated helpers with explicit tiered regression coverage.
- Filtered structural empty user separators out of `summarizeKiroPayload()` so payload summaries reflect semantic history instead of transport-only placeholders.

### Fixed
- Fixed the original placeholder-response issue where tool-call and tool-result flows could leak fake acknowledgement text into compiled history.
- Fixed current-tool handling so current request tools are preserved as supplied instead of being backfilled from historical tool calls.
- Fixed empty current-message handling so intentionally empty user content can be preserved when there is no semantic text to send.
- Fixed OpenAI multi-turn alignment so Kiro no longer anchors on the previous user message when the newest plain user turn exists only in `currentMessage`.
- Fixed tool-result continuation shaping so terminal tool results are not incorrectly rewritten into history-only continuations that lose the current-turn anchor.
- Fixed generic `400` handling so the gateway no longer performs a redundant same-endpoint retry with a no-op "aggressive sanitize" pass.
- Fixed `5xx` retry accounting so endpoint failure stats are recorded before same-endpoint retry attempts.
- Fixed handler-level test leaks by explicitly destroying `RateLimiter` timers in tests.
