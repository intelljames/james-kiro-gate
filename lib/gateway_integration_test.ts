import {
  assertEquals,
  assertExists,
} from 'https://deno.land/std/assert/mod.ts'

import { openaiToKiro, claudeToKiro, kiroToOpenaiResponse, kiroToClaudeResponse } from './translator.ts'
import type { ClaudeRequest, OpenAIChatRequest } from './types.ts'

Deno.test('OpenAI tool loop compiles to native-compatible response shape', () => {
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
            id: 'openai_tool_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'openai_tool_1', content: 'Sunny, 25C' },
      { role: 'user', content: '继续' },
    ],
  }

  const payload = openaiToKiro(request)
  const history = payload.conversationState.history ?? []
  assertEquals(history[1].assistantResponseMessage?.toolUses?.[0]?.toolUseId, 'openai_tool_1')
  assertEquals(history[2].userInputMessage?.userInputMessageContext?.toolResults?.[0]?.toolUseId, 'openai_tool_1')

  const response = kiroToOpenaiResponse(
    '',
    [{ toolUseId: 'openai_tool_2', name: 'get_weather', input: { city: 'Beijing' } }],
    { inputTokens: 10, outputTokens: 5 },
    'claude-sonnet-4-5',
  )

  assertEquals(response.choices[0].message.content, null)
  assertEquals(response.choices[0].finish_reason, 'tool_calls')
  assertExists(response.choices[0].message.tool_calls)
})

Deno.test('Anthropic tool loop compiles to native-compatible response shape', () => {
  const request: ClaudeRequest = {
    model: 'claude-sonnet-4-5',
    max_tokens: 256,
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
          { type: 'tool_use', id: 'claude_tool_1', name: 'get_weather', input: { city: 'Beijing' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'claude_tool_1', content: 'Sunny, 25C' },
          { type: 'text', text: '继续' },
        ],
      },
    ],
  }

  const payload = claudeToKiro(request)
  const history = payload.conversationState.history ?? []
  assertEquals(history[1].assistantResponseMessage?.toolUses?.[0]?.toolUseId, 'claude_tool_1')
  assertEquals(history[2].userInputMessage?.userInputMessageContext?.toolResults?.[0]?.toolUseId, 'claude_tool_1')

  const response = kiroToClaudeResponse(
    '',
    [{ toolUseId: 'claude_tool_2', name: 'get_weather', input: { city: 'Beijing' } }],
    { inputTokens: 10, outputTokens: 5 },
    'claude-sonnet-4-5',
  )

  const toolUseBlock = response.content.find((block) => block.type === 'tool_use')
  assertExists(toolUseBlock)
  assertEquals(response.stop_reason, 'tool_use')
})
