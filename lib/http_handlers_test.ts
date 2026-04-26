import { assertEquals, assertStringIncludes } from 'https://deno.land/std/assert/mod.ts'

import type { ProxyAccount } from './types.ts'
import { CircuitBreaker } from './errorHandler.ts'
import { RateLimiter } from './rateLimiter.ts'
import { AccountPool } from './accountPool.ts'
import {
  handleAnthropicMessages,
  handleChatCompletions,
  shouldLogEgressPreview,
  summarizeFullPayloadDebugInfo,
  summarizeIncomingOpenAIRequest,
  type ChatHandlerDeps,
} from './http_handlers.ts'
import { buildKiroPayload } from './kiroApi.ts'

function makeDeps(): ChatHandlerDeps {
  const accountPool = new AccountPool()
  const rateLimiter = new RateLimiter()
  const circuitBreaker = new CircuitBreaker(5, 60000)
  const account: ProxyAccount = {
    id: 'acc_test',
    accessToken: 'token',
    region: 'us-east-1',
    isAvailable: true,
    disabled: false,
    requestCount: 0,
    errorCount: 0,
  }
  accountPool.addAccount(account)

  return {
    settings: {
      proxyApiKey: 'test-key',
      rateLimitPerMinute: 0,
      debugPayload: false,
      debugFullPayload: false,
    },
    accountPool,
    rateLimiter,
    circuitBreaker,
    verifyApiKey: async () => ({ valid: true }),
    getAccountFromRefreshToken: async () => account,
    selectAccount: async () => account,
    createRequestDebugID: (prefix) => `${prefix}-test`,
    detectThinkingHeader: () => '',
  }
}

Deno.test('handleChatCompletions returns 503 when circuit breaker is open', async () => {
  const deps = makeDeps()
  try {
    deps.circuitBreaker.recordFailure()
    deps.circuitBreaker.recordFailure()
    deps.circuitBreaker.recordFailure()
    deps.circuitBreaker.recordFailure()
    deps.circuitBreaker.recordFailure()

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }),
    })

    const response = await handleChatCompletions(req, deps)
    assertEquals(response.status, 503)
  } finally {
    deps.rateLimiter.destroy()
  }
})

Deno.test('handleAnthropicMessages rejects request missing max_tokens', async () => {
  const deps = makeDeps()
  try {
    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }),
    })

    const response = await handleAnthropicMessages(req, deps)
    assertEquals(response.status, 400)
  } finally {
    deps.rateLimiter.destroy()
  }
})

Deno.test('handleChatCompletions logs incoming thinking-related request fields', async () => {
  const summary = summarizeIncomingOpenAIRequest({
    model: 'claude-sonnet-4.6-kiro',
    reasoning_effort: 'high',
    reasoning: { max_tokens: 2048 },
    thinking: { type: 'enabled', budget_tokens: 4096 },
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'demo' } }],
  }, 'thinking-2025-01-01')

  const serialized = JSON.stringify(summary)
  assertStringIncludes(serialized, 'claude-sonnet-4.6-kiro')
  assertStringIncludes(serialized, 'thinking-2025-01-01')
  assertStringIncludes(serialized, 'reasoningEffort')
  assertStringIncludes(serialized, 'budget_tokens')
})

Deno.test('summarizeFullPayloadDebugInfo includes request and full payload details', () => {
  const requestBody = {
    model: 'claude-sonnet-4.6',
    stream: true,
    messages: [
      { role: 'user', content: 'hello' },
    ],
    tools: [{ type: 'function', function: { name: 'demo', parameters: { type: 'object' } } }],
  }

  const payload = buildKiroPayload('hello', 'claude-sonnet-4.5', 'AI_EDITOR')
  const summary = summarizeFullPayloadDebugInfo('oa-test', 'openai', requestBody, payload)
  const serialized = JSON.stringify(summary)

  assertStringIncludes(serialized, 'oa-test')
  assertStringIncludes(serialized, 'requestBody')
  assertStringIncludes(serialized, 'kiroPayload')
  assertStringIncludes(serialized, 'claude-sonnet-4.6')
  assertStringIncludes(serialized, 'claude-sonnet-4.5')
})

Deno.test('egress preview logging stays gated behind debug flags', () => {
  assertEquals(shouldLogEgressPreview({ debugPayload: false, debugFullPayload: false }), false)
  assertEquals(shouldLogEgressPreview({ debugPayload: true, debugFullPayload: false }), true)
  assertEquals(shouldLogEgressPreview({ debugPayload: false, debugFullPayload: true }), true)
})
