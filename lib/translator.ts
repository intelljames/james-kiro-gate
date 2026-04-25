// KiroGate 格式转换器
// OpenAI/Claude 格式 ↔ Kiro 格式双向转换，适配 Deno 环境
import type {
  OpenAIChatRequest, OpenAIChatResponse,
  OpenAIStreamChunk, OpenAIChoice,
  ClaudeRequest, ClaudeResponse, ClaudeStreamEvent,
  ClaudeContentBlock, ClaudeUsage,
  KiroPayload, KiroToolUse
} from './types.ts'
import {
  claudeRequestToNormalizedKiroPayload,
  openAIRequestToNormalizedKiroPayload,
} from './kiroCompiler.ts'

// reasoning_effort → budget tokens 映射（兼容 new-api）
const REASONING_EFFORT_BUDGET: Record<string, number> = { low: 1280, medium: 2048, high: 4096 }

export function getThinkingBudgetFromRequest(
  reasoningEffort?: string, reasoning?: { max_tokens?: number }
): number | undefined {
  if (reasoning?.max_tokens && reasoning.max_tokens > 0) return reasoning.max_tokens
  if (reasoningEffort) {
    const budget = REASONING_EFFORT_BUDGET[reasoningEffort.toLowerCase()]
    if (budget) return budget
  }
  return undefined
}

export function isThinkingModel(model: string): boolean {
  return model.toLowerCase().includes('thinking')
}

export function isClaudeThinkingEnabled(thinking: unknown): boolean {
  if (thinking === null || thinking === undefined) return false
  if (typeof thinking === 'object') {
    const t = thinking as Record<string, unknown>
    if (typeof t.type === 'string') {
      const type = t.type.toLowerCase()
      return type === 'enabled' || type === 'adaptive'
    }
  }
  return false
}

export function getClaudeThinkingType(thinking: unknown): 'enabled' | 'adaptive' | null {
  if (thinking === null || thinking === undefined) return null
  if (typeof thinking === 'object') {
    const t = thinking as Record<string, unknown>
    if (typeof t.type === 'string') {
      const type = t.type.toLowerCase()
      if (type === 'enabled') return 'enabled'
      if (type === 'adaptive') return 'adaptive'
    }
  }
  return null
}

export function getClaudeThinkingBudget(thinking: unknown): number | undefined {
  if (thinking === null || thinking === undefined) return undefined
  if (typeof thinking === 'object') {
    const t = thinking as Record<string, unknown>
    if (typeof t.budget_tokens === 'number' && t.budget_tokens > 0) return t.budget_tokens
  }
  return undefined
}

// ============ 会话 ID 管理（简化版） ============
const conversationMap = new Map<string, string>()
const CONV_MAP_MAX = 500

function getOrCreateConversationId(sessionId?: string): string {
  if (!sessionId) return crypto.randomUUID()
  let convId = conversationMap.get(sessionId)
  if (!convId) {
    convId = crypto.randomUUID()
    if (conversationMap.size >= CONV_MAP_MAX) {
      const oldest = conversationMap.keys().next().value
      if (oldest !== undefined) conversationMap.delete(oldest)
    }
    conversationMap.set(sessionId, convId)
  }
  return convId
}

// 从 OpenAI 请求提取会话标识
function extractSessionFromOpenAI(request: OpenAIChatRequest & { user?: string }): string | undefined {
  return request.user || undefined
}

// 从 Claude 请求提取会话标识
function extractSessionFromClaude(request: ClaudeRequest): string | undefined {
  return request.metadata?.user_id || undefined
}

// ============ OpenAI → Kiro 转换 ============
export function openaiToKiro(
  request: OpenAIChatRequest & { user?: string },
  profileArn?: string, thinkingEnabledOverride?: boolean
): KiroPayload {
  const sessionId = extractSessionFromOpenAI(request)
  const conversationId = getOrCreateConversationId(sessionId)

  // thinking 模式检测
  const modelHasThinking = isThinkingModel(request.model)
  const budgetFromParams = getThinkingBudgetFromRequest(request.reasoning_effort, request.reasoning)
  const thinkingEnabled = thinkingEnabledOverride === true || modelHasThinking || budgetFromParams !== undefined
  const thinkingBudget = budgetFromParams

  return openAIRequestToNormalizedKiroPayload(
    request,
    profileArn,
    thinkingEnabled,
    conversationId,
    thinkingBudget,
  )
}

// ============ Kiro → OpenAI 响应转换 ============
export function kiroToOpenaiResponse(
  content: string, toolUses: KiroToolUse[],
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; contextWindowExceeded?: boolean; truncated?: boolean },
  model: string,
  thinkingContent?: string
): OpenAIChatResponse {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: toolUses.length > 0 ? null : content,
        ...(thinkingContent && { reasoning_content: thinkingContent }),
        tool_calls: toolUses.length > 0 ? toolUses.map(tu => ({
          id: tu.toolUseId, type: 'function' as const,
          function: { name: tu.name, arguments: JSON.stringify(tu.input) }
        })) : undefined
      },
      finish_reason: (usage.truncated || usage.contextWindowExceeded)
        ? 'length'
        : (toolUses.length > 0 ? 'tool_calls' : 'stop')
    }],
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
      ...(usage.cacheReadTokens && {
        prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
        prompt_cache_hit_tokens: usage.cacheReadTokens
      }),
      ...(usage.reasoningTokens && {
        completion_tokens_details: { reasoning_tokens: usage.reasoningTokens }
      })
    }
  }
}

// ============ Claude → Kiro 转换 ============
export function claudeToKiro(
  request: ClaudeRequest, profileArn?: string, thinkingEnabledOverride?: boolean
): KiroPayload {
  const sessionId = extractSessionFromClaude(request)
  const conversationId = getOrCreateConversationId(sessionId)

  const thinkingEnabled = thinkingEnabledOverride !== undefined
    ? thinkingEnabledOverride : isClaudeThinkingEnabled(request.thinking)
  const thinkingType = getClaudeThinkingType(request.thinking)
  const thinkingBudget = getClaudeThinkingBudget(request.thinking)

  return claudeRequestToNormalizedKiroPayload(
    request,
    profileArn,
    thinkingEnabled,
    conversationId,
    thinkingBudget,
    thinkingType,
    request.output_config?.effort,
  )
}

function createThinkingSignature(thinking: string): string {
  const sample = thinking.slice(0, 32).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)
  return btoa(`kiro:${thinking.length}:${sample}`).replace(/=/g, '')
}
// ============ Kiro → Claude 响应转换 ============
export function kiroToClaudeResponse(
  content: string, toolUses: KiroToolUse[],
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; contextWindowExceeded?: boolean; truncated?: boolean },
  model: string,
  thinkingContent?: string
): ClaudeResponse {
  const contentBlocks: ClaudeContentBlock[] = []
  if (thinkingContent) contentBlocks.push({ type: 'thinking', thinking: thinkingContent, signature: createThinkingSignature(thinkingContent) })
  if (content) contentBlocks.push({ type: 'text', text: content })
  for (const tu of toolUses) {
    contentBlocks.push({ type: 'tool_use', id: tu.toolUseId, name: tu.name, input: tu.input })
  }
  return {
    id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant',
    content: contentBlocks, model,
    stop_reason: (usage.truncated || usage.contextWindowExceeded)
      ? 'max_tokens'
      : (toolUses.length > 0 ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
      ...(usage.cacheReadTokens && { cache_read_input_tokens: usage.cacheReadTokens }),
      ...(usage.cacheWriteTokens && { cache_creation_input_tokens: usage.cacheWriteTokens })
    }
  }
}

export function createClaudeStreamEvent(
  type: ClaudeStreamEvent['type'], data?: Partial<ClaudeStreamEvent>
): ClaudeStreamEvent {
  switch (type) {
    case 'message_start':
      return { type, message: data?.message } as ClaudeStreamEvent
    case 'content_block_start':
      return { type, index: data?.index, content_block: data?.content_block } as ClaudeStreamEvent
    case 'content_block_delta':
      return { type, index: data?.index, delta: data?.delta } as ClaudeStreamEvent
    case 'content_block_stop':
      return { type, index: data?.index } as ClaudeStreamEvent
    case 'message_delta':
      return { type, delta: data?.delta, usage: data?.usage } as ClaudeStreamEvent
    case 'message_stop':
      return { type } as ClaudeStreamEvent
    case 'ping':
      return { type } as ClaudeStreamEvent
    case 'error':
      return { type, error: data?.error } as ClaudeStreamEvent
    default:
      return { type, ...data } as ClaudeStreamEvent
  }
}
