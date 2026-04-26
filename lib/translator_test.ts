import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertNotEquals,
} from 'https://deno.land/std/assert/mod.ts'

import { claudeToKiro, kiroToClaudeResponse, openaiToKiro } from './translator.ts'
import { buildKiroPayload } from './kiroApi.ts'
import { ClaudeStreamHandler } from './stream.ts'
import type { ClaudeRequest, OpenAIChatRequest } from './types.ts'
import {
  compileNormalizedConversationToKiroPayload,
  normalizeClaudeConversation,
  normalizeOpenAIConversation,
} from './kiroCompiler.ts'

type OpenAIAssistantArrayPart = { type: 'text'; text: string } | { type: 'refusal'; refusal: string }

Deno.test('claudeToKiro accepts document and redacted thinking content blocks', () => {
  const request: ClaudeRequest = {
    model: 'claude-sonnet-4-5',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Summarize this document.' },
          {
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: 'Doc body' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'opaque-redacted-thinking' },
          { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'doc' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: 'result text',
          },
        ],
      },
    ],
  }

  const payload = claudeToKiro(request)
  const history = payload.conversationState.history ?? []

  assert(history.length >= 2)
  assertStringIncludes(history[0].userInputMessage?.content ?? '', 'Doc body')
  assertEquals(history[1].assistantResponseMessage?.toolUses?.[0]?.name, 'lookup')
})

Deno.test('openaiToKiro merges assistant array content blocks', () => {
  const request: OpenAIChatRequest = {
    model: 'claude-sonnet-4-5',
    messages: [
      { role: 'user', content: 'Question' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Partial answer. ' },
          { type: 'refusal', refusal: 'Cannot share internal chain.' },
        ] as unknown as OpenAIAssistantArrayPart[],
      } as OpenAIChatRequest['messages'][number],
      { role: 'user', content: 'Continue' },
    ],
  }

  const payload = openaiToKiro(request)
  const history = payload.conversationState.history ?? []

  assertEquals(
    history[1].assistantResponseMessage?.content,
    'Partial answer. Cannot share internal chain.',
  )
})

Deno.test('kiroToClaudeResponse emits non-empty thinking signature', () => {
  const response = kiroToClaudeResponse(
    'final answer',
    [],
    { inputTokens: 10, outputTokens: 20 },
    'claude-sonnet-4-5',
    'reasoning text',
  )

  assertEquals(response.content[0].type, 'thinking')
  assert((response.content[0].signature?.length ?? 0) > 0)
})

Deno.test('openaiToKiro keeps tool-only assistant history free of visible placeholder text', () => {
  const request: OpenAIChatRequest = {
    model: 'claude-sonnet-4-5',
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Fetch weather by city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ],
    messages: [
      { role: 'user', content: 'Look up Beijing weather.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'Sunny, 25C' },
      { role: 'user', content: '继续' },
    ],
  }

  const payload = openaiToKiro(request)
  const history = payload.conversationState.history ?? []
  const assistantToolMessage = history.find((item) => item.assistantResponseMessage?.toolUses?.[0]?.toolUseId === 'call_1')

  assert(assistantToolMessage?.assistantResponseMessage)
  assertEquals(assistantToolMessage.assistantResponseMessage?.content, '')
  assertNotEquals(assistantToolMessage.assistantResponseMessage?.content, 'I understand.')
})

Deno.test('claudeToKiro keeps tool-only assistant history free of visible placeholder text', () => {
  const request: ClaudeRequest = {
    model: 'claude-sonnet-4-5',
    max_tokens: 256,
    tools: [
      {
        name: 'lookup',
        description: 'Lookup weather',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ],
    messages: [
      { role: 'user', content: '查一下北京天气' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_2', name: 'lookup', input: { city: 'Beijing' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'Sunny, 25C' },
        ],
      },
    ],
  }

  const payload = claudeToKiro(request)
  const history = payload.conversationState.history ?? []
  const assistantToolMessage = history.find((item) => item.assistantResponseMessage?.toolUses?.[0]?.toolUseId === 'toolu_2')

  assert(assistantToolMessage?.assistantResponseMessage)
  assertEquals(assistantToolMessage.assistantResponseMessage?.content, '')
  assertNotEquals(assistantToolMessage.assistantResponseMessage?.content, 'understood')
  assertNotEquals(assistantToolMessage.assistantResponseMessage?.content, 'I understand.')
})

Deno.test('buildKiroPayload does not inject understood placeholders into tool loop history', () => {
  const payload = buildKiroPayload(
    'Continue.',
    'claude-sonnet-4.5',
    'AI_EDITOR',
    [
      {
        userInputMessage: {
          content: 'Look up Beijing weather.',
          modelId: 'claude-sonnet-4.5',
          origin: 'AI_EDITOR',
        },
      },
      {
        assistantResponseMessage: {
          content: '',
          toolUses: [
            { toolUseId: 'toolu_hist_1', name: 'get_weather', input: { city: 'Beijing' } },
          ],
        },
      },
      {
        userInputMessage: {
          content: '',
          modelId: 'claude-sonnet-4.5',
          origin: 'AI_EDITOR',
          userInputMessageContext: {
            toolResults: [
              { toolUseId: 'toolu_hist_1', content: [{ text: 'Sunny, 25C' }], status: 'success' },
            ],
          },
        },
      },
    ],
    [
      {
        toolSpecification: {
          name: 'get_weather',
          description: 'Tool: get_weather',
          inputSchema: { json: { type: 'object', properties: { city: { type: 'string' } } } },
        },
      },
    ],
  )

  const history = payload.conversationState.history ?? []
  const assistantToolMessage = history.find((item) => item.assistantResponseMessage?.toolUses?.[0]?.toolUseId === 'toolu_hist_1')

  assert(assistantToolMessage?.assistantResponseMessage)
  assertEquals(assistantToolMessage.assistantResponseMessage?.content, '')
  assert(!history.some((item) => item.assistantResponseMessage?.content === 'understood'))
  assert(!history.some((item) => item.assistantResponseMessage?.content === 'I understand.'))
})

Deno.test('buildKiroPayload keeps assistant-ended history followed by empty current turn free of Continue placeholders', () => {
  const payload = buildKiroPayload(
    '',
    'claude-sonnet-4.5',
    'AI_EDITOR',
    [
      {
        userInputMessage: {
          content: 'Say hello.',
          modelId: 'claude-sonnet-4.5',
          origin: 'AI_EDITOR',
        },
      },
      {
        assistantResponseMessage: {
          content: 'Hello there.',
        },
      },
    ],
  )

  assertEquals(payload.conversationState.currentMessage.userInputMessage.content, '')
  assert(!payload.conversationState.history?.some((item) => item.userInputMessage?.content === 'Continue'))
})

Deno.test('buildKiroPayload uses empty structural separator instead of Continue between adjacent assistant messages', () => {
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

  const history = payload.conversationState.history ?? []
  const separator = history.find((item, index) => {
    const prev = history[index - 1]
    const next = history[index + 1]
    return prev?.assistantResponseMessage && item.userInputMessage && next?.assistantResponseMessage
  })

  assert(separator?.userInputMessage)
  assertEquals(separator.userInputMessage?.content, '')
  assert(!history.some((item) => item.userInputMessage?.content === 'Continue'))
})

Deno.test('OpenAI and Claude tool loops normalize to the same semantic shape', () => {
  const openaiRequest: OpenAIChatRequest = {
    model: 'claude-sonnet-4-5',
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Fetch weather by city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ],
    messages: [
      { role: 'system', content: 'Always be concise.' },
      { role: 'user', content: 'Look up Beijing weather.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_same_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_same_1', content: 'Sunny, 25C' },
      { role: 'user', content: '继续' },
    ],
  }

  const claudeRequest: ClaudeRequest = {
    model: 'claude-sonnet-4-5',
    max_tokens: 256,
    system: 'Always be concise.',
    tools: [
      {
        name: 'get_weather',
        description: 'Fetch weather by city',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ],
    messages: [
      { role: 'user', content: 'Look up Beijing weather.' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_same_1', name: 'get_weather', input: { city: 'Beijing' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_same_1', content: 'Sunny, 25C' },
          { type: 'text', text: '继续' },
        ],
      },
    ],
  }

  const openaiNormalized = normalizeOpenAIConversation(openaiRequest)
  const claudeNormalized = normalizeClaudeConversation(claudeRequest)

  assertEquals(openaiNormalized.instructions, claudeNormalized.instructions)
  assertEquals(openaiNormalized.turns, claudeNormalized.turns)
  assertEquals(openaiNormalized.tools, claudeNormalized.tools)
  assertEquals(openaiNormalized.currentInput, claudeNormalized.currentInput)
})

Deno.test('compiler emits history tool loop and current tools without visible placeholders', () => {
  const request: OpenAIChatRequest = {
    model: 'claude-sonnet-4-5',
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Fetch weather by city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ],
    messages: [
      { role: 'user', content: 'Look up Beijing weather.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_compiler_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_compiler_1', content: '' },
      { role: 'user', content: '继续' },
    ],
  }

  const normalized = normalizeOpenAIConversation(request)
  const payload = compileNormalizedConversationToKiroPayload(
    normalized,
    'claude-sonnet-4.5',
    'AI_EDITOR',
    undefined,
    { maxTokens: request.max_tokens, temperature: request.temperature, topP: request.top_p },
  )

  const history = payload.conversationState.history ?? []
  assertEquals(history.length, 3)
  assertEquals(history[0].userInputMessage?.content, 'Look up Beijing weather.')
  assertEquals(history[1].assistantResponseMessage?.content, '')
  assertEquals(history[1].assistantResponseMessage?.toolUses?.[0]?.toolUseId, 'call_compiler_1')
  assertEquals(history[2].userInputMessage?.userInputMessageContext?.toolResults?.[0]?.toolUseId, 'call_compiler_1')
  assertEquals(history[2].userInputMessage?.userInputMessageContext?.toolResults?.[0]?.content?.[0]?.text, '')
  assertStringIncludes(payload.conversationState.currentMessage.userInputMessage.content, '继续')
  assertEquals(payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.[0]?.toolSpecification.name, 'get_weather')
  assert(!history.some((item) => item.assistantResponseMessage?.content === 'understood'))
  assert(!history.some((item) => item.assistantResponseMessage?.content === 'I understand.'))
  assertEquals(history[2].userInputMessage?.content, 'Tool results provided.')
})

Deno.test('ClaudeStreamHandler emits signature_delta before thinking block stop', () => {
  const events: string[] = []
  const handler = new ClaudeStreamHandler({
    model: 'claude-sonnet-4-5',
    inputTokens: 5,
    onWrite: (data) => {
      events.push(data)
      return true
    },
    enableThinkingParsing: true,
  })

  handler.sendMessageStart()
  handler.handleContent('<thinking>reasoning</thinking>\n\nAnswer')
  handler.finish({ inputTokens: 5, outputTokens: 3 })

  const joined = events.join('')
  assertStringIncludes(joined, '"type":"signature_delta"')
  assert(
    joined.indexOf('"type":"signature_delta"') <
      joined.indexOf('event: content_block_stop'),
  )
})
