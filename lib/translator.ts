// KiroGate 格式转换器
// OpenAI/Claude 格式 ↔ Kiro 格式双向转换，适配 Deno 环境
import type {
  OpenAIChatRequest, OpenAIMessage, OpenAITool, OpenAIChatResponse,
  OpenAIStreamChunk, OpenAIChoice,
  ClaudeRequest, ClaudeMessage, ClaudeResponse, ClaudeStreamEvent,
  ClaudeContentBlock, ClaudeUsage,
  KiroPayload, KiroHistoryMessage, KiroToolWrapper, KiroToolResult,
  KiroImage, KiroToolUse, KiroUserInputMessage
} from './types.ts'
import { buildKiroPayload, mapModelIdOrThrow } from './kiroApi.ts'

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
  const modelId = mapModelIdOrThrow(request.model)
  const origin = 'AI_EDITOR'
  const sessionId = extractSessionFromOpenAI(request)
  const conversationId = getOrCreateConversationId(sessionId)

  // 提取系统提示
  let systemPrompt = ''
  const nonSystemMessages: OpenAIMessage[] = []
  for (const msg of request.messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      if (typeof msg.content === 'string') systemPrompt += (systemPrompt ? '\n' : '') + msg.content
      else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text' && part.text) systemPrompt += (systemPrompt ? '\n' : '') + part.text
        }
      }
    } else { nonSystemMessages.push(msg) }
  }

  const history: KiroHistoryMessage[] = []
  const toolResults: KiroToolResult[] = []
  let currentContent = ''
  const images: KiroImage[] = []

  // system prompt 注入为历史第一轮交互
  if (systemPrompt) {
    history.push({ userInputMessage: { content: systemPrompt, modelId, origin } })
    history.push({ assistantResponseMessage: { content: 'Understood. I will follow these instructions.' } })
  }

  for (let i = 0; i < nonSystemMessages.length; i++) {
    const msg = nonSystemMessages[i]
    const isLast = i === nonSystemMessages.length - 1

    if (msg.role === 'user') {
      const { content: userContent, images: userImages } = extractOpenAIContent(msg)
      const mergedContent = userContent || 'Continue'
      if (isLast) { currentContent = mergedContent; images.push(...userImages) }
      else {
        history.push({ userInputMessage: {
          content: mergedContent, modelId, origin,
          images: userImages.length > 0 ? userImages : undefined
        }})
      }
    } else if (msg.role === 'assistant') {
      let assistantContent = typeof msg.content === 'string' ? msg.content : ''
      if (!assistantContent.trim() && msg.tool_calls?.length) assistantContent = ' '
      else if (!assistantContent.trim()) assistantContent = 'I understand.'
      const toolUses: KiroToolUse[] = []
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type === 'function') {
            let input = {}
            try { input = JSON.parse(tc.function.arguments) } catch { /* ignore */ }
            toolUses.push({ toolUseId: tc.id, name: tc.function.name, input })
          }
        }
      }
      history.push({ assistantResponseMessage: {
        content: assistantContent, toolUses: toolUses.length > 0 ? toolUses : undefined
      }})
    } else if (msg.role === 'tool') {
      if (msg.tool_call_id) {
        toolResults.push({
          toolUseId: msg.tool_call_id,
          content: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }],
          status: 'success'
        })
      }
      const nextMsg = nonSystemMessages[i + 1]
      const shouldFlush = !nextMsg || nextMsg.role !== 'tool'
      // 修复：移除 !isLast 条件，确保 tool results 总是被添加到 history 中
      // 这样 Kiro API 才能正确地将 tool result 与之前的 tool call 关联
      if (shouldFlush && toolResults.length > 0) {
        history.push({ userInputMessage: {
          content: 'Tool results provided.', modelId, origin,
          userInputMessageContext: { toolResults: [...toolResults] }
        }})
        toolResults.length = 0
      }
    }
  }
  // 最后一条是 assistant 时自动 Continue
  if (history.length > 0 && history[history.length - 1].assistantResponseMessage && !currentContent) {
    currentContent = 'Continue.'
  }
  if (!currentContent && toolResults.length > 0) currentContent = 'Tool results provided.'
  const finalContent = currentContent || 'Continue.'

  // thinking 模式检测
  const modelHasThinking = isThinkingModel(request.model)
  const budgetFromParams = getThinkingBudgetFromRequest(request.reasoning_effort, request.reasoning)
  const thinkingEnabled = thinkingEnabledOverride === true || modelHasThinking || budgetFromParams !== undefined
  const thinkingBudget = budgetFromParams

  const kiroTools = convertOpenAITools(request.tools)

  // 修复：如果 toolResults 已经被添加到 history 中，则不应该再传递给 buildKiroPayload
  // 因为这会导致它们被重复添加到 current message 中，造成 LLM 混淆
  // 检查 history 的最后一条消息是否包含 toolResults
  const lastHistoryHasToolResults = history.length > 0 && 
    history[history.length - 1].userInputMessage?.userInputMessageContext?.toolResults !== undefined
  
  const toolResultsToPass = lastHistoryHasToolResults ? [] : toolResults

  return buildKiroPayload(
    finalContent, modelId, origin, history, kiroTools, toolResultsToPass, images, profileArn,
    { maxTokens: request.max_tokens, temperature: request.temperature, topP: request.top_p },
    thinkingEnabled, conversationId, thinkingBudget
  )
}

// ============ OpenAI 内容提取 ============
function extractOpenAIContent(msg: OpenAIMessage): { content: string; images: KiroImage[] } {
  const images: KiroImage[] = []
  let content = ''
  if (typeof msg.content === 'string') { content = msg.content }
  else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === 'text' && part.text) content += part.text
      else if (part.type === 'image_url' && part.image_url?.url) {
        const image = parseImageUrl(part.image_url.url)
        if (image) images.push(image)
      }
    }
  }
  return { content, images }
}

function parseImageUrl(url: string): KiroImage | null {
  if (url.startsWith('data:')) {
    const match = url.match(/^data:image\/(\w+);base64,(.+)$/)
    if (match) return { format: normalizeImageFormat(match[1]), source: { bytes: match[2] } }
  }
  return null
}

function normalizeImageFormat(format: string): string {
  const map: Record<string, string> = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp' }
  return map[format.toLowerCase()] || 'png'
}

// ============ 工具定义转换 + LRU 缓存 ============
const KIRO_MAX_TOOL_DESC_LEN = 10237

interface ToolCacheEntry { tools: KiroToolWrapper[]; timestamp: number }
const toolConvertCache = new Map<string, ToolCacheEntry>()
const TOOL_CACHE_MAX = 8
const TOOL_CACHE_TTL = 300000

function toolsFingerprint(tools: OpenAITool[]): string {
  let hash = 0
  for (const t of tools) {
    const s = t.function.name + (t.function.description?.length || 0)
    for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0
  }
  return `${tools.length}:${hash >>> 0}`
}

const WRITE_TOOL_SUFFIX = '\n- IMPORTANT: If the content to write exceeds 150 lines, you MUST only write the first 50 lines using this tool, then use `Edit` tool to append the remaining content in chunks of no more than 50 lines each.'
const EDIT_TOOL_SUFFIX = '\n- IMPORTANT: If the `new_string` content exceeds 50 lines, you MUST split it into multiple Edit calls, each replacing no more than 50 lines at a time.'

function appendToolSizeLimits(name: string, description: string): string {
  const lower = name.toLowerCase()
  if (lower === 'write') return description + WRITE_TOOL_SUFFIX
  if (lower === 'edit') return description + EDIT_TOOL_SUFFIX
  return description
}

function shortenToolName(name: string): string {
  const limit = 64
  if (name.length <= limit) return name
  if (name.startsWith('mcp__')) {
    const lastIdx = name.lastIndexOf('__')
    if (lastIdx > 5) {
      const shortened = 'mcp__' + name.substring(lastIdx + 2)
      return shortened.length > limit ? shortened.substring(0, limit) : shortened
    }
  }
  return name.substring(0, limit)
}
function convertOpenAITools(tools?: OpenAITool[]): KiroToolWrapper[] {
  if (!tools || tools.length === 0) return []
  const fp = toolsFingerprint(tools)
  const cached = toolConvertCache.get(fp)
  if (cached && Date.now() - cached.timestamp < TOOL_CACHE_TTL) return cached.tools

  const result = tools.map(tool => {
    let description = tool.function.description || `Tool: ${tool.function.name}`
    description = appendToolSizeLimits(tool.function.name, description)
    if (description.length > KIRO_MAX_TOOL_DESC_LEN) description = description.substring(0, KIRO_MAX_TOOL_DESC_LEN) + '...'
    return { toolSpecification: {
      name: shortenToolName(tool.function.name), description,
      inputSchema: { json: tool.function.parameters }
    }}
  })

  if (toolConvertCache.size >= TOOL_CACHE_MAX) {
    const oldestKey = toolConvertCache.keys().next().value
    if (oldestKey !== undefined) toolConvertCache.delete(oldestKey)
  }
  toolConvertCache.set(fp, { tools: result, timestamp: Date.now() })
  return result
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
  const modelId = mapModelIdOrThrow(request.model)
  const origin = 'AI_EDITOR'
  const sessionId = extractSessionFromClaude(request)
  const conversationId = getOrCreateConversationId(sessionId)

  const thinkingEnabled = thinkingEnabledOverride !== undefined
    ? thinkingEnabledOverride : isClaudeThinkingEnabled(request.thinking)
  const thinkingType = getClaudeThinkingType(request.thinking)
  const thinkingBudget = getClaudeThinkingBudget(request.thinking)

  let systemPrompt = ''
  if (typeof request.system === 'string') systemPrompt = request.system
  else if (Array.isArray(request.system)) systemPrompt = request.system.map(b => b.text).join('\n')

  const history: KiroHistoryMessage[] = []
  let currentToolResults: KiroToolResult[] = []
  let currentContent = ''
  const images: KiroImage[] = []
  let pendingUserContent = ''
  let pendingUserImages: KiroImage[] = []
  let pendingToolResults: KiroToolResult[] = []

  for (let i = 0; i < request.messages.length; i++) {
    const msg = request.messages[i]
    const isLast = i === request.messages.length - 1

    if (msg.role === 'user') {
      const { content: userContent, images: userImages, toolResults: userToolResults } = extractClaudeContent(msg)
      if (isLast) {
        currentContent = pendingUserContent ? pendingUserContent + '\n' + userContent : userContent
        images.push(...pendingUserImages, ...userImages)
        currentToolResults = [...pendingToolResults, ...userToolResults]
        pendingUserContent = ''; pendingUserImages = []; pendingToolResults = []
      } else {
        const nextMsg = request.messages[i + 1]
        if (nextMsg && nextMsg.role === 'assistant') {
          const finalUserContent = pendingUserContent ? pendingUserContent + '\n' + userContent : userContent
          const finalUserImages = [...pendingUserImages, ...userImages]
          const finalToolResults = [...pendingToolResults, ...userToolResults]
          if (finalUserContent.trim() || finalUserImages.length > 0 || finalToolResults.length > 0) {
            const userInputMessage: KiroUserInputMessage = {
              content: finalUserContent || (finalToolResults.length > 0 ? 'Tool results provided.' : 'Continue'),
              modelId, origin, images: finalUserImages.length > 0 ? finalUserImages : undefined
            }
            if (finalToolResults.length > 0) userInputMessage.userInputMessageContext = { toolResults: finalToolResults }
            history.push({ userInputMessage })
          }
          pendingUserContent = ''; pendingUserImages = []; pendingToolResults = []
        } else {
          pendingUserContent = pendingUserContent ? pendingUserContent + '\n' + userContent : userContent
          pendingUserImages.push(...userImages); pendingToolResults.push(...userToolResults)
        }
      }
    } else if (msg.role === 'assistant') {
      const { content: assistantContent, toolUses } = extractClaudeAssistantContent(msg)
      if (pendingUserContent.trim() || pendingUserImages.length > 0 || pendingToolResults.length > 0) {
        const userInputMessage: KiroUserInputMessage = {
          content: pendingUserContent || (pendingToolResults.length > 0 ? 'Tool results provided.' : 'Continue'),
          modelId, origin, images: pendingUserImages.length > 0 ? pendingUserImages : undefined
        }
        if (pendingToolResults.length > 0) userInputMessage.userInputMessageContext = { toolResults: pendingToolResults }
        history.push({ userInputMessage })
        pendingUserContent = ''; pendingUserImages = []; pendingToolResults = []
      }
      history.push({ assistantResponseMessage: {
        content: assistantContent, toolUses: toolUses.length > 0 ? toolUses : undefined
      }})
    }
  }
  // 处理剩余 pending 内容
  if (pendingUserContent.trim() || pendingUserImages.length > 0 || pendingToolResults.length > 0) {
    currentContent = pendingUserContent + (currentContent ? '\n' + currentContent : '')
    images.unshift(...pendingUserImages)
    currentToolResults = [...pendingToolResults, ...currentToolResults]
  }

  // system prompt 注入为历史第一轮交互
  if (systemPrompt) {
    history.unshift(
      { userInputMessage: { content: systemPrompt, modelId, origin } },
      { assistantResponseMessage: { content: 'Understood. I will follow these instructions.' } }
    )
  } else if (history.length > 0 && history[0].assistantResponseMessage) {
    history.unshift({ userInputMessage: { content: 'Begin conversation', modelId, origin } })
  }

  const finalContent = currentContent || (currentToolResults.length > 0 ? 'Tool results provided.' : 'Continue')
  const kiroTools = convertClaudeTools(request.tools)

  return buildKiroPayload(
    finalContent, modelId, origin, history, kiroTools, currentToolResults, images, profileArn,
    { maxTokens: request.max_tokens, temperature: request.temperature, topP: request.top_p },
    thinkingEnabled, conversationId, thinkingBudget, thinkingType,
    request.output_config?.effort
  )
}

// ============ Claude 内容提取 ============
function extractClaudeContent(msg: ClaudeMessage): { content: string; images: KiroImage[]; toolResults: KiroToolResult[] } {
  const images: KiroImage[] = [], toolResults: KiroToolResult[] = []
  let content = ''
  if (typeof msg.content === 'string') { content = msg.content }
  else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) content += block.text
      else if (block.type === 'image' && block.source) {
        if (block.source.type === 'base64' && block.source.media_type && block.source.data) {
          images.push({ format: block.source.media_type.split('/')[1] || 'png', source: { bytes: block.source.data } })
        }
        // url type: Kiro backend does not support image URLs, silently skip
      } else if (block.type === 'document' && block.source) {
        // Flatten document content into text
        if ((block.source as any).type === 'text' && (block.source as any).data) {
          content += (content ? '\n' : '') + (block.source as any).data
        } else if ((block.source as any).type === 'base64') {
          content += (content ? '\n' : '') + '[document: base64 content not supported]'
        }
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        let resultContent = ''
        if (typeof block.content === 'string') resultContent = block.content
        else if (Array.isArray(block.content)) resultContent = block.content.map(b => b.text || '').join('')
        const isError = (block as any).is_error === true
        toolResults.push({ toolUseId: block.tool_use_id, content: [{ text: resultContent }], status: isError ? 'error' : 'success' })
      }
    }
  }
  return { content, images, toolResults }
}

function extractClaudeAssistantContent(msg: ClaudeMessage): { content: string; toolUses: KiroToolUse[] } {
  const toolUses: KiroToolUse[] = []
  let content = ''
  if (typeof msg.content === 'string') { content = msg.content }
  else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) content += block.text
      else if (block.type === 'tool_use' && block.id && block.name) {
        toolUses.push({ toolUseId: block.id, name: block.name, input: (block.input as Record<string, unknown>) || {} })
      }
    }
  }
  if (!content.trim() && toolUses.length > 0) content = ' '
  return { content, toolUses }
}

function convertClaudeTools(tools?: { name: string; description: string; input_schema: unknown }[]): KiroToolWrapper[] {
  if (!tools) return []
  return tools.map(tool => {
    let description = tool.description || `Tool: ${tool.name}`
    description = appendToolSizeLimits(tool.name, description)
    if (description.length > KIRO_MAX_TOOL_DESC_LEN) description = description.substring(0, KIRO_MAX_TOOL_DESC_LEN) + '...'
    return { toolSpecification: {
      name: shortenToolName(tool.name), description,
      inputSchema: { json: tool.input_schema }
    }}
  })
}
// ============ Kiro → Claude 响应转换 ============
export function kiroToClaudeResponse(
  content: string, toolUses: KiroToolUse[],
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; contextWindowExceeded?: boolean; truncated?: boolean },
  model: string,
  thinkingContent?: string
): ClaudeResponse {
  const contentBlocks: ClaudeContentBlock[] = []
  if (thinkingContent) contentBlocks.push({ type: 'thinking', thinking: thinkingContent, signature: '' })
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