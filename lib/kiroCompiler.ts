import type {
  ClaudeRequest,
  KiroImage,
  KiroPayload,
  KiroToolWrapper,
  NormalizedAssistantTurn,
  NormalizedConversation,
  NormalizedCurrentInput,
  NormalizedToolCall,
  NormalizedToolDefinition,
  NormalizedToolResult,
  NormalizedTurn,
  OpenAIChatRequest,
  OpenAIMessage,
} from './types.ts'
import { buildKiroPayload, mapModelIdOrThrow } from './kiroApi.ts'

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

function extractOpenAIUserContent(msg: OpenAIMessage): { text: string; images: KiroImage[] } {
  const images: KiroImage[] = []
  let text = ''
  if (typeof msg.content === 'string') {
    text = msg.content
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === 'text' && part.text) text += part.text
      else if (part.type === 'image_url' && part.image_url?.url) {
        const image = parseImageUrl(part.image_url.url)
        if (image) images.push(image)
      }
    }
  }
  return { text, images }
}

function extractOpenAIAssistantText(msg: OpenAIMessage): string {
  if (typeof msg.content === 'string') return msg.content
  let text = ''
  if (Array.isArray(msg.content)) {
    for (const part of msg.content as Array<{ type: string; text?: string; refusal?: string }>) {
      if (part.type === 'text' && part.text) text += part.text
      else if (part.type === 'refusal' && part.refusal) text += part.refusal
    }
  }
  return text
}

function normalizeOpenAITools(tools?: OpenAIChatRequest['tools']): NormalizedToolDefinition[] {
  if (!tools) return []
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description || `Tool: ${tool.function.name}`,
    inputSchema: tool.function.parameters,
  }))
}

function normalizeClaudeTools(tools?: ClaudeRequest['tools']): NormalizedToolDefinition[] {
  if (!tools) return []
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description || `Tool: ${tool.name}`,
    inputSchema: tool.input_schema,
  }))
}

function normalizeToolDefinitions(tools: NormalizedToolDefinition[]): KiroToolWrapper[] {
  return tools.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.inputSchema },
    },
  }))
}

function normalizeOpenAIToolCalls(msg: OpenAIMessage): NormalizedToolCall[] {
  const calls = msg.tool_calls ?? []
  return calls
    .filter((call) => call.type === 'function' && call.id && call.function?.name)
    .map((call) => {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(call.function.arguments)
      } catch {
        input = {}
      }
      return { id: call.id, name: call.function.name, input }
    })
}

function normalizeOpenAIToolResult(msg: OpenAIMessage): NormalizedToolResult | null {
  if (!msg.tool_call_id) return null
  const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
  return { toolCallId: msg.tool_call_id, text, status: 'success' }
}

function flushPendingToolResults(turns: NormalizedTurn[], pending: NormalizedToolResult[]): void {
  if (pending.length === 0) return
  turns.push({ role: 'user', text: '', toolResults: [...pending] })
  pending.length = 0
}

export function normalizeOpenAIConversation(
  request: OpenAIChatRequest & { user?: string },
): NormalizedConversation {
  const instructions: string[] = []
  const turns: NormalizedTurn[] = []
  const pendingToolResults: NormalizedToolResult[] = []

  for (const msg of request.messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      const { text } = extractOpenAIUserContent(msg)
      if (text) instructions.push(text)
      continue
    }

    if (msg.role === 'tool') {
      const result = normalizeOpenAIToolResult(msg)
      if (result) pendingToolResults.push(result)
      continue
    }

    if (msg.role === 'user') {
      const { text, images } = extractOpenAIUserContent(msg)
      turns.push({
        role: 'user',
        text,
        images: images.length > 0 ? images : undefined,
        toolResults: pendingToolResults.length > 0 ? [...pendingToolResults] : undefined,
      })
      pendingToolResults.length = 0
      continue
    }

    if (msg.role === 'assistant') {
      flushPendingToolResults(turns, pendingToolResults)
      const text = extractOpenAIAssistantText(msg)
      const toolCalls = normalizeOpenAIToolCalls(msg)
      turns.push({ role: 'assistant', text, toolCalls: toolCalls.length > 0 ? toolCalls : undefined })
    }
  }

  let currentInput: NormalizedCurrentInput = { text: '' }
  const lastTurn = turns.at(-1)
  if (lastTurn?.role === 'user') {
    currentInput = { text: lastTurn.text, images: lastTurn.images, toolResults: lastTurn.toolResults }
    turns.pop()
  } else {
    if (pendingToolResults.length > 0) {
      currentInput = { text: '', toolResults: [...pendingToolResults] }
      pendingToolResults.length = 0
    }
  }

  return {
    instructions,
    turns,
    tools: normalizeOpenAITools(request.tools),
    currentInput,
  }
}

function extractClaudeUserTurn(
  msg: ClaudeRequest['messages'][number],
): { text: string; images: KiroImage[]; toolResults: NormalizedToolResult[] } {
  const images: KiroImage[] = []
  const toolResults: NormalizedToolResult[] = []
  let text = ''

  if (typeof msg.content === 'string') {
    text = msg.content
  } else {
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) text += block.text
      else if (block.type === 'image' && block.source?.type === 'base64' && block.source.data && block.source.media_type) {
        images.push({ format: block.source.media_type.split('/')[1] || 'png', source: { bytes: block.source.data } })
      } else if (block.type === 'document' && block.source) {
        if (block.source.type === 'text' && block.source.data) text += (text ? '\n' : '') + block.source.data
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        let resultText = ''
        if (typeof block.content === 'string') resultText = block.content
        else if (Array.isArray(block.content)) resultText = block.content.map((item) => item.text || '').join('')
        toolResults.push({
          toolCallId: block.tool_use_id,
          text: resultText,
          status: (block as { is_error?: boolean }).is_error ? 'error' : 'success',
        })
      }
    }
  }

  return { text, images, toolResults }
}

function extractClaudeAssistantTurn(msg: ClaudeRequest['messages'][number]): NormalizedAssistantTurn {
  let text = ''
  const toolCalls: NormalizedToolCall[] = []

  if (typeof msg.content === 'string') {
    text = msg.content
  } else {
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) text += block.text
      else if (block.type === 'tool_use' && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: (block.input as Record<string, unknown>) || {},
        })
      }
    }
  }

  return { role: 'assistant', text, toolCalls: toolCalls.length > 0 ? toolCalls : undefined }
}

export function normalizeClaudeConversation(request: ClaudeRequest): NormalizedConversation {
  const instructions: string[] = []
  if (typeof request.system === 'string' && request.system) instructions.push(request.system)
  else if (Array.isArray(request.system)) instructions.push(...request.system.map((block) => block.text).filter(Boolean))

  const turns: NormalizedTurn[] = []
  for (const msg of request.messages) {
    if (msg.role === 'user') {
      const { text, images, toolResults } = extractClaudeUserTurn(msg)
      turns.push({ role: 'user', text, images: images.length > 0 ? images : undefined, toolResults: toolResults.length > 0 ? toolResults : undefined })
    } else {
      turns.push(extractClaudeAssistantTurn(msg))
    }
  }

  let currentInput: NormalizedCurrentInput = { text: '' }
  const lastTurn = turns.at(-1)
  if (lastTurn?.role === 'user') {
    currentInput = { text: lastTurn.text, images: lastTurn.images, toolResults: lastTurn.toolResults }
    turns.pop()
  }

  return {
    instructions,
    turns,
    tools: normalizeClaudeTools(request.tools),
    currentInput,
  }
}

function buildInstructionPreamble(instructions: string[]): string {
  if (instructions.length === 0) return ''
  return instructions.join('\n\n')
}

function mergeInstructionIntoCurrentInput(currentInput: NormalizedCurrentInput, instructions: string[]): NormalizedCurrentInput {
  const preamble = buildInstructionPreamble(instructions)
  if (!preamble) return currentInput
  return {
    ...currentInput,
    text: currentInput.text ? `${preamble}\n\n${currentInput.text}` : preamble,
  }
}

function ensureCurrentInput(currentInput: NormalizedCurrentInput, instructions: string[]): NormalizedCurrentInput {
  const merged = mergeInstructionIntoCurrentInput(currentInput, instructions)
  if (merged.text || merged.images?.length || merged.toolResults?.length) return merged
  return { text: buildInstructionPreamble(instructions) }
}

function splitCurrentToolResultsFromContinuation(
  turns: NormalizedTurn[],
  currentInput: NormalizedCurrentInput,
): { historyTurns: NormalizedTurn[]; currentInput: NormalizedCurrentInput } {
  if (!currentInput.toolResults?.length) return { historyTurns: turns, currentInput }

  const hasContinuationText = currentInput.text.trim() !== ''
  const hasContinuationImages = !!currentInput.images?.length
  if (!hasContinuationText && !hasContinuationImages) {
    return { historyTurns: turns, currentInput }
  }

  const historyTurns = [...turns]
  historyTurns.push({
    role: 'user',
    text: 'Tool results provided.',
    toolResults: currentInput.toolResults,
  })

  return {
    historyTurns,
    currentInput: {
      text: currentInput.text,
      images: currentInput.images,
    },
  }
}

function mirrorCurrentPlainUserTurnIntoHistory(
  turns: NormalizedTurn[],
  currentInput: NormalizedCurrentInput,
): NormalizedTurn[] {
  const hasPriorTurns = turns.length > 0
  const hasText = currentInput.text.trim() !== ''
  const hasToolResults = !!currentInput.toolResults?.length
  const lastTurn = turns.at(-1)
  const lastTurnIsAssistant = lastTurn?.role === 'assistant'
  if (!hasPriorTurns || !lastTurnIsAssistant || !hasText || hasToolResults) return turns

  return [
    ...turns,
    {
      role: 'user',
      text: currentInput.text,
      images: currentInput.images,
    },
  ]
}

function toKiroHistory(turns: NormalizedTurn[], modelId: string, origin: string) {
  return turns.map((turn) => {
    if (turn.role === 'assistant') {
      return {
        assistantResponseMessage: {
          content: turn.text,
          toolUses: turn.toolCalls?.map((call) => ({ toolUseId: call.id, name: call.name, input: call.input })),
        },
      }
    }

    return {
      userInputMessage: {
        content: turn.text,
        modelId,
        origin,
        images: turn.images,
        userInputMessageContext: turn.toolResults?.length
          ? {
              toolResults: turn.toolResults.map((result) => ({
                toolUseId: result.toolCallId,
                content: [{ text: result.text }],
                status: result.status,
              })),
            }
          : undefined,
      },
    }
  })
}

export function compileNormalizedConversationToKiroPayload(
  normalized: NormalizedConversation,
  modelId: string,
  origin: string,
  profileArn?: string,
  inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number },
  thinkingEnabled = false,
  conversationId?: string,
  thinkingBudget?: number,
  thinkingType?: 'enabled' | 'adaptive' | null,
  effortOverride?: string,
): KiroPayload {
  const split = splitCurrentToolResultsFromContinuation(normalized.turns, normalized.currentInput)
  const historyTurns = mirrorCurrentPlainUserTurnIntoHistory(split.historyTurns, split.currentInput)
  const currentInput = ensureCurrentInput(split.currentInput, normalized.instructions)
  const history = toKiroHistory(historyTurns, modelId, origin)
  const currentToolResults = currentInput.toolResults?.map((result) => ({
    toolUseId: result.toolCallId,
    content: [{ text: result.text }],
    status: result.status,
  })) || []

  return buildKiroPayload(
    currentInput.text,
    modelId,
    origin,
    history,
    normalizeToolDefinitions(normalized.tools),
    currentToolResults,
    currentInput.images || [],
    profileArn,
    inferenceConfig,
    thinkingEnabled,
    conversationId,
    thinkingBudget,
    thinkingType,
    effortOverride,
  )
}

export function openAIRequestToNormalizedKiroPayload(
  request: OpenAIChatRequest & { user?: string },
  profileArn?: string,
  thinkingEnabled = false,
  conversationId?: string,
  thinkingBudget?: number,
): KiroPayload {
  const normalized = normalizeOpenAIConversation(request)
  return compileNormalizedConversationToKiroPayload(
    normalized,
    mapModelIdOrThrow(request.model),
    'AI_EDITOR',
    profileArn,
    { maxTokens: request.max_tokens, temperature: request.temperature, topP: request.top_p },
    thinkingEnabled,
    conversationId,
    thinkingBudget,
  )
}

export function claudeRequestToNormalizedKiroPayload(
  request: ClaudeRequest,
  profileArn?: string,
  thinkingEnabled = false,
  conversationId?: string,
  thinkingBudget?: number,
  thinkingType?: 'enabled' | 'adaptive' | null,
  effortOverride?: string,
): KiroPayload {
  const normalized = normalizeClaudeConversation(request)
  return compileNormalizedConversationToKiroPayload(
    normalized,
    mapModelIdOrThrow(request.model),
    'AI_EDITOR',
    profileArn,
    { maxTokens: request.max_tokens, temperature: request.temperature, topP: request.top_p },
    thinkingEnabled,
    conversationId,
    thinkingBudget,
    thinkingType,
    effortOverride,
  )
}
