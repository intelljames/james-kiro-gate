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

Deno.test('builder keeps tool-result-only current turns non-empty for upstream compatibility', () => {
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

  assertEquals(payload.conversationState.currentMessage.userInputMessage.content, 'Tool results provided.')
})

Deno.test('compiler keeps non-empty history content for tool-result-only turns', () => {
  const normalized: NormalizedConversation = {
    instructions: [],
    turns: [
      { role: 'user', text: 'Look up Beijing weather.' },
      {
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'tool_hist_1', name: 'get_weather', input: { city: 'Beijing' } },
        ],
      },
      {
        role: 'user',
        text: '',
        toolResults: [
          { toolCallId: 'tool_hist_1', text: 'Sunny, 25C', status: 'success' },
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
    currentInput: { text: '继续' },
  }

  const payload = compileNormalizedConversationToKiroPayload(
    normalized,
    'claude-sonnet-4.5',
    'AI_EDITOR',
  )

  const history = payload.conversationState.history ?? []
  assertEquals(history.length, 3)
  assertEquals(history[2].userInputMessage?.userInputMessageContext?.toolResults?.[0]?.toolUseId, 'tool_hist_1')
  assertEquals(history[2].userInputMessage?.content, 'Tool results provided.')
  assertEquals(payload.conversationState.currentMessage.userInputMessage.content.includes('继续'), true)
})

Deno.test('compiler keeps terminal tool results in current message for tool continuation', () => {
  const request: OpenAIChatRequest = {
    model: 'claude-sonnet-4-5',
    tools: [
      {
        type: 'function',
        function: {
          name: 'select_plan',
          description: 'Persist the selected plan option',
          parameters: {
            type: 'object',
            properties: { option: { type: 'string' } },
            required: ['option'],
          },
        },
      },
    ],
    messages: [
      { role: 'system', content: 'Stay in plan mode.' },
      { role: 'user', content: 'Choose a plan.' },
      {
        role: 'assistant',
        content: 'I will record the selected plan.',
        tool_calls: [
          {
            id: 'call_terminal_tool_1',
            type: 'function',
            function: { name: 'select_plan', arguments: '{"option":"A"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_terminal_tool_1', content: 'saved' },
    ],
  }

  const normalized = normalizeOpenAIConversation(request)
  const payload = compileNormalizedConversationToKiroPayload(
    normalized,
    'claude-sonnet-4.5',
    'AI_EDITOR',
  )

  const history = payload.conversationState.history ?? []
  assertEquals(history.length, 2)
  assertEquals(history[0].userInputMessage?.content, 'Choose a plan.')
  assertEquals(history[1].assistantResponseMessage?.toolUses?.[0]?.toolUseId, 'call_terminal_tool_1')
  assertEquals(
    payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults?.[0]?.toolUseId,
    'call_terminal_tool_1',
  )
  assertEquals(payload.conversationState.currentMessage.userInputMessage.content.includes('Stay in plan mode.'), true)
  assertEquals(payload.conversationState.currentMessage.userInputMessage.content.includes('Stay in plan mode.'), true)
  assertEquals(payload.conversationState.currentMessage.userInputMessage.content.includes('Choose a plan.'), false)
})

Deno.test('compiler mirrors latest plain user turn into history when prior turns exist', () => {
  const normalized: NormalizedConversation = {
    instructions: [],
    turns: [
      { role: 'user', text: 'Earlier question' },
      { role: 'assistant', text: 'Earlier answer' },
    ],
    tools: [],
    currentInput: { text: 'Latest question' },
  }

  const payload = compileNormalizedConversationToKiroPayload(
    normalized,
    'claude-sonnet-4.5',
    'AI_EDITOR',
  )

  const history = payload.conversationState.history ?? []
  assertEquals(history.length, 3)
  assertEquals(history[2].userInputMessage?.content, 'Latest question')
  assertEquals(payload.conversationState.currentMessage.userInputMessage.content.includes('Latest question'), true)
})
