// KiroGate 流处理模块
// SSE 保活、Thinking 解析、Claude/OpenAI 流处理器，适配 Deno 环境
import type { KiroToolUse } from './types.ts'
import { logger } from './logger.ts'

// ============ 常量配置 ============
const THINKING_START_TAG = '<thinking>'
const THINKING_END_TAG = '</thinking>'
const MAX_THINKING_CHARS = 100000
const MAX_RESPONSE_BUFFER_CHARS = 2 * 1024 * 1024
const MAX_TOOL_INPUT_BUFFER_CHARS = 1024 * 1024

// 引号字符集（用于跳过被引用的 thinking 标签）
const QUOTE_CHARS = new Set(['`', '"', "'", '\\', '#', '!', '@', '$', '%', '^', '&', '*', '(', ')', '-', '_', '=', '+', '[', ']', '{', '}', ';', ':', '<', '>', ',', '.', '?', '/'])

// ============ Token 计数器 ============
export function countTokens(text: string): number {
  if (!text) return 0
  let tokens = 0
  const segments = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]+|[^\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]+/g)
  if (!segments) return 1
  for (const seg of segments) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(seg[0])) {
      const hanzi = (seg.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
      tokens += hanzi * 1.2 + (seg.length - hanzi) * 0.5
    } else {
      const words = seg.split(/\s+/).filter(w => w.length > 0)
      for (const w of words) tokens += w.length <= 4 ? 1 : Math.ceil(w.length / 3.5)
      tokens += (seg.match(/\s+/g) || []).length * 0.5
    }
  }
  return Math.max(1, Math.round(tokens))
}

// ============ Thinking 标签检测 ============
function isPrecededByQuoteChar(buffer: string, pos: number): boolean {
  if (pos <= 0) return false
  return QUOTE_CHARS.has(buffer[pos - 1])
}

function findRealThinkingStartTag(buffer: string): number {
  let searchStart = 0
  while (true) {
    const pos = buffer.indexOf(THINKING_START_TAG, searchStart)
    if (pos === -1) return -1
    if (!isPrecededByQuoteChar(buffer, pos)) return pos
    searchStart = pos + 1
  }
}

function findRealThinkingEndTag(buffer: string): number {
  let searchStart = 0
  while (true) {
    const pos = buffer.indexOf(THINKING_END_TAG, searchStart)
    if (pos === -1) return -1
    if (isPrecededByQuoteChar(buffer, pos)) { searchStart = pos + 1; continue }
    const afterPos = pos + THINKING_END_TAG.length
    const afterContent = buffer.slice(afterPos)
    if (afterContent.startsWith('\n\n')) return pos
    if (afterContent.length < 2) return -1
    searchStart = pos + 1
  }
}

function findRealThinkingEndTagAtBufferEnd(buffer: string): number {
  let searchStart = 0
  while (true) {
    const pos = buffer.indexOf(THINKING_END_TAG, searchStart)
    if (pos === -1) return -1
    if (isPrecededByQuoteChar(buffer, pos)) { searchStart = pos + 1; continue }
    const afterContent = buffer.slice(pos + THINKING_END_TAG.length)
    if (afterContent.trim() === '' || afterContent.startsWith('\n')) return pos
    searchStart = pos + 1
  }
}

function pendingTagSuffix(buffer: string, tag: string): number {
  if (!buffer || !tag) return 0
  const maxLen = Math.min(buffer.length, tag.length - 1)
  for (let length = maxLen; length > 0; length--) {
    let match = true
    const offset = buffer.length - length
    for (let i = 0; i < length; i++) {
      if (buffer.charCodeAt(offset + i) !== tag.charCodeAt(i)) { match = false; break }
    }
    if (match) return length
  }
  return 0
}

function generateThinkingSignature(thinking: string): string {
  const sample = thinking.slice(0, 32).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)
  return btoa(`kiro:${thinking.length}:${sample}`).replace(/=/g, '')
}

// ============ Thinking 缓冲解析器 ============
export class ThinkingBufferParser {
  private buffer = ''
  private inThinkBlock = false
  private pendingStartTagChars = 0
  private thinkingLength = 0
  private overflowWarned = false

  process(text: string): Array<{ type: 'thinking' | 'text'; content: string }> {
    const results: Array<{ type: 'thinking' | 'text'; content: string }> = []
    this.buffer += text

    while (this.buffer.length > 0) {
      if (this.pendingStartTagChars > 0) {
        if (this.buffer.length < this.pendingStartTagChars) {
          this.pendingStartTagChars -= this.buffer.length; this.buffer = ''; break
        }
        this.buffer = this.buffer.slice(this.pendingStartTagChars)
        this.pendingStartTagChars = 0
        if (!this.buffer) break
      }

      if (!this.inThinkBlock) {
        const start = findRealThinkingStartTag(this.buffer)
        if (start === -1) {
          const pending = pendingTagSuffix(this.buffer, THINKING_START_TAG)
          if (pending === this.buffer.length && pending > 0) {
            this.pendingStartTagChars = THINKING_START_TAG.length - pending
            this.inThinkBlock = true; this.thinkingLength = 0; this.buffer = ''; break
          }
          const emitLen = this.buffer.length - pending
          if (emitLen <= 0) break
          results.push({ type: 'text', content: this.buffer.slice(0, emitLen) })
          this.buffer = this.buffer.slice(emitLen)
        } else {
          const before = this.buffer.slice(0, start)
          if (before?.trim()) results.push({ type: 'text', content: before })
          this.buffer = this.buffer.slice(start + THINKING_START_TAG.length)
          this.inThinkBlock = true; this.thinkingLength = 0
        }
      } else {
        // 在 thinking 块中 - 溢出检测
        if (this.thinkingLength > MAX_THINKING_CHARS) {
          if (!this.overflowWarned) {
            logger.warn('ThinkingParser', `Thinking exceeded ${MAX_THINKING_CHARS} chars, forcing exit`)
            this.overflowWarned = true
          }
          if (this.buffer.length > 0) results.push({ type: 'thinking', content: this.buffer })
          this.buffer = ''; this.inThinkBlock = false; this.thinkingLength = 0; continue
        }
        // 大块快速路径
        const SAFE_THRESHOLD = 256
        if (this.buffer.length > SAFE_THRESHOLD) {
          const quickCheck = this.buffer.lastIndexOf('</', this.buffer.length - THINKING_END_TAG.length - 2)
          if (quickCheck === -1) {
            const safeLen = this.buffer.length - (THINKING_END_TAG.length + 2)
            if (safeLen > 0) {
              const chunk = this.buffer.slice(0, safeLen)
              results.push({ type: 'thinking', content: chunk })
              this.thinkingLength += chunk.length; this.buffer = this.buffer.slice(safeLen); continue
            }
          }
        }
        const end = findRealThinkingEndTag(this.buffer)
        if (end === -1) {
          const THINKING_END_WITH_NL = THINKING_END_TAG + '\n\n'
          const pending = Math.max(pendingTagSuffix(this.buffer, THINKING_END_TAG), pendingTagSuffix(this.buffer, THINKING_END_WITH_NL))
          const emitLen = this.buffer.length - pending
          if (emitLen <= 0) break
          const thinkChunk = this.buffer.slice(0, emitLen)
          if (thinkChunk) { results.push({ type: 'thinking', content: thinkChunk }); this.thinkingLength += thinkChunk.length }
          this.buffer = this.buffer.slice(emitLen)
        } else {
          const thinkChunk = this.buffer.slice(0, end)
          if (thinkChunk) { results.push({ type: 'thinking', content: thinkChunk }); this.thinkingLength += thinkChunk.length }
          this.buffer = this.buffer.slice(end + THINKING_END_TAG.length)
          this.inThinkBlock = false; this.thinkingLength = 0; this.overflowWarned = false
        }
      }
    }
    return results
  }
  finish(): Array<{ type: 'thinking' | 'text'; content: string }> {
    const results: Array<{ type: 'thinking' | 'text'; content: string }> = []
    if (this.buffer) {
      if (this.inThinkBlock) {
        const end = findRealThinkingEndTagAtBufferEnd(this.buffer)
        if (end !== -1) {
          const thinkChunk = this.buffer.slice(0, end)
          if (thinkChunk) results.push({ type: 'thinking', content: thinkChunk })
          const remaining = this.buffer.slice(end + THINKING_END_TAG.length).trim()
          if (remaining) results.push({ type: 'text', content: remaining })
        } else { results.push({ type: 'thinking', content: this.buffer }) }
      } else { results.push({ type: 'text', content: this.buffer }) }
      this.buffer = ''
    }
    this.inThinkBlock = false; this.thinkingLength = 0; this.overflowWarned = false
    return results
  }

  isInThinkBlock(): boolean { return this.inThinkBlock }
  getThinkingLength(): number { return this.thinkingLength }
  reset(): void { this.buffer = ''; this.inThinkBlock = false; this.pendingStartTagChars = 0; this.thinkingLength = 0; this.overflowWarned = false }
}

// ============ SSE 状态管理器（ClaudeStreamHandler 内部使用）============
class SSEStateManager {
  private state: 'initial' | 'message_started' | 'message_ended' = 'initial'
  private contentBlockOpen = false
  private contentBlockIdx = -1

  onMessageStart() { this.state = 'message_started' }
  onContentBlockStart() { this.contentBlockOpen = true; this.contentBlockIdx++ }
  onContentBlockStop() { this.contentBlockOpen = false }
  onMessageStop() { this.state = 'message_ended' }
  getCurrentIndex(): number { return this.contentBlockIdx }
  isContentBlockOpen(): boolean { return this.contentBlockOpen }
  canSendMessageStart(): boolean { return this.state === 'initial' }
}

// ============ SSE 事件构建器 ============
function sseFormat(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
}

export const claudeSSE = {
  messageStart: (id: string, model: string, inputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number) => {
    const usage: Record<string, number> = { input_tokens: inputTokens, output_tokens: 0 }
    if (cacheReadTokens && cacheReadTokens > 0) usage.cache_read_input_tokens = cacheReadTokens
    if (cacheWriteTokens && cacheWriteTokens > 0) usage.cache_creation_input_tokens = cacheWriteTokens
    return sseFormat('message_start', { type: 'message_start', message: {
      id, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage
    }})
  },
  contentBlockStart: (index: number, blockType: 'text' | 'thinking' | 'tool_use', toolUseId?: string, toolName?: string) => {
    const contentBlock: Record<string, unknown> = { type: blockType }
    if (blockType === 'text') contentBlock.text = ''
    else if (blockType === 'thinking') { contentBlock.thinking = ''; contentBlock.signature = '' }
    else if (blockType === 'tool_use') { contentBlock.id = toolUseId; contentBlock.name = toolName; contentBlock.input = {} }
    return sseFormat('content_block_start', { type: 'content_block_start', index, content_block: contentBlock })
  },
  contentBlockDelta: (index: number, deltaType: 'text_delta' | 'thinking_delta' | 'input_json_delta' | 'signature_delta', content: string) => {
    let delta: Record<string, unknown>
    if (deltaType === 'text_delta') delta = { type: 'text_delta', text: content }
    else if (deltaType === 'thinking_delta') delta = { type: 'thinking_delta', thinking: content }
    else if (deltaType === 'signature_delta') delta = { type: 'signature_delta', signature: content }
    else delta = { type: 'input_json_delta', partial_json: content }
    return sseFormat('content_block_delta', { type: 'content_block_delta', index, delta })
  },
  contentBlockStop: (index: number) => sseFormat('content_block_stop', { type: 'content_block_stop', index }),
  messageDelta: (stopReason: string, outputTokens: number, inputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number) => {
    const usage: Record<string, number> = { output_tokens: outputTokens }
    if (inputTokens !== undefined) usage.input_tokens = inputTokens
    if (cacheReadTokens && cacheReadTokens > 0) usage.cache_read_input_tokens = cacheReadTokens
    if (cacheWriteTokens && cacheWriteTokens > 0) usage.cache_creation_input_tokens = cacheWriteTokens
    return sseFormat('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage })
  },
  messageStop: () => sseFormat('message_stop', { type: 'message_stop' }),
  ping: () => sseFormat('ping', { type: 'ping' }),
  error: (message: string) => sseFormat('error', { type: 'error', error: { type: 'api_error', message } })
}

export const openaiSSE = {
  chunk: (id: string, model: string, content?: string, role?: string, toolCalls?: unknown[], finishReason: string | null = null, usage?: unknown, reasoningContent?: string) => {
    const delta: Record<string, unknown> = {}
    if (role) delta.role = role
    if (content !== undefined) delta.content = content
    if (reasoningContent !== undefined) delta.reasoning_content = reasoningContent
    if (toolCalls) delta.tool_calls = toolCalls
    const chunk: Record<string, unknown> = {
      id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    }
    if (usage) chunk.usage = usage
    return `data: ${JSON.stringify(chunk)}\n\n`
  },
  done: () => 'data: [DONE]\n\n'
}

// ============ Claude 流处理器 ============
export interface ClaudeStreamHandlerOptions {
  model: string; inputTokens: number; messageId?: string
  onWrite: (data: string) => boolean
  enableThinkingParsing?: boolean
  cacheReadTokens?: number; cacheWriteTokens?: number
}

export class ClaudeStreamHandler {
  private model: string
  private inputTokens: number
  private messageId: string
  private onWrite: (data: string) => boolean
  private enableThinkingParsing: boolean
  private cacheReadTokens?: number
  private cacheWriteTokens?: number
  private stateManager = new SSEStateManager()
  private thinkingParser = new ThinkingBufferParser()
  private responseBuffer: string[] = []
  private thinkingBuffer: string[] = []
  private outputTokens = 0
  private responseBufferSize = 0
  private thinkingBufferSize = 0
  private bufferOverflowWarned = false
  private currentBlockType: 'text' | 'thinking' | 'tool_use' | null = null
  private contentBlockIndex = -1
  private contentBlockStartSent = false
  private currentToolUse: { id: string; name: string; inputBuffer: string[]; inputBufferSize: number } | null = null
  private processedToolUseIds = new Set<string>()
  private toolCalls: KiroToolUse[] = []
  private responseEnded = false
  private stopReasonOverride: string | null = null

  constructor(options: ClaudeStreamHandlerOptions) {
    this.model = options.model; this.inputTokens = options.inputTokens
    this.messageId = options.messageId || `msg_${crypto.randomUUID()}`
    this.onWrite = options.onWrite
    this.enableThinkingParsing = options.enableThinkingParsing ?? true
    this.cacheReadTokens = options.cacheReadTokens; this.cacheWriteTokens = options.cacheWriteTokens
  }

  sendMessageStart(): void {
    if (!this.stateManager.canSendMessageStart()) return
    this.onWrite(claudeSSE.messageStart(this.messageId, this.model, this.inputTokens, this.cacheReadTokens, this.cacheWriteTokens))
    this.stateManager.onMessageStart()
  }
  handleContent(content: string): void {
    if (this.responseEnded || !content) return
    this.outputTokens += countTokens(content)
    if (this.enableThinkingParsing) {
      for (const item of this.thinkingParser.process(content)) {
        if (item.type === 'thinking') this.emitThinking(item.content)
        else this.emitText(item.content)
      }
    } else { this.emitText(content) }
  }

  private emitThinking(content: string): void {
    if (!content) return
    if (this.thinkingBufferSize + content.length > MAX_RESPONSE_BUFFER_CHARS) {
      if (!this.bufferOverflowWarned) { this.bufferOverflowWarned = true }
      if (this.currentBlockType !== 'thinking') { this.closeCurrentBlock(); this.startContentBlock('thinking') }
      this.onWrite(claudeSSE.contentBlockDelta(this.contentBlockIndex, 'thinking_delta', content)); return
    }
    if (this.currentBlockType !== 'thinking') { this.closeCurrentBlock(); this.startContentBlock('thinking') }
    this.thinkingBuffer.push(content); this.thinkingBufferSize += content.length
    this.onWrite(claudeSSE.contentBlockDelta(this.contentBlockIndex, 'thinking_delta', content))
  }

  private emitText(content: string): void {
    if (!content) return
    if (this.responseBufferSize + content.length > MAX_RESPONSE_BUFFER_CHARS) {
      if (!this.bufferOverflowWarned) { this.bufferOverflowWarned = true }
      if (this.currentBlockType !== 'text') { this.closeCurrentBlock(); this.startContentBlock('text') }
      this.onWrite(claudeSSE.contentBlockDelta(this.contentBlockIndex, 'text_delta', content)); return
    }
    if (this.currentBlockType !== 'text') { this.closeCurrentBlock(); this.startContentBlock('text') }
    this.responseBuffer.push(content); this.responseBufferSize += content.length
    this.onWrite(claudeSSE.contentBlockDelta(this.contentBlockIndex, 'text_delta', content))
  }

  private startContentBlock(blockType: 'text' | 'thinking' | 'tool_use', toolUseId?: string, toolName?: string): void {
    this.contentBlockIndex++; this.currentBlockType = blockType; this.contentBlockStartSent = true
    this.stateManager.onContentBlockStart()
    this.onWrite(claudeSSE.contentBlockStart(this.contentBlockIndex, blockType, toolUseId, toolName))
  }

  private closeCurrentBlock(): void {
    if (this.currentBlockType && this.contentBlockStartSent) {
      // Emit signature_delta before closing thinking blocks (required by Anthropic protocol)
      if (this.currentBlockType === 'thinking') {
        const signature = generateThinkingSignature(this.thinkingBuffer.join(''))
        this.onWrite(claudeSSE.contentBlockDelta(this.contentBlockIndex, 'signature_delta', signature))
      }
      this.onWrite(claudeSSE.contentBlockStop(this.contentBlockIndex))
      this.stateManager.onContentBlockStop()
      this.currentBlockType = null; this.contentBlockStartSent = false
    }
  }

  handleToolUse(toolUseId: string | undefined, toolName: string | undefined, toolInput: unknown, isStop: boolean): void {
    if (this.responseEnded) return
    const safeAdd = (fragment: string): boolean => {
      if (!this.currentToolUse) return false
      if (this.currentToolUse.inputBufferSize + fragment.length > MAX_TOOL_INPUT_BUFFER_CHARS) {
        this.onWrite(claudeSSE.contentBlockDelta(this.contentBlockIndex, 'input_json_delta', fragment)); return false
      }
      this.currentToolUse.inputBuffer.push(fragment); this.currentToolUse.inputBufferSize += fragment.length
      this.onWrite(claudeSSE.contentBlockDelta(this.contentBlockIndex, 'input_json_delta', fragment)); return true
    }
    // 独立 input/stop 事件
    if (!toolUseId && !toolName) {
      if (this.currentToolUse) {
        if (toolInput !== undefined && toolInput !== null) {
          const frag = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput)
          if (frag) safeAdd(frag)
        }
        if (isStop) this.finishToolUse()
      }
      return
    }
    // 新工具调用
    if (toolUseId && toolName && !this.currentToolUse) {
      if (this.processedToolUseIds.has(toolUseId)) return
      this.closeCurrentBlock(); this.processedToolUseIds.add(toolUseId)
      this.startContentBlock('tool_use', toolUseId, toolName)
      this.currentToolUse = { id: toolUseId, name: toolName, inputBuffer: [], inputBufferSize: 0 }
      if (toolInput !== undefined && toolInput !== null) {
        const frag = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput)
        if (frag) safeAdd(frag)
      }
      if (isStop) this.finishToolUse()
      return
    }
    // 累积输入
    if (this.currentToolUse && toolInput !== undefined && toolInput !== null) {
      const frag = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput)
      if (frag) safeAdd(frag)
    }
    if (isStop && this.currentToolUse) this.finishToolUse()
  }

  private finishToolUse(): void {
    if (!this.currentToolUse) return
    const fullInput = this.currentToolUse.inputBuffer.join('')
    let parsedInput: Record<string, unknown> = {}
    try { if (fullInput) parsedInput = JSON.parse(fullInput) }
    catch { parsedInput = { _error: 'Failed to parse tool input', _raw: fullInput.slice(0, 500) } }
    this.toolCalls.push({ toolUseId: this.currentToolUse.id, name: this.currentToolUse.name, input: parsedInput })
    this.closeCurrentBlock(); this.currentToolUse = null
  }

  finish(usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; truncated?: boolean; contextWindowExceeded?: boolean }): void {
    if (this.responseEnded) return
    this.responseEnded = true
    if (this.enableThinkingParsing) {
      for (const item of this.thinkingParser.finish()) {
        if (item.type === 'thinking') this.emitThinking(item.content)
        else this.emitText(item.content)
      }
    }
    this.closeCurrentBlock()
    const stopReason = this.stopReasonOverride || (((usage as { truncated?: boolean; contextWindowExceeded?: boolean }).truncated || (usage as { truncated?: boolean; contextWindowExceeded?: boolean }).contextWindowExceeded)
      ? 'max_tokens'
      : (this.toolCalls.length > 0 ? 'tool_use' : 'end_turn'))
    const finalOutputTokens = this.outputTokens > 0 ? this.outputTokens : countTokens(this.responseBuffer.join(''))
    this.onWrite(claudeSSE.messageDelta(stopReason, finalOutputTokens, usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens))
    this.onWrite(claudeSSE.messageStop()); this.stateManager.onMessageStop()
  }

  sendError(message: string): void { this.onWrite(claudeSSE.error(message)) }
  handleContentLengthExceeded(): void { this.stopReasonOverride = 'max_tokens' }
  handleThinkingOverflow(): void {
    if (this.enableThinkingParsing) this.thinkingParser.reset()
    if (this.currentBlockType === 'thinking') this.closeCurrentBlock()
  }
  getToolCalls(): KiroToolUse[] { return this.toolCalls }
  getResponseText(): string { return this.responseBuffer.join('') }
  getThinkingText(): string { return this.thinkingBuffer.join('') }
  getOutputTokens(): number { return this.outputTokens }
  isEnded(): boolean { return this.responseEnded }
  getMessageId(): string { return this.messageId }
  getContentBlockIndex(): number { return this.contentBlockIndex }
}
// ============ OpenAI 流处理器 ============
export interface OpenAIStreamHandlerOptions {
  model: string; requestId?: string
  onWrite: (data: string) => boolean
  enableThinkingParsing?: boolean
}

export class OpenAIStreamHandler {
  private model: string
  private requestId: string
  private onWrite: (data: string) => boolean
  private enableThinkingParsing: boolean
  private thinkingParser = new ThinkingBufferParser()
  private responseBuffer: string[] = []
  private thinkingBuffer: string[] = []
  private outputTokens = 0
  private started = false
  private responseBufferSize = 0
  private thinkingBufferSize = 0
  private bufferOverflowWarned = false
  private toolCalls: Array<{ id: string; name: string; arguments: string }> = []
  private currentToolCall: { id: string; name: string; index: number; argumentsBuffer: string[]; argumentsBufferSize: number } | null = null
  private toolCallIndex = 0
  private processedToolUseIds = new Set<string>()
  private responseEnded = false
  private stopReasonOverride: string | null = null

  constructor(options: OpenAIStreamHandlerOptions) {
    this.model = options.model
    this.requestId = options.requestId || `chatcmpl-${crypto.randomUUID()}`
    this.onWrite = options.onWrite
    this.enableThinkingParsing = options.enableThinkingParsing ?? false
  }

  sendInitial(): void {
    if (this.started) return
    this.started = true
    this.onWrite(openaiSSE.chunk(this.requestId, this.model, undefined, 'assistant'))
  }

  handleContent(content: string): void {
    if (this.responseEnded || !content) return
    if (!this.started) this.sendInitial()
    this.outputTokens += countTokens(content)
    if (this.enableThinkingParsing) {
      for (const item of this.thinkingParser.process(content)) {
        if (item.type === 'thinking') this.emitReasoning(item.content)
        else this.emitContent(item.content)
      }
    } else { this.emitContent(content) }
  }

  private emitReasoning(content: string): void {
    if (!content) return
    if (this.thinkingBufferSize + content.length > MAX_RESPONSE_BUFFER_CHARS) {
      if (!this.bufferOverflowWarned) this.bufferOverflowWarned = true
      this.onWrite(openaiSSE.chunk(this.requestId, this.model, undefined, undefined, undefined, null, undefined, content)); return
    }
    this.thinkingBuffer.push(content); this.thinkingBufferSize += content.length
    this.onWrite(openaiSSE.chunk(this.requestId, this.model, undefined, undefined, undefined, null, undefined, content))
  }

  private emitContent(content: string): void {
    if (!content) return
    if (this.responseBufferSize + content.length > MAX_RESPONSE_BUFFER_CHARS) {
      if (!this.bufferOverflowWarned) this.bufferOverflowWarned = true
      this.onWrite(openaiSSE.chunk(this.requestId, this.model, content)); return
    }
    this.responseBuffer.push(content); this.responseBufferSize += content.length
    this.onWrite(openaiSSE.chunk(this.requestId, this.model, content))
  }
  handleToolUse(toolUseId: string | undefined, toolName: string | undefined, toolInput: unknown, isStop: boolean): void {
    if (this.responseEnded) return
    const safeAdd = (fragment: string): boolean => {
      if (!this.currentToolCall) return false
      if (this.currentToolCall.argumentsBufferSize + fragment.length > MAX_TOOL_INPUT_BUFFER_CHARS) {
        this.onWrite(openaiSSE.chunk(this.requestId, this.model, undefined, undefined, [{ index: this.currentToolCall.index, function: { arguments: fragment } }]))
        return false
      }
      this.currentToolCall.argumentsBuffer.push(fragment); this.currentToolCall.argumentsBufferSize += fragment.length
      this.onWrite(openaiSSE.chunk(this.requestId, this.model, undefined, undefined, [{ index: this.currentToolCall.index, function: { arguments: fragment } }]))
      return true
    }
    if (!toolUseId && !toolName) {
      if (this.currentToolCall) {
        if (toolInput !== undefined && toolInput !== null) {
          const frag = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput)
          if (frag) safeAdd(frag)
        }
        if (isStop) this.finishToolCall()
      }
      return
    }
    if (toolUseId && toolName && !this.currentToolCall) {
      if (this.processedToolUseIds.has(toolUseId)) return
      this.processedToolUseIds.add(toolUseId)
      this.currentToolCall = { id: toolUseId, name: toolName, index: this.toolCallIndex, argumentsBuffer: [], argumentsBufferSize: 0 }
      this.onWrite(openaiSSE.chunk(this.requestId, this.model, undefined, undefined, [{ index: this.toolCallIndex, id: toolUseId, type: 'function', function: { name: toolName, arguments: '' } }]))
      if (toolInput !== undefined && toolInput !== null) {
        const frag = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput)
        if (frag) safeAdd(frag)
      }
      if (isStop) this.finishToolCall()
      return
    }
    if (this.currentToolCall && toolInput !== undefined && toolInput !== null) {
      const frag = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput)
      if (frag) safeAdd(frag)
    }
    if (isStop && this.currentToolCall) this.finishToolCall()
  }

  private finishToolCall(): void {
    if (!this.currentToolCall) return
    this.toolCalls.push({ id: this.currentToolCall.id, name: this.currentToolCall.name, arguments: this.currentToolCall.argumentsBuffer.join('') })
    this.toolCallIndex++; this.currentToolCall = null
  }

  finish(usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; truncated?: boolean; contextWindowExceeded?: boolean }): void {
    if (this.responseEnded) return
    this.responseEnded = true
    if (this.enableThinkingParsing) {
      for (const item of this.thinkingParser.finish()) {
        if (item.type === 'thinking') this.emitReasoning(item.content)
        else this.emitContent(item.content)
      }
    }
    const finishReason = this.stopReasonOverride || ((usage.truncated || usage.contextWindowExceeded)
      ? 'length'
      : (this.toolCalls.length > 0 ? 'tool_calls' : 'stop'))
    const finalOutputTokens = this.outputTokens > 0 ? this.outputTokens : countTokens(this.responseBuffer.join(''))
    const reasoningTokens = usage.reasoningTokens || (this.thinkingBuffer.length > 0 ? countTokens(this.thinkingBuffer.join('')) : 0)
    const usageInfo: Record<string, unknown> = {
      prompt_tokens: usage.inputTokens, completion_tokens: finalOutputTokens,
      total_tokens: usage.inputTokens + finalOutputTokens
    }
    if (usage.cacheReadTokens && usage.cacheReadTokens > 0) usageInfo.prompt_tokens_details = { cached_tokens: usage.cacheReadTokens }
    if (reasoningTokens > 0) usageInfo.completion_tokens_details = { reasoning_tokens: reasoningTokens }
    this.onWrite(openaiSSE.chunk(this.requestId, this.model, undefined, undefined, undefined, finishReason, usageInfo))
    this.onWrite(openaiSSE.done())
  }

  handleContentLengthExceeded(): void { this.stopReasonOverride = 'length' }
  handleThinkingOverflow(): void { if (this.enableThinkingParsing) this.thinkingParser.reset() }
  getToolCalls(): Array<{ id: string; name: string; arguments: string }> { return this.toolCalls }
  getResponseText(): string { return this.responseBuffer.join('') }
  getThinkingText(): string { return this.thinkingBuffer.join('') }
  getOutputTokens(): number { return this.outputTokens }
  isEnded(): boolean { return this.responseEnded }
  getRequestId(): string { return this.requestId }
}
