import { assertEquals } from 'https://deno.land/std/assert/mod.ts'

import type { ProxyAccount } from './types.ts'
import { CircuitBreaker } from './errorHandler.ts'
import { RateLimiter } from './rateLimiter.ts'
import { AccountPool } from './accountPool.ts'
import { handleAnthropicMessages, handleChatCompletions, type ChatHandlerDeps } from './http_handlers.ts'

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
