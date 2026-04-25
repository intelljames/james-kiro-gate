import { assertEquals, assertRejects } from 'https://deno.land/std/assert/mod.ts'

import { buildKiroPayload, callKiroApi, summarizeKiroPayload } from './kiroApi.ts'
import type { ProxyAccount } from './types.ts'

Deno.test('summarizeKiroPayload does not synthesize empty user separators into history preview', () => {
  const payload = buildKiroPayload(
    'What next?',
    'claude-sonnet-4.5',
    'AI_EDITOR',
    [
      {
        userInputMessage: {
          content: 'Start.',
          modelId: 'claude-sonnet-4.5',
          origin: 'AI_EDITOR',
        },
      },
      {
        assistantResponseMessage: {
          content: 'First response.',
        },
      },
      {
        assistantResponseMessage: {
          content: 'Second response.',
        },
      },
    ],
  )

  const summary = summarizeKiroPayload(payload)
  assertEquals(summary.historyCount, 3)
  assertEquals((summary.historyPreview as Array<{ role: string; contentPreview: string }>).map((item) => item.role), [
    'user',
    'assistant',
    'assistant',
  ])
})

Deno.test('callKiroApi does not retry generic 400 errors on the same endpoint', async () => {
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  const account: ProxyAccount = {
    id: 'acc_test',
    accessToken: 'token',
    region: 'us-east-1',
    isAvailable: true,
    disabled: false,
    requestCount: 0,
    errorCount: 0,
  }
  const payload = buildKiroPayload(
    'Hello',
    'claude-sonnet-4.5',
    'AI_EDITOR',
    [
      {
        userInputMessage: {
          content: 'Earlier',
          modelId: 'claude-sonnet-4.5',
          origin: 'AI_EDITOR',
        },
      },
    ],
  )

  try {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
      fetchCalls++
      return Promise.resolve(new Response(JSON.stringify({ message: 'Improperly formed request.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }))
    }) as typeof fetch

    await assertRejects(() => callKiroApi(account, payload), Error, 'Bad Request: Improperly formed request.')
    assertEquals(fetchCalls, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test('callKiroApi truncates history progressively for content-length 400 errors before succeeding', async () => {
  const originalFetch = globalThis.fetch
  const historyLengths: number[] = []
  let fetchCalls = 0
  const account: ProxyAccount = {
    id: 'acc_test',
    accessToken: 'token',
    region: 'us-east-1',
    isAvailable: true,
    disabled: false,
    requestCount: 0,
    errorCount: 0,
  }
  const payload = buildKiroPayload(
    'Final question',
    'claude-sonnet-4.5',
    'AI_EDITOR',
    [
      { userInputMessage: { content: 'u1', modelId: 'claude-sonnet-4.5', origin: 'AI_EDITOR' } },
      { assistantResponseMessage: { content: 'a1' } },
      { userInputMessage: { content: 'u2', modelId: 'claude-sonnet-4.5', origin: 'AI_EDITOR' } },
      { assistantResponseMessage: { content: 'a2' } },
    ],
  )

  try {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls++
      const parsed = JSON.parse(String(init?.body))
      historyLengths.push(parsed.conversationState.history?.length ?? 0)

      if (fetchCalls < 3) {
        return Promise.resolve(new Response(JSON.stringify({ message: 'context_length exceeded' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }))
      }

      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    }) as typeof fetch

    const result = await callKiroApi(account, payload)
    assertEquals(result.content, '')
    assertEquals(fetchCalls, 3)
    assertEquals(historyLengths, [4, 2, 1])
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test('callKiroApi stops after the last available truncation tier for repeated content-length 400 errors', async () => {
  const originalFetch = globalThis.fetch
  const historyLengths: number[] = []
  let fetchCalls = 0
  const account: ProxyAccount = {
    id: 'acc_test',
    accessToken: 'token',
    region: 'us-east-1',
    isAvailable: true,
    disabled: false,
    requestCount: 0,
    errorCount: 0,
  }
  const payload = buildKiroPayload(
    'Final question',
    'claude-sonnet-4.5',
    'AI_EDITOR',
    [
      { userInputMessage: { content: 'u1', modelId: 'claude-sonnet-4.5', origin: 'AI_EDITOR' } },
      { assistantResponseMessage: { content: 'a1' } },
      { userInputMessage: { content: 'u2', modelId: 'claude-sonnet-4.5', origin: 'AI_EDITOR' } },
      { assistantResponseMessage: { content: 'a2' } },
    ],
  )

  try {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls++
      const parsed = JSON.parse(String(init?.body))
      historyLengths.push(parsed.conversationState.history?.length ?? 0)
      if (fetchCalls <= 4) {
        return Promise.resolve(new Response(JSON.stringify({ message: 'CONTENT_LENGTH exceeded' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }))
      }
    }) as typeof fetch

    await assertRejects(() => callKiroApi(account, payload), Error, 'Bad Request: CONTENT_LENGTH exceeded')
    assertEquals(fetchCalls, 3)
    assertEquals(historyLengths, [4, 2, 1])
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test('callKiroApi switches endpoints after a 429 without retrying the same endpoint', async () => {
  const originalFetch = globalThis.fetch
  const seenUrls: string[] = []
  let fetchCalls = 0
  const account: ProxyAccount = {
    id: 'acc_test',
    accessToken: 'token',
    region: 'us-east-1',
    isAvailable: true,
    disabled: false,
    requestCount: 0,
    errorCount: 0,
  }
  const payload = buildKiroPayload('Hello', 'claude-sonnet-4.5', 'AI_EDITOR')

  try {
    globalThis.fetch = ((input: RequestInfo | URL, _init?: RequestInit) => {
      fetchCalls++
      seenUrls.push(String(input))
      if (fetchCalls === 1) {
        return Promise.resolve(new Response('rate limited', { status: 429 }))
      }
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      }), { status: 200 }))
    }) as typeof fetch

    const result = await callKiroApi(account, payload)
    assertEquals(result.content, '')
    assertEquals(fetchCalls, 2)
    assertEquals(seenUrls.map((url) => new URL(url).hostname), [
      'codewhisperer.us-east-1.amazonaws.com',
      'q.us-east-1.amazonaws.com',
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test('callKiroApi records a failed attempt before retrying a 5xx response on the same endpoint', async () => {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  const account: ProxyAccount = {
    id: 'acc_test',
    accessToken: 'token',
    region: 'us-east-1',
    isAvailable: true,
    disabled: false,
    requestCount: 0,
    errorCount: 0,
  }
  const payload = buildKiroPayload('Hello', 'claude-sonnet-4.5', 'AI_EDITOR')
  const beforeStats = (await import('./kiroApi.ts')).getEndpointHealthStats()
  const beforeFailCount = beforeStats.CodeWhisperer?.failCount ?? 0

  try {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
      fetchCalls++
      if (fetchCalls === 1) {
        return Promise.resolve(new Response('server error', { status: 500 }))
      }
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      }), { status: 200 }))
    }) as typeof fetch

    const result = await callKiroApi(account, payload)
    const afterStats = (await import('./kiroApi.ts')).getEndpointHealthStats()
    const afterFailCount = afterStats.CodeWhisperer?.failCount ?? 0

    assertEquals(result.content, '')
    assertEquals(fetchCalls, 2)
    assertEquals(afterFailCount - beforeFailCount, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test('callKiroApi stops immediately on auth errors without trying the next endpoint', async () => {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  const account: ProxyAccount = {
    id: 'acc_test',
    accessToken: 'token',
    region: 'us-east-1',
    isAvailable: true,
    disabled: false,
    requestCount: 0,
    errorCount: 0,
  }
  const payload = buildKiroPayload('Hello', 'claude-sonnet-4.5', 'AI_EDITOR')

  try {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
      fetchCalls++
      return Promise.resolve(new Response('denied', { status: 401 }))
    }) as typeof fetch

    await assertRejects(() => callKiroApi(account, payload), Error, 'Auth error 401: denied')
    assertEquals(fetchCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test('callKiroApi stops immediately on quota exhaustion without trying the next endpoint', async () => {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  const account: ProxyAccount = {
    id: 'acc_test',
    accessToken: 'token',
    region: 'us-east-1',
    isAvailable: true,
    disabled: false,
    requestCount: 0,
    errorCount: 0,
  }
  const payload = buildKiroPayload('Hello', 'claude-sonnet-4.5', 'AI_EDITOR')

  try {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
      fetchCalls++
      return Promise.resolve(new Response('quota exhausted', { status: 402 }))
    }) as typeof fetch

    await assertRejects(() => callKiroApi(account, payload), Error, 'QUOTA_EXHAUSTED')
    assertEquals(fetchCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
