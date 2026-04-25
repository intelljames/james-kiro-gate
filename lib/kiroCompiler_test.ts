import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std/assert/mod.ts'

import {
  compileNormalizedConversationToKiroPayload,
  normalizeOpenAIConversation,
} from './kiroCompiler.ts'
import type { NormalizedConversation, OpenAIChatRequest } from './types.ts'

Deno.test('compiler preserves caller provided current tools without injecting historical tool names', () => {
  const normalized: NormalizedConversation = {
    instructions: [],
    turns: [
      { role: 'user', text: 'Look up Beijing weather.' },
      {
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'tool_1', name: 'get_weather', input: { city: 'Beijing' } },
        ],
      },
      {
        role: 'user',
        text: '',
        toolResults: [
          { toolCallId: 'tool_1', text: 'Sunny, 25C', status: 'success' },
        ],
      },
    ],
    tools: [
      {
        name: 'weather_lookup',
        description: 'Alternative tool definition name',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ],
    currentInput: { text: '继续' },
  }

  const payload = compileNormalizedConversationToKiroPayload(
    normalized,
    'claude-sonnet-4.5',
    'AI_EDITOR',
  )

  const toolNames = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.map(
    (tool) => tool.toolSpecification.name,
  ) || []

  assertEquals(toolNames, ['weather_lookup'])
})

Deno.test('OpenAI system and developer instructions compile into current input instead of fake acknowledgement history', () => {
  const request: OpenAIChatRequest = {
    model: 'claude-sonnet-4-5',
    messages: [
      { role: 'system', content: 'Always answer in Chinese.' },
      { role: 'developer', content: 'Be concise.' },
      { role: 'user', content: '你好' },
    ],
  }

  const normalized = normalizeOpenAIConversation(request)
  const payload = compileNormalizedConversationToKiroPayload(
    normalized,
    'claude-sonnet-4.5',
    'AI_EDITOR',
  )

  const history = payload.conversationState.history ?? []
  assertEquals(history.length, 0)
  assertStringIncludes(payload.conversationState.currentMessage.userInputMessage.content, 'Always answer in Chinese.')
  assertStringIncludes(payload.conversationState.currentMessage.userInputMessage.content, 'Be concise.')
  assertStringIncludes(payload.conversationState.currentMessage.userInputMessage.content, '你好')
  assert(!payload.conversationState.currentMessage.userInputMessage.content.includes('Understood. I will follow these instructions.'))
})

Deno.test('builder preserves intentionally empty current content when no semantic text is present', () => {
  const normalized: NormalizedConversation = {
    instructions: [],
    turns: [
      { role: 'user', text: 'Look up Beijing weather.' },
      {
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'tool_empty_1', name: 'get_weather', input: { city: 'Beijing' } },
        ],
      },
      {
        role: 'user',
        text: '',
        toolResults: [
          { toolCallId: 'tool_empty_1', text: 'Sunny, 25C', status: 'success' },
        ],
      },
    ],
    tools: [
      {
        name: 'get_weather',
        description: 'Fetch weather by city',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ],
    currentInput: { text: '' },
  }

  const payload = compileNormalizedConversationToKiroPayload(
    normalized,
    'claude-sonnet-4.5',
    'AI_EDITOR',
  )

  assertEquals(payload.conversationState.currentMessage.userInputMessage.content, '')
})
