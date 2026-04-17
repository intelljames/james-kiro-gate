// KiroGate Kiro API 客户端
// 移植自源项目 kiroApi.ts，适配 Deno 环境
import type {
  KiroPayload, KiroUserInputMessage, KiroHistoryMessage,
  KiroToolWrapper, KiroToolResult, KiroImage, KiroToolUse,
  KiroToolUseStream, KiroModel, EndpointHealth, ProxyAccount
} from './types.ts'
import { logger } from './logger.ts'

// ============ 常量配置 ============
const KIRO_API_REGION = 'us-east-1'
const KIRO_VERSION = '0.9.40'
const KIRO_SDK_VERSION = '1.0.27'
const AGENT_MODE_SPEC = 'spec'
const AGENT_MODE_VIBE = 'vibe'
const KIRO_CLI_USER_AGENT = 'aws-sdk-rust/1.3.9 os/macos lang/rust/1.87.0'
const KIRO_CLI_AMZ_USER_AGENT = 'aws-sdk-rust/1.3.9 ua/2.1 api/ssooidc/1.88.0 os/macos lang/rust/1.87.0 m/E app/AmazonQ-For-CLI'

export const DEFAULT_THINKING_BUDGET = 200000
export const MAX_THINKING_BUDGET = 200000

type StreamUsage = {
  inputTokens: number
  outputTokens: number
  credits: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  contextWindowExceeded?: boolean
  truncated?: boolean
}

type StreamDebugInfo = {
  requestID?: string
  endpointName?: string
  modelId?: string
  payloadBytes?: number
  historyCount?: number
  toolCount?: number
  thinkingEnabled?: boolean
  hasReasoningConfig?: boolean
  reasoningBudget?: number
}

function previewText(value: string | undefined, limit = 800): string {
  if (!value) return ''
  return value.length > limit ? `${value.slice(0, limit)} ...[truncated ${value.length - limit} chars]` : value
}

export function summarizeKiroPayload(payload: KiroPayload): Record<string, unknown> {
  const current = payload.conversationState.currentMessage.userInputMessage
  const history = payload.conversationState.history || []
  return {
    conversationId: payload.conversationState.conversationId,
    agentTaskType: payload.conversationState.agentTaskType,
    current: {
      modelId: current.modelId,
      origin: current.origin,
      contentLength: current.content.length,
      contentPreview: previewText(current.content),
      imageCount: current.images?.length || 0,
      toolCount: current.userInputMessageContext?.tools?.length || 0,
      toolResultCount: current.userInputMessageContext?.toolResults?.length || 0,
      toolNames: current.userInputMessageContext?.tools?.map((t) => t.toolSpecification.name).slice(0, 20) || [],
    },
    historyCount: history.length,
    historyPreview: history.slice(-6).map((item, index) => ({
      index: history.length - Math.min(history.length, 6) + index,
      role: item.userInputMessage ? 'user' : 'assistant',
      contentLength: item.userInputMessage?.content?.length || item.assistantResponseMessage?.content?.length || 0,
      contentPreview: previewText(item.userInputMessage?.content || item.assistantResponseMessage?.content),
      toolCount: item.userInputMessage?.userInputMessageContext?.tools?.length || item.assistantResponseMessage?.toolUses?.length || 0,
      toolResultCount: item.userInputMessage?.userInputMessageContext?.toolResults?.length || 0,
    })),
    inferenceConfig: payload.inferenceConfig,
    profileArnPresent: !!payload.profileArn,
  }
}

const KIRO_ENDPOINTS = [
  {
    url: `https://codewhisperer.${KIRO_API_REGION}.amazonaws.com/generateAssistantResponse`,
    origin: 'AI_EDITOR',
    amzTarget: 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
    name: 'CodeWhisperer'
  },
  {
    url: `https://q.${KIRO_API_REGION}.amazonaws.com/generateAssistantResponse`,
    origin: 'CLI',
    amzTarget: 'AmazonQDeveloperStreamingService.SendMessage',
    name: 'AmazonQ'
  }
]

const API_CONFIG = {
  requestTimeout: 300000,
  maxRetriesPerEndpoint: 1,
  maxTotalRetries: 3,
  retryBaseDelay: 50,
  retryMaxDelay: 500,
  pingInterval: 20000,
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNREFUSED', 'fetch failed']
}

// ============ DNS 缓存 ============
interface DnsCacheEntry { ips: string[]; timestamp: number; failCount: number }
const dnsCache = new Map<string, DnsCacheEntry>()
const DNS_CACHE_TTL = 300000
const DNS_STALE_TTL = 1800000

// Deno 环境下使用 Deno.resolveDns 替代 Node dns
async function resolveDNS(hostname: string): Promise<string[]> {
  const now = Date.now()
  const cached = dnsCache.get(hostname)
  if (cached && now - cached.timestamp < DNS_CACHE_TTL) return cached.ips
  try {
    const ips = await Deno.resolveDns(hostname, 'A')
    if (ips.length > 0) {
      dnsCache.set(hostname, { ips, timestamp: now, failCount: 0 })
      return ips
    }
  } catch {
    if (cached && now - cached.timestamp < DNS_STALE_TTL) {
      cached.failCount++
      logger.warn('DNS', `Resolve failed for ${hostname}, using stale cache`)
      return cached.ips
    }
  }
  return []
}

export function getDNSCacheStats() {
  const now = Date.now()
  const hosts = Array.from(dnsCache.entries()).map(([hostname, entry]) => ({
    hostname, ips: entry.ips, ageMs: now - entry.timestamp, stale: now - entry.timestamp >= DNS_CACHE_TTL
  }))
  return { entries: dnsCache.size, hosts }
}

// 预热 DNS
export async function prewarmDNS(): Promise<void> {
  const hosts = [
    `codewhisperer.${KIRO_API_REGION}.amazonaws.com`,
    `q.${KIRO_API_REGION}.amazonaws.com`
  ]
  await Promise.allSettled(hosts.map(h => resolveDNS(h)))
  logger.info('KiroAPI', 'DNS prewarmed')
}

// ============ 端点健康度 ============
const endpointHealthMap = new Map<string, EndpointHealth>()

function getEndpointHealth(name: string): EndpointHealth {
  let health = endpointHealthMap.get(name)
  if (!health) {
    health = { totalRequests: 0, successCount: 0, failCount: 0, avgLatencyMs: 0, lastFailTime: 0, lastSuccessTime: 0, consecutiveErrors: 0 }
    endpointHealthMap.set(name, health)
  }
  return health
}

function recordEndpointSuccess(name: string, latencyMs: number): void {
  const h = getEndpointHealth(name)
  h.totalRequests++; h.successCount++; h.consecutiveErrors = 0; h.lastSuccessTime = Date.now()
  h.avgLatencyMs = h.avgLatencyMs === 0 ? latencyMs : h.avgLatencyMs * 0.7 + latencyMs * 0.3
}

function recordEndpointFailure(name: string): void {
  const h = getEndpointHealth(name)
  h.totalRequests++; h.failCount++; h.consecutiveErrors++; h.lastFailTime = Date.now()
}

export function getEndpointHealthStats(): Record<string, EndpointHealth> {
  const result: Record<string, EndpointHealth> = {}
  for (const [name, health] of endpointHealthMap) result[name] = { ...health }
  return result
}

// ============ MachineId 生成 ============
function normalizeMachineId(machineId: string): string | null {
  const trimmed = machineId.trim()
  if (trimmed.length === 64 && /^[0-9a-fA-F]+$/.test(trimmed)) return trimmed.toLowerCase()
  const noDashes = trimmed.replace(/-/g, '')
  if (noDashes.length === 32 && /^[0-9a-fA-F]+$/.test(noDashes)) return (noDashes + noDashes).toLowerCase()
  return null
}

async function generateMachineIdFromRefreshToken(refreshToken: string): Promise<string> {
  const data = new TextEncoder().encode(`KotlinNativeAPI/${refreshToken}`)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function getMachineId(account: ProxyAccount): Promise<string | null> {
  if (account.machineId) {
    const normalized = normalizeMachineId(account.machineId)
    if (normalized) return normalized
  }
  if (account.refreshToken) return await generateMachineIdFromRefreshToken(account.refreshToken)
  return null
}

async function buildUserAgent(account: ProxyAccount): Promise<{ userAgent: string; amzUserAgent: string; isIDE: boolean }> {
  const machineId = await getMachineId(account)
  if (machineId) {
    const kiroSuffix = `KiroIDE-${KIRO_VERSION}-${machineId}`
    return {
      userAgent: `aws-sdk-js/${KIRO_SDK_VERSION} ua/2.1 os/windows lang/js md/nodejs#20.16.0 api/codewhispererstreaming#${KIRO_SDK_VERSION} m/E ${kiroSuffix}`,
      amzUserAgent: `aws-sdk-js/${KIRO_SDK_VERSION} KiroIDE ${KIRO_VERSION} ${machineId}`,
      isIDE: true
    }
  }
  return { userAgent: KIRO_CLI_USER_AGENT, amzUserAgent: KIRO_CLI_AMZ_USER_AGENT, isIDE: false }
}

// ============ 动态模型映射 ============
let cachedKiroModels: KiroModel[] = []
let modelCacheTimestamp = 0
const MODEL_CACHE_TTL = 5 * 60 * 1000

export function updateModelCache(models: KiroModel[]): void {
  cachedKiroModels = models; modelCacheTimestamp = Date.now()
  logger.info('KiroAPI', `Model cache updated: ${models.map(m => m.modelId).join(', ')}`)
}
export function getCachedModels(): KiroModel[] { return cachedKiroModels }
export function isModelCacheValid(): boolean { return cachedKiroModels.length > 0 && (Date.now() - modelCacheTimestamp) < MODEL_CACHE_TTL }

const GPT_COMPATIBILITY_MAP: Record<string, string> = {
  'gpt-4': 'claude-sonnet-4.5', 'gpt-4o': 'claude-sonnet-4.5',
  'gpt-4-turbo': 'claude-sonnet-4.5', 'gpt-3.5-turbo': 'claude-sonnet-4.5', 'gpt-4o-mini': 'claude-haiku-4.5'
}
const DEFAULT_MODEL = 'claude-sonnet-4.5'

function normalizeModelId(model: string): string {
  let n = model.toLowerCase().trim()
  n = n.replace(/(\d)-(\d)/g, '$1.$2').replace(/(\d)_(\d)/g, '$1.$2')
  n = n.replace(/^anthropic\//, '').replace(/^claude-code\//, '')
  n = n.replace(/-\d{8}$/, '')
  return n
}

export function mapModelId(model: string): string | null {
  const normalized = normalizeModelId(model)
  const lower = model.toLowerCase()
  if (lower === 'auto') return 'auto'
  if (cachedKiroModels.length > 0) {
    const exact = cachedKiroModels.find(m => m.modelId.toLowerCase() === normalized || m.modelId.toLowerCase() === lower)
    if (exact) return exact.modelId
    const variant = cachedKiroModels.find(m => normalizeModelId(m.modelId) === normalized)
    if (variant) return variant.modelId
    const contains = cachedKiroModels.find(m => normalized.includes(normalizeModelId(m.modelId)))
    if (contains) return contains.modelId
  }
  for (const [key, value] of Object.entries(GPT_COMPATIBILITY_MAP)) {
    if (lower.includes(key)) {
      if (cachedKiroModels.length > 0) {
        const target = cachedKiroModels.find(m => normalizeModelId(m.modelId) === normalizeModelId(value))
        if (target) return target.modelId
      }
      return value
    }
  }
  if (cachedKiroModels.length > 0) {
    logger.warn('KiroAPI', `Model not found: ${model}. Available: ${cachedKiroModels.map(m => m.modelId).join(', ')}`)
    return null
  }
  return DEFAULT_MODEL
}

export function mapModelIdOrThrow(model: string): string {
  const mapped = mapModelId(model)
  if (mapped === null) throw new Error(`Model "${model}" is not available. Available: ${cachedKiroModels.map(m => m.modelId).join(', ') || 'none'}`)
  return mapped
}

export function isModelAvailable(model: string): boolean { return mapModelId(model) !== null }

// ============ Agentic 系统提示 ============
const AGENTIC_SYSTEM_PROMPT = `File operations limit: max 600 lines per write. For larger files, use chunked writes (400-500 lines each). Use Edit for modifications instead of full rewrites.
When the Write or Edit tool has content size limits, always comply silently. Never suggest bypassing these limits via alternative tools. Never ask the user whether to switch approaches. Complete all chunked operations without commentary.`

// Thinking 模式标签构建
function buildThinkingModePrompt(
  budgetTokens: number = DEFAULT_THINKING_BUDGET,
  thinkingType: 'enabled' | 'adaptive' | null = 'enabled',
  effortOverride?: string
): string {
  const budget = Math.min(budgetTokens, MAX_THINKING_BUDGET)
  if (thinkingType === 'adaptive') {
    let effort = effortOverride || 'high'
    if (!effortOverride) {
      if (budget <= 1280) effort = 'low'
      else if (budget <= 2048) effort = 'medium'
    }
    return `<thinking_mode>adaptive</thinking_mode>\n<thinking_effort>${effort}</thinking_effort>`
  }
  return `<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>${budget}</max_thinking_length>`
}

// 注入系统提示
export function injectSystemPrompts(
  content: string, isAgentic: boolean, thinkingEnabled: boolean,
  thinkingBudget: number = DEFAULT_THINKING_BUDGET,
  thinkingType: 'enabled' | 'adaptive' | null = 'enabled',
  effortOverride?: string
): string {
  let result = content
  const now = new Date()
  const ts = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-${String(now.getUTCDate()).padStart(2,'0')}T${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}Z`
  if (thinkingEnabled) result = buildThinkingModePrompt(thinkingBudget, thinkingType, effortOverride) + '\n\n' + result
  if (isAgentic) result = AGENTIC_SYSTEM_PROMPT + '\n\n' + result
  result = `Current time: ${ts}` + '\n\n' + result
  return result
}

// ============ 孤立 tool_use 清理 ============
function findOrphanedToolUseIds(messages: KiroHistoryMessage[]): Set<string> {
  const resultIds = new Set<string>()
  for (const msg of messages) {
    const results = msg.userInputMessage?.userInputMessageContext?.toolResults
    if (results) for (const r of results) resultIds.add(r.toolUseId)
  }
  const orphanedIds = new Set<string>()
  for (let i = 0; i < messages.length; i++) {
    const toolUses = messages[i].assistantResponseMessage?.toolUses
    if (!toolUses) continue
    for (const tu of toolUses) {
      if (!resultIds.has(tu.toolUseId) && i !== messages.length - 1) {
        orphanedIds.add(tu.toolUseId)
      }
    }
  }
  return orphanedIds
}

function removeOrphanedToolUses(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  const orphanedIds = findOrphanedToolUseIds(messages)
  if (orphanedIds.size === 0) return messages
  logger.info('KiroAPI', `Removing ${orphanedIds.size} orphaned tool_use(s)`)
  return messages.map(msg => {
    if (!msg.assistantResponseMessage?.toolUses) return msg
    const filtered = msg.assistantResponseMessage.toolUses.filter(tu => !orphanedIds.has(tu.toolUseId))
    if (filtered.length === msg.assistantResponseMessage.toolUses.length) return msg
    return { ...msg, assistantResponseMessage: { ...msg.assistantResponseMessage, toolUses: filtered.length > 0 ? filtered : undefined } }
  })
}

function ensureHistoryToolsDefined(tools: KiroToolWrapper[], history: KiroHistoryMessage[]): KiroToolWrapper[] {
  const currentNames = new Set(tools.map(t => t.toolSpecification.name.toLowerCase()))
  const missing = new Set<string>()
  for (const msg of history) {
    const toolUses = msg.assistantResponseMessage?.toolUses
    if (toolUses) for (const tu of toolUses) {
      if (!currentNames.has(tu.name.toLowerCase())) missing.add(tu.name)
    }
  }
  if (missing.size === 0) return tools
  const placeholders: KiroToolWrapper[] = Array.from(missing).map(name => ({
    toolSpecification: { name, description: `Tool: ${name}`, inputSchema: { json: { type: 'object', properties: {} } } }
  }))
  logger.debug('KiroAPI', `Added ${placeholders.length} placeholder tool(s) for history`)
  return [...tools, ...placeholders]
}

function validateToolResults(toolResults: KiroToolResult[], history: KiroHistoryMessage[]): KiroToolResult[] {
  if (toolResults.length === 0) return toolResults
  const allToolUseIds = new Set<string>()
  const pairedResultIds = new Set<string>()
  for (const msg of history) {
    const toolUses = msg.assistantResponseMessage?.toolUses
    if (toolUses) for (const tu of toolUses) allToolUseIds.add(tu.toolUseId)
    const results = msg.userInputMessage?.userInputMessageContext?.toolResults
    if (results) for (const r of results) pairedResultIds.add(r.toolUseId)
  }
  return toolResults.filter(r => {
    if (!allToolUseIds.has(r.toolUseId)) { logger.warn('KiroAPI', `Orphaned tool_result: ${r.toolUseId}`); return false }
    if (pairedResultIds.has(r.toolUseId)) { logger.warn('KiroAPI', `Duplicate tool_result: ${r.toolUseId}`); return false }
    return true
  })
}

// ============ 消息清理 ============
const HELLO_MESSAGE: KiroHistoryMessage = { userInputMessage: { content: 'Hello', origin: 'AI_EDITOR' } }
const CONTINUE_MESSAGE: KiroHistoryMessage = { userInputMessage: { content: 'Continue', origin: 'AI_EDITOR' } }
const UNDERSTOOD_MESSAGE: KiroHistoryMessage = { assistantResponseMessage: { content: 'understood' } }

function createFailedToolUseMessage(toolUseIds: string[]): KiroHistoryMessage {
  return { userInputMessage: { content: '', origin: 'AI_EDITOR', userInputMessageContext: {
    toolResults: toolUseIds.map(toolUseId => ({ toolUseId, content: [{ text: 'Tool execution failed' }], status: 'error' as const }))
  }}}
}

function isUserInputMessage(msg: KiroHistoryMessage): boolean { return msg != null && 'userInputMessage' in msg && msg.userInputMessage != null }
function isAssistantResponseMessage(msg: KiroHistoryMessage): boolean { return msg != null && 'assistantResponseMessage' in msg && msg.assistantResponseMessage != null }
function hasToolResults(msg: KiroHistoryMessage): boolean { return !!(msg.userInputMessage?.userInputMessageContext?.toolResults?.length) }
function hasToolUses(msg: KiroHistoryMessage): boolean { return !!(msg.assistantResponseMessage?.toolUses?.length) }

function hasMatchingToolResults(toolUses: KiroToolUse[] | undefined, toolResults: KiroToolResult[] | undefined): boolean {
  if (!toolUses || !toolUses.length) return true
  if (!toolResults || !toolResults.length) return false
  const resultIds = new Set(toolResults.map(r => r.toolUseId))
  return toolUses.every(tu => resultIds.has(tu.toolUseId))
}

// 单遍清理会话消息
function sanitizeConversation(messages: KiroHistoryMessage[]): KiroHistoryMessage[] {
  if (messages.length === 0) return [HELLO_MESSAGE]
  const result: KiroHistoryMessage[] = []
  let firstUserSeen = false
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (isUserInputMessage(msg)) {
      if (firstUserSeen) {
        const hasContent = msg.userInputMessage?.content?.trim() !== ''
        if (!hasContent && !hasToolResults(msg)) continue
      }
      firstUserSeen = true
    }
    if (result.length > 0) {
      const prev = result[result.length - 1]
      if (isUserInputMessage(prev) && isUserInputMessage(msg)) result.push(UNDERSTOOD_MESSAGE)
      else if (isAssistantResponseMessage(prev) && isAssistantResponseMessage(msg)) result.push(CONTINUE_MESSAGE)
    }
    result.push(msg)
    if (isAssistantResponseMessage(msg) && hasToolUses(msg)) {
      const next = i + 1 < messages.length ? messages[i + 1] : null
      if (!next || !isUserInputMessage(next) || !hasToolResults(next) ||
          !hasMatchingToolResults(msg.assistantResponseMessage?.toolUses, next.userInputMessage?.userInputMessageContext?.toolResults)) {
        const toolUses = msg.assistantResponseMessage?.toolUses ?? []
        result.push(createFailedToolUseMessage(toolUses.map((tu, idx) => tu.toolUseId ?? `toolUse_${idx + 1}`)))
      }
    }
  }
  if (result.length === 0 || !isUserInputMessage(result[0])) result.unshift(HELLO_MESSAGE)
  if (!isUserInputMessage(result[result.length - 1])) result.push(CONTINUE_MESSAGE)
  return removeOrphanedToolUses(result)
}

// ============ 构建 Kiro API Payload ============
function uuidv4(): string {
  return crypto.randomUUID()
}

export function buildKiroPayload(
  content: string, modelId: string, origin: string,
  history: KiroHistoryMessage[] = [], tools: KiroToolWrapper[] = [],
  toolResults: KiroToolResult[] = [], images: KiroImage[] = [],
  profileArn?: string,
  inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number },
  thinkingEnabled = false, conversationId?: string,
  thinkingBudget: number = DEFAULT_THINKING_BUDGET,
  thinkingType: 'enabled' | 'adaptive' | null = 'enabled',
  effortOverride?: string
): KiroPayload {
  const isAgentic = tools.length > 0
  const contentWithPrompts = injectSystemPrompts(content, isAgentic, thinkingEnabled, thinkingBudget, thinkingType, effortOverride)
  const finalContent = contentWithPrompts.trim() || (toolResults.length > 0 ? '' : 'Continue')

  const currentUserInputMessage: KiroUserInputMessage = { content: finalContent, modelId, origin }
  if (images.length > 0) currentUserInputMessage.images = images

  const validatedToolResults = validateToolResults(toolResults, history)
  if (tools.length > 0 || validatedToolResults.length > 0) {
    currentUserInputMessage.userInputMessageContext = {}
    if (tools.length > 0) currentUserInputMessage.userInputMessageContext.tools = tools
    if (validatedToolResults.length > 0) currentUserInputMessage.userInputMessageContext.toolResults = validatedToolResults
  }

  const currentMessage: KiroHistoryMessage = { userInputMessage: currentUserInputMessage }
  const allMessages = [...history, currentMessage]
  const sanitizedMessages = sanitizeConversation(allMessages)
  const sanitizedHistory = sanitizedMessages.slice(0, -1)
  let finalCurrentMessage = sanitizedMessages.at(-1)!

  if (!finalCurrentMessage.userInputMessage) {
    finalCurrentMessage = { userInputMessage: { content: finalContent || 'Continue', modelId, origin } }
  }
  if (tools.length > 0) {
    const allTools = ensureHistoryToolsDefined(tools, sanitizedHistory)
    finalCurrentMessage.userInputMessage!.userInputMessageContext = {
      ...finalCurrentMessage.userInputMessage!.userInputMessageContext, tools: allTools
    }
  }

  const payload: KiroPayload = {
    conversationState: {
      chatTriggerType: 'MANUAL', conversationId: conversationId || uuidv4(),
      currentMessage: { userInputMessage: finalCurrentMessage.userInputMessage! },
      history: sanitizedHistory.length > 0 ? sanitizedHistory : undefined,
      agentContinuationId: uuidv4(), agentTaskType: 'vibe'
    }
  }
  if (profileArn) payload.profileArn = profileArn

  const hasIC = inferenceConfig && (inferenceConfig.maxTokens || inferenceConfig.temperature !== undefined || inferenceConfig.topP !== undefined)
  if (hasIC || thinkingEnabled) {
    payload.inferenceConfig = {}
    if (inferenceConfig?.maxTokens) payload.inferenceConfig.maxTokens = inferenceConfig.maxTokens
    if (inferenceConfig?.temperature !== undefined) payload.inferenceConfig.temperature = inferenceConfig.temperature
    if (inferenceConfig?.topP !== undefined) payload.inferenceConfig.topP = inferenceConfig.topP
    if (thinkingEnabled) {
      payload.inferenceConfig.reasoningConfig = { type: thinkingType === 'adaptive' ? 'adaptive' : 'enabled', budgetTokens: thinkingBudget }
    }
  }

  logger.debug('KiroAPI', `Payload: convId=${payload.conversationState.conversationId.substring(0,8)}... content=${finalContent.length} history=${sanitizedHistory.length} tools=${tools.length}`)
  return payload
}

// ============ 深度清理 Payload ============
function deepSanitizePayload(payload: KiroPayload): KiroPayload {
  const cs = payload.conversationState
  if (cs.currentMessage?.userInputMessage) {
    if (!cs.currentMessage.userInputMessage.content?.trim()) cs.currentMessage.userInputMessage.content = 'Continue'
  }
  if (cs.history && cs.history.length > 0) {
    const cleaned: KiroHistoryMessage[] = []
    for (const msg of cs.history) {
      if (msg.assistantResponseMessage) {
        if (!msg.assistantResponseMessage.content?.trim()) msg.assistantResponseMessage.content = 'I understand.'
        if (msg.assistantResponseMessage.toolUses) {
          const valid = msg.assistantResponseMessage.toolUses.filter(tu => tu.toolUseId?.trim() && tu.name?.trim())
          msg.assistantResponseMessage.toolUses = valid.length > 0 ? valid : undefined
        }
      }
      if (msg.userInputMessage) {
        if (!msg.userInputMessage.content?.trim() && !msg.userInputMessage.userInputMessageContext?.toolResults?.length) {
          msg.userInputMessage.content = 'Continue'
        }
        if (msg.userInputMessage.userInputMessageContext?.toolResults) {
          const valid = msg.userInputMessage.userInputMessageContext.toolResults.filter(r => r.toolUseId?.trim())
          if (valid.length === 0) { delete msg.userInputMessage.userInputMessageContext.toolResults }
          else {
            const seen = new Map<string, KiroToolResult>()
            for (const r of valid) seen.set(r.toolUseId, r)
            msg.userInputMessage.userInputMessageContext.toolResults = Array.from(seen.values())
          }
        }
        if (msg.userInputMessage.userInputMessageContext) {
          const ctx = msg.userInputMessage.userInputMessageContext
          if (!ctx.tools?.length && !ctx.toolResults?.length) delete msg.userInputMessage.userInputMessageContext
        }
      }
      cleaned.push(msg)
    }
    // 确保交替排列
    const alternated: KiroHistoryMessage[] = []
    for (const msg of cleaned) {
      if (alternated.length > 0) {
        const prevIsUser = !!alternated[alternated.length - 1].userInputMessage
        const currIsUser = !!msg.userInputMessage
        if (prevIsUser === currIsUser) {
          alternated.push(currIsUser ? { assistantResponseMessage: { content: 'understood' } } : { userInputMessage: { content: 'Continue', origin: 'AI_EDITOR' } })
        }
      }
      alternated.push(msg)
    }
    if (alternated.length > 0 && !alternated[0].userInputMessage) alternated.unshift(HELLO_MESSAGE)
    if (alternated.length > 0 && alternated[alternated.length - 1].userInputMessage) {
      alternated.push({ assistantResponseMessage: { content: 'understood' } })
    }
    cs.history = alternated.length > 0 ? alternated : undefined
  }
  return payload
}

// 激进清理：剥离所有工具调用历史
function aggressiveSanitizePayload(payload: KiroPayload): KiroPayload {
  const cs = payload.conversationState
  if (cs.history && cs.history.length > 0) {
    const textOnly: KiroHistoryMessage[] = []
    for (const msg of cs.history) {
      if (msg.assistantResponseMessage) {
        textOnly.push({ assistantResponseMessage: { content: msg.assistantResponseMessage.content || 'I understand.' } })
      } else if (msg.userInputMessage) {
        textOnly.push({ userInputMessage: { content: msg.userInputMessage.content?.trim() || 'Continue', origin: msg.userInputMessage.origin || 'AI_EDITOR' } })
      }
    }
    cs.history = textOnly.length > 0 ? textOnly : undefined
  }
  if (cs.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults) {
    delete cs.currentMessage.userInputMessage.userInputMessageContext.toolResults
  }
  logger.warn('KiroAPI', `Aggressive sanitize: stripped all tool history, keeping ${cs.history?.length || 0} text-only messages`)
  return deepSanitizePayload(payload)
}

// 认证头
async function getAuthHeaders(account: ProxyAccount, endpoint: typeof KIRO_ENDPOINTS[0]): Promise<Record<string, string>> {
  const { userAgent, amzUserAgent, isIDE } = await buildUserAgent(account)
  return {
    'Content-Type': 'application/json', 'Accept': '*/*',
    'X-Amz-Target': endpoint.amzTarget,
    'User-Agent': userAgent, 'X-Amz-User-Agent': amzUserAgent,
    'x-amzn-kiro-agent-mode': isIDE ? AGENT_MODE_SPEC : AGENT_MODE_VIBE,
    'x-amzn-codewhisperer-optout': 'true',
    'Amz-Sdk-Request': 'attempt=1; max=3',
    'Amz-Sdk-Invocation-Id': uuidv4(),
    'Authorization': `Bearer ${account.accessToken}`,
    'Connection': 'keep-alive'
  }
}

// 端点排序（基于健康度）
function getSortedEndpoints(preferredEndpoint?: 'codewhisperer' | 'amazonq'): typeof KIRO_ENDPOINTS {
  const sorted = [...KIRO_ENDPOINTS]
  const now = Date.now()
  sorted.sort((a, b) => {
    if (preferredEndpoint) {
      const pn = preferredEndpoint === 'codewhisperer' ? 'CodeWhisperer' : 'AmazonQ'
      if (a.name === pn && b.name !== pn) return -1
      if (b.name === pn && a.name !== pn) return 1
    }
    const hA = getEndpointHealth(a.name), hB = getEndpointHealth(b.name)
    const aFail = hA.consecutiveErrors >= 3 && (now - hA.lastFailTime) < 30000
    const bFail = hB.consecutiveErrors >= 3 && (now - hB.lastFailTime) < 30000
    if (aFail && !bFail) return 1; if (!aFail && bFail) return -1
    if (hA.totalRequests >= 5 && hB.totalRequests >= 5) {
      const rA = hA.successCount / hA.totalRequests, rB = hB.successCount / hB.totalRequests
      if (Math.abs(rA - rB) > 0.1) return rB - rA
    }
    if (hA.avgLatencyMs > 0 && hB.avgLatencyMs > 0) return hA.avgLatencyMs - hB.avgLatencyMs
    return 0
  })
  return sorted
}

// 带超时的 fetch
async function fetchWithTimeout(url: string, options: RequestInit, timeout: number): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)
  const originalSignal = options.signal
  if (originalSignal) originalSignal.addEventListener('abort', () => controller.abort())
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally { clearTimeout(timeoutId) }
}

function isRetryableError(error: Error): boolean {
  const msg = error.message || ''
  if (API_CONFIG.retryableErrors.some(code => msg.includes(code))) return true
  if (msg.includes('timeout') || msg.includes('aborted')) return true
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) return true
  return false
}

function calculateRetryDelayMs(attempt: number): number {
  const exp = Math.min(API_CONFIG.retryBaseDelay * Math.pow(2, attempt), API_CONFIG.retryMaxDelay)
  return exp + Math.floor(Math.random() * Math.max(1, Math.floor(exp / 4)))
}

// ============ 流式 API 调用 ============
export async function callKiroApiStream(
  account: ProxyAccount, payload: KiroPayload,
  onChunk: (text: string, toolUse?: KiroToolUse, isThinking?: boolean, toolUseStream?: KiroToolUseStream) => void,
  onComplete: (usage: StreamUsage) => void,
  onError: (error: Error) => void,
  signal?: AbortSignal, preferredEndpoint?: 'codewhisperer' | 'amazonq',
  thinkingEnabled?: boolean, streamReadTimeout?: number,
  debugInfo?: StreamDebugInfo
): Promise<void> {
  const endpoints = getSortedEndpoints(preferredEndpoint)
  let lastError: Error | null = null
  const startTime = Date.now()
  let totalRetries = 0
  let badRequestRetried = false
  let contentTruncationTier = 0
  let shouldAbortAllEndpoints = false

  deepSanitizePayload(payload)

  for (const endpoint of endpoints) {
    if (shouldAbortAllEndpoints) break
    for (let retry = 0; retry <= API_CONFIG.maxRetriesPerEndpoint; retry++) {
      if (totalRetries >= API_CONFIG.maxTotalRetries) break
      try {
        if (payload.conversationState.currentMessage.userInputMessage) {
          payload.conversationState.currentMessage.userInputMessage.origin = endpoint.origin
        }
        const payloadStr = JSON.stringify(payload)
        logger.info('KiroAPI', `${endpoint.name}${retry > 0 ? ` retry=${retry}` : ''} payload=${Math.round(payloadStr.length/1024)}KB`)

        const requestDebugInfo: StreamDebugInfo = {
          ...debugInfo,
          endpointName: endpoint.name,
          payloadBytes: payloadStr.length,
          historyCount: payload.conversationState.history?.length || 0,
          toolCount: payload.conversationState.currentMessage.userInputMessage?.userInputMessageContext?.tools?.length || 0,
          thinkingEnabled: thinkingEnabled === true,
          hasReasoningConfig: !!payload.inferenceConfig?.reasoningConfig,
          reasoningBudget: payload.inferenceConfig?.reasoningConfig?.budgetTokens,
          modelId: payload.conversationState.currentMessage.userInputMessage?.modelId
        }
        logger.info('KiroAPI', `Request debug requestID=${requestDebugInfo.requestID || '-'} endpoint=${requestDebugInfo.endpointName} model=${requestDebugInfo.modelId || '-'} history=${requestDebugInfo.historyCount} tools=${requestDebugInfo.toolCount} thinking=${requestDebugInfo.thinkingEnabled} reasoning=${requestDebugInfo.hasReasoningConfig ? (requestDebugInfo.reasoningBudget || 'on') : 'off'} payloadBytes=${requestDebugInfo.payloadBytes}`)

        const headers = await getAuthHeaders(account, endpoint)
        const requestStartTime = Date.now()
        const response = await fetchWithTimeout(endpoint.url, { method: 'POST', headers, body: payloadStr, signal }, API_CONFIG.requestTimeout)

        if (response.status === 429) {
          logger.info('KiroAPI', 'Rate limited (429), switching endpoint...')
          recordEndpointFailure(endpoint.name); lastError = new Error('Rate limited')
          await new Promise(r => setTimeout(r, 1000)); break
        }
        if (response.status === 402) {
          const e = new Error('QUOTA_EXHAUSTED'); (e as any).isQuotaError = true; (e as any).statusCode = 402; throw e
        }
        if (response.status === 401 || response.status === 403) {
          const detail = await response.text().catch(() => '')
          throw new Error(detail ? `Auth error ${response.status}: ${detail.substring(0, 500)}` : `Auth error ${response.status}`)
        }
        if (response.status === 400) {
          const body = await response.text().catch(() => '')
          let errorDetail = body
          try { const p = JSON.parse(body); errorDetail = p.message || p.error?.message || body } catch {}
          const isContentError = errorDetail.includes('too long') || errorDetail.includes('CONTENT_LENGTH') || errorDetail.includes('context_length')
          if (isContentError && payload.conversationState.history?.length) {
            const tierRatios = [0.5, 0.25, 0]
            if (contentTruncationTier < tierRatios.length) {
              const orig = payload.conversationState.history
              const ratio = tierRatios[contentTruncationTier]
              const keep = ratio === 0 ? 0 : Math.max(1, Math.floor(orig.length * ratio))
              payload.conversationState.history = ratio === 0 ? [] : orig.slice(-keep)
              logger.warn('KiroAPI', `Content error tier ${contentTruncationTier + 1}: truncating history ${orig.length} -> ${payload.conversationState.history.length}`)
              deepSanitizePayload(payload); contentTruncationTier++; totalRetries++; continue
            }
          }
          if (!badRequestRetried && payload.conversationState.history?.length) {
            badRequestRetried = true
            logger.warn('KiroAPI', `Bad Request (400): ${errorDetail.substring(0, 200)}, retrying with aggressive sanitization`)
            aggressiveSanitizePayload(payload); totalRetries++; continue
          }
          throw new Error(`Bad Request: ${errorDetail}`)
        }
        if (response.status >= 500) {
          const backoff = Math.min(500 * Math.pow(2, totalRetries), 2000)
          logger.warn('KiroAPI', `Server error ${response.status}, retrying after ${backoff}ms...`)
          lastError = new Error(`Server error ${response.status}`)
          await new Promise(r => setTimeout(r, backoff)); totalRetries++; continue
        }
        if (!response.ok) throw new Error(`API error ${response.status}`)

        const connectLatency = Date.now() - requestStartTime
        logger.info('KiroAPI', `Connected to ${endpoint.name} in ${connectLatency}ms`)
        recordEndpointSuccess(endpoint.name, connectLatency)
        await parseEventStream(response.body!, onChunk, onComplete, onError, payloadStr, thinkingEnabled, streamReadTimeout, requestDebugInfo)
        return
      } catch (error) {
        lastError = error as Error; recordEndpointFailure(endpoint.name)
        logger.error('KiroAPI', `${endpoint.name} failed: ${(error as Error).message}`)
        const errMsg = (error as Error).message || ''
        if (errMsg.includes('Auth error') || errMsg.includes('QUOTA_EXHAUSTED') || errMsg.includes('suspended') || errMsg.includes('banned')) {
          shouldAbortAllEndpoints = true; break
        }
        if (isRetryableError(error as Error) && retry < API_CONFIG.maxRetriesPerEndpoint) {
          await new Promise(r => setTimeout(r, calculateRetryDelayMs(retry))); totalRetries++; continue
        }
        break
      }
    }
  }
  if (lastError) { logger.error('KiroAPI', `All endpoints failed after ${Date.now() - startTime}ms`); onError(lastError) }
}

// ============ Event Stream 解析辅助 ============
function extractEventType(headers: Uint8Array): string {
  let offset = 0
  while (offset < headers.length) {
    if (offset >= headers.length) break
    const nameLen = headers[offset]; offset++
    if (offset + nameLen > headers.length) break
    const name = new TextDecoder().decode(headers.slice(offset, offset + nameLen)); offset += nameLen
    if (offset >= headers.length) break
    const valueType = headers[offset]; offset++
    if (valueType === 7) {
      if (offset + 2 > headers.length) break
      const valueLen = (headers[offset] << 8) | headers[offset + 1]; offset += 2
      if (offset + valueLen > headers.length) break
      const value = new TextDecoder().decode(headers.slice(offset, offset + valueLen)); offset += valueLen
      if (name === ':event-type') return value
      continue
    }
    const skipSizes: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }
    if (valueType === 6) { if (offset + 2 > headers.length) break; const len = (headers[offset] << 8) | headers[offset + 1]; offset += 2 + len }
    else if (skipSizes[valueType] !== undefined) offset += skipSizes[valueType]
    else break
  }
  return ''
}

function tryRepairTruncatedJson(truncated: string): Record<string, unknown> | null {
  if (!truncated || truncated.length < 2) return null
  try { return JSON.parse(truncated) } catch {}
  let repaired = truncated.trim()
  while (repaired.length > 0) {
    const last = repaired.charCodeAt(repaired.length - 1)
    if (last >= 0xD800 && last <= 0xDBFF) repaired = repaired.slice(0, -1)
    else break
  }
  // 暴力闭合策略
  try {
    let result = repaired, braceCount = 0, bracketCount = 0, inString = false, escape = false
    for (const char of result) {
      if (escape) { escape = false; continue }
      if (char === '\\') { escape = true; continue }
      if (char === '"') { inString = !inString; continue }
      if (!inString) {
        if (char === '{') braceCount++; else if (char === '}') braceCount--
        else if (char === '[') bracketCount++; else if (char === ']') bracketCount--
      }
    }
    if (inString) result += '"'
    while (bracketCount > 0) { result += ']'; bracketCount-- }
    while (braceCount > 0) { result += '}'; braceCount-- }
    const parsed = JSON.parse(result)
    if (typeof parsed === 'object' && parsed !== null) { (parsed as Record<string, unknown>)._repaired = true; return parsed }
  } catch {}
  return null
}

// 工具缓冲区管理器
interface ToolUseState { toolUseId: string; name: string; inputBuffer: string; startTime: number }

class ToolBufferManager {
  private buffers = new Map<string, ToolUseState>()
  private readonly maxBufferSize = 1024 * 1024
  private readonly maxBufferAge = 60000

  getOrCreate(toolUseId: string, name: string): ToolUseState {
    let state = this.buffers.get(toolUseId)
    if (!state) { state = { toolUseId, name, inputBuffer: '', startTime: Date.now() }; this.buffers.set(toolUseId, state) }
    return state
  }
  appendInput(toolUseId: string, input: string): boolean {
    const s = this.buffers.get(toolUseId); if (!s) return false
    if (s.inputBuffer.length + input.length > this.maxBufferSize) return false
    s.inputBuffer += input; return true
  }
  setInput(toolUseId: string, input: string): boolean {
    const s = this.buffers.get(toolUseId); if (!s) return false; s.inputBuffer = input; return true
  }
  getAndRemove(toolUseId: string): ToolUseState | undefined {
    const s = this.buffers.get(toolUseId); if (s) this.buffers.delete(toolUseId); return s
  }
  has(toolUseId: string): boolean { return this.buffers.has(toolUseId) }
  getIncomplete(): ToolUseState[] { return Array.from(this.buffers.values()) }
  clear(): void { this.buffers.clear() }
}

// Thinking 标签解析
const THINKING_START_TAG = '<thinking>'
const THINKING_END_TAG = '</thinking>'
const MAX_THINKING_CHARS = 100000

interface ThinkingParserState { inThinking: boolean; buffer: string; thinkingLength: number }

function parseThinkingContent(content: string, state: ThinkingParserState, thinkingEnabled: boolean): Array<{ text: string; isThinking: boolean }> {
  const results: Array<{ text: string; isThinking: boolean }> = []
  state.buffer += content
  while (state.buffer.length > 0) {
    if (!state.inThinking) {
      const startIdx = state.buffer.indexOf(THINKING_START_TAG)
      if (startIdx === -1) {
        let pending = 0
        for (let len = Math.min(state.buffer.length, THINKING_START_TAG.length - 1); len > 0; len--) {
          if (state.buffer.slice(-len) === THINKING_START_TAG.slice(0, len)) { pending = len; break }
        }
        const safeLen = state.buffer.length - pending
        if (safeLen > 0) { results.push({ text: state.buffer.slice(0, safeLen), isThinking: false }); state.buffer = state.buffer.slice(safeLen) }
        break
      } else {
        if (startIdx > 0) results.push({ text: state.buffer.slice(0, startIdx), isThinking: false })
        state.buffer = state.buffer.slice(startIdx + THINKING_START_TAG.length)
        state.inThinking = true; state.thinkingLength = 0
      }
    } else {
      const endIdx = state.buffer.indexOf(THINKING_END_TAG)
      const newStartIdx = state.buffer.indexOf(THINKING_START_TAG)
      if (state.thinkingLength > MAX_THINKING_CHARS && endIdx === -1) {
        if (state.buffer.length > 0 && thinkingEnabled) results.push({ text: state.buffer, isThinking: true })
        state.buffer = ''; state.inThinking = false; state.thinkingLength = 0; continue
      }
      if (endIdx === -1) {
        if (newStartIdx !== -1) {
          if (newStartIdx > 0 && thinkingEnabled) { results.push({ text: state.buffer.slice(0, newStartIdx), isThinking: true }); state.thinkingLength += newStartIdx }
          state.buffer = state.buffer.slice(newStartIdx + THINKING_START_TAG.length); state.thinkingLength = 0; continue
        }
        let pending = 0
        for (let len = Math.min(state.buffer.length, THINKING_END_TAG.length - 1); len > 0; len--) {
          if (state.buffer.slice(-len) === THINKING_END_TAG.slice(0, len)) { pending = len; break }
        }
        const safeLen = state.buffer.length - pending
        if (safeLen > 0 && thinkingEnabled) { results.push({ text: state.buffer.slice(0, safeLen), isThinking: true }); state.thinkingLength += safeLen; state.buffer = state.buffer.slice(safeLen) }
        break
      } else {
        if (newStartIdx !== -1 && newStartIdx < endIdx) {
          if (newStartIdx > 0 && thinkingEnabled) results.push({ text: state.buffer.slice(0, newStartIdx), isThinking: true })
          state.buffer = state.buffer.slice(newStartIdx + THINKING_START_TAG.length); state.thinkingLength = 0; continue
        }
        if (endIdx > 0 && thinkingEnabled) results.push({ text: state.buffer.slice(0, endIdx), isThinking: true })
        state.buffer = state.buffer.slice(endIdx + THINKING_END_TAG.length); state.inThinking = false; state.thinkingLength = 0
      }
    }
  }
  return results
}

// Token 估算（中英文分词）
function countTokens(text: string): number {
  if (!text) return 0
  let count = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code > 0x4E00 && code < 0x9FFF) count += 2  // CJK 字符约 2 token
    else if (code > 127) count += 1.5
    else count += 0.25  // ASCII 约 4 字符/token
  }
  return Math.ceil(count)
}

// ============ AWS Event Stream 二进制解析 ============
async function parseEventStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (text: string, toolUse?: KiroToolUse, isThinking?: boolean, toolUseStream?: KiroToolUseStream) => void,
  onComplete: (usage: StreamUsage) => void,
  onError: (error: Error) => void,
  inputPayload = '', thinkingEnabled = false, streamReadTimeout = 120000,
  debugInfo?: StreamDebugInfo
): Promise<void> {
  const reader = body.getReader()
  let buffer = new Uint8Array(64 * 1024)
  let bufferUsed = 0
  const textDecoder = new TextDecoder()
  const usage: StreamUsage = { inputTokens: 0, outputTokens: 0, credits: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, contextWindowExceeded: false, truncated: false }
  let totalOutputText = ''
  const MAX_OUTPUT_TEXT = 4 * 1024 * 1024
  let outputOverflowed = false
  if (inputPayload) usage.inputTokens = countTokens(inputPayload)

  const toolBuffers = new ToolBufferManager()
  const processedIds = new Set<string>()
  const thinkingState: ThinkingParserState = { inThinking: false, buffer: '', thinkingLength: 0 }
  const READ_TIMEOUT = streamReadTimeout
  const MAX_DECODE_ERRORS = 5
  let consecutiveDecodeErrors = 0
  let sawMeteringEvent = false
  let sawContextUsageEvent = false
  let lastEventType = ''

  async function readWithTimeout(): Promise<ReadableStreamReadResult<Uint8Array>> {
    return new Promise((resolve, reject) => {
      const tid = setTimeout(() => reject(new Error(`Stream read timeout: ${READ_TIMEOUT / 1000}s`)), READ_TIMEOUT)
      reader.read().then(r => { clearTimeout(tid); resolve(r) }).catch(e => { clearTimeout(tid); reject(e) })
    })
  }

  try {
    while (true) {
      const { done, value } = await readWithTimeout()
      if (done) break
      if (bufferUsed + value.length > buffer.length) {
        const newBuf = new Uint8Array(Math.max(buffer.length * 2, bufferUsed + value.length))
        newBuf.set(new Uint8Array(buffer.buffer, buffer.byteOffset, bufferUsed)); buffer = newBuf
      }
      buffer.set(value, bufferUsed); bufferUsed += value.length

      while (bufferUsed >= 16) {
        const totalLength = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0, false)
        const MAX_FRAME = 16 * 1024 * 1024
        if (totalLength > MAX_FRAME || totalLength < 16) {
          consecutiveDecodeErrors++
          if (consecutiveDecodeErrors >= MAX_DECODE_ERRORS) throw new Error(`Stream decode failed: invalid frame size ${totalLength}`)
          buffer.copyWithin(0, 1, bufferUsed); bufferUsed -= 1; continue
        }
        if (bufferUsed < totalLength) break

        const headersLength = new DataView(buffer.buffer, buffer.byteOffset).getUint32(4, false)
        if (headersLength > totalLength - 16) {
          consecutiveDecodeErrors++
          if (consecutiveDecodeErrors >= MAX_DECODE_ERRORS) throw new Error('Stream decode failed: invalid headers')
          buffer.copyWithin(0, totalLength, bufferUsed + totalLength); bufferUsed -= totalLength; continue
        }

        const eventType = extractEventType(buffer.subarray(12, 12 + headersLength))
        const payloadStart = 12 + headersLength, payloadEnd = totalLength - 4

        if (payloadStart < payloadEnd) {
          const payloadBytes = buffer.subarray(payloadStart, payloadEnd)
          try {
            const payloadText = textDecoder.decode(payloadBytes)
            const event = JSON.parse(payloadText)
            lastEventType = eventType || (event._type as string) || (event.type as string) || lastEventType
            // assistantResponseEvent - 文本内容
            if (eventType === 'assistantResponseEvent' || event.assistantResponseEvent) {
              const content = (event.assistantResponseEvent || event).content
              if (content) {
                const chunks = parseThinkingContent(content, thinkingState, thinkingEnabled)
                for (const chunk of chunks) { if (chunk.text) onChunk(chunk.text, undefined, chunk.isThinking) }
                if (!outputOverflowed && totalOutputText.length + content.length <= MAX_OUTPUT_TEXT) totalOutputText += content
                else if (!outputOverflowed) outputOverflowed = true
              }
            }
            // toolUseEvent - 工具调用
            if (eventType === 'toolUseEvent' || event.toolUseEvent) {
              const td = event.toolUseEvent || event
              const tuId = td.toolUseId, tuName = td.name, isStop = td.stop === true
              if (!processedIds.has(tuId)) {
                let inputFrag = ''; let inputObj: Record<string, unknown> | null = null
                if (typeof td.input === 'string') inputFrag = td.input
                else if (typeof td.input === 'object' && td.input !== null) inputObj = td.input
                const isNew = tuId && tuName && !toolBuffers.has(tuId)
                if (tuId && tuName) toolBuffers.getOrCreate(tuId, tuName)
                if (isNew) onChunk('', undefined, undefined, { toolUseId: tuId, name: tuName, isStart: true })
                if (tuId && inputFrag) { toolBuffers.appendInput(tuId, inputFrag); onChunk('', undefined, undefined, { toolUseId: tuId, inputFragment: inputFrag }) }
                if (tuId && inputObj) { const js = JSON.stringify(inputObj); toolBuffers.setInput(tuId, js); onChunk('', undefined, undefined, { toolUseId: tuId, inputFragment: js }) }
                if (isStop && tuId) {
                  const st = toolBuffers.getAndRemove(tuId)
                  if (st) {
                    let fi: Record<string, unknown> = {}
                    try { if (st.inputBuffer) fi = JSON.parse(st.inputBuffer) } catch { const rep = tryRepairTruncatedJson(st.inputBuffer || ''); fi = rep || {} }
                    onChunk('', undefined, undefined, { toolUseId: st.toolUseId, isStop: true })
                    onChunk('', { toolUseId: st.toolUseId, name: st.name, input: fi })
                    processedIds.add(st.toolUseId)
                  }
                }
              }
            }
            // meteringEvent - credit 使用量
            if (eventType === 'meteringEvent' || event.meteringEvent) {
              const m = event.meteringEvent || event
              sawMeteringEvent = true
              if (m.usage && typeof m.usage === 'number') usage.credits += m.usage
            }
            // contextUsageEvent
            if (eventType === 'contextUsageEvent' || event.contextUsageEvent) {
              const cu = (event.contextUsageEvent || event).contextUsagePercentage
              sawContextUsageEvent = true
              if (cu !== undefined && cu >= 100) usage.contextWindowExceeded = true
            }
            // supplementaryWebLinksEvent
            if (eventType === 'supplementaryWebLinksEvent' || event.supplementaryWebLinksEvent) {
              const wl = (event.supplementaryWebLinksEvent || event).supplementaryWebLinks
              if (wl && Array.isArray(wl)) {
                const links = wl.filter((l: any) => l.url).map((l: any) => `- [${l.title || l.url}](${l.url})`)
                if (links.length > 0) onChunk(`\n\n🔗 **Web References:**\n${links.join('\n')}`)
              }
            }
            // exceptionEvent
            if (eventType === 'exceptionEvent' || event.exceptionEvent) {
              const ex = event.exceptionEvent || event
              if ((ex.exceptionType || ex.type) === 'ContentLengthExceededException') {
                usage.contextWindowExceeded = true
                usage.truncated = true
                onChunk('', { toolUseId: '__content_length_exceeded__', name: '__exception__', input: { type: 'ContentLengthExceededException', message: ex.message || '' } })
              }
            }
            // 错误检查
            if (event._type || event.error) throw new Error(event.message || event.error?.message || 'Unknown stream error')
            consecutiveDecodeErrors = 0
          } catch (parseError) {
            if (parseError instanceof SyntaxError) {
              consecutiveDecodeErrors++
              if (consecutiveDecodeErrors >= MAX_DECODE_ERRORS) throw new Error(`Stream decode: ${MAX_DECODE_ERRORS} consecutive JSON errors`)
            } else throw parseError
          }
        }
        bufferUsed -= totalLength
        if (bufferUsed > 0) buffer.copyWithin(0, totalLength, totalLength + bufferUsed)
      }
    }
    // 完成未完成的 tool use
    for (const state of toolBuffers.getIncomplete()) {
      if (!processedIds.has(state.toolUseId)) {
        let finalInput: Record<string, unknown> = {}
        try { if (state.inputBuffer) finalInput = JSON.parse(state.inputBuffer) } catch { finalInput = {} }
        onChunk('', { toolUseId: state.toolUseId, name: state.name, input: finalInput })
        processedIds.add(state.toolUseId)
      }
    }
    toolBuffers.clear()
    if (thinkingState.buffer) { onChunk(thinkingState.buffer, undefined, thinkingState.inThinking && thinkingEnabled); thinkingState.buffer = '' }
    if (usage.outputTokens === 0 && totalOutputText) usage.outputTokens = countTokens(totalOutputText)
    const sawResponsePayload = totalOutputText.length > 0 || processedIds.size > 0
    const streamCompletedNormally = sawMeteringEvent
    if (!usage.truncated && !streamCompletedNormally && sawResponsePayload) {
      const hasToolCalls = processedIds.size > 0
      if (!hasToolCalls) {
        usage.truncated = true
        logger.warn('KiroAPI', `Stream ended without meteringEvent; marking as truncated (${Math.round(totalOutputText.length / 1024)}KB text)`)
      } else {
        logger.debug('KiroAPI', `Stream ended without meteringEvent but has tool calls; not marking as truncated`)
      }
    }
    logger.info('KiroAPI', `Stream summary requestID=${debugInfo?.requestID || '-'} endpoint=${debugInfo?.endpointName || '-'} model=${debugInfo?.modelId || '-'} done=${streamCompletedNormally} truncated=${usage.truncated === true} contextExceeded=${usage.contextWindowExceeded === true} metering=${sawMeteringEvent} contextUsage=${sawContextUsageEvent} outputTokens=${usage.outputTokens} outputChars=${totalOutputText.length} tools=${processedIds.size} lastEvent=${lastEventType || '-'} thinking=${thinkingEnabled}`)
    onComplete(usage)
  } catch (error) { onError(error as Error) }
  finally { reader.releaseLock() }
}

// ============ 非流式调用 ============
export async function callKiroApi(
  account: ProxyAccount, payload: KiroPayload,
  signal?: AbortSignal, preferredEndpoint?: 'codewhisperer' | 'amazonq', thinkingEnabled = false,
  debugInfo?: StreamDebugInfo
): Promise<{ content: string; toolUses: KiroToolUse[]; usage: StreamUsage; thinkingContent: string }> {
  return new Promise((resolve, reject) => {
    let content = ''; let thinkingContent = ''; const toolUses: KiroToolUse[] = []; let usage: StreamUsage = { inputTokens: 0, outputTokens: 0, credits: 0 }
    callKiroApiStream(account, payload,
      (text, toolUse, isThinking) => {
        if (isThinking) { thinkingContent += text; return }
        content += text
        if (!toolUse) return
        if (toolUse.toolUseId === '__content_length_exceeded__' || toolUse.name === '__exception__') return
        toolUses.push(toolUse)
      },
      (u) => { usage = u; resolve({ content, toolUses, usage, thinkingContent }) },
      reject, signal, preferredEndpoint, thinkingEnabled, undefined, debugInfo
    )
  })
}

// ============ 区域端点 ============
function getQServiceEndpoint(region?: string): string {
  if (region?.startsWith('eu-')) return 'https://q.eu-central-1.amazonaws.com'
  return 'https://q.us-east-1.amazonaws.com'
}

// ============ 获取模型列表 ============
export async function fetchKiroModels(account: ProxyAccount): Promise<KiroModel[]> {
  const baseUrl = getQServiceEndpoint(account.region)
  const { userAgent, amzUserAgent } = await buildUserAgent(account)
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${account.accessToken}`, 'Content-Type': 'application/json', 'Accept': 'application/json',
    'User-Agent': userAgent, 'x-amz-user-agent': amzUserAgent, 'x-amzn-codewhisperer-optout': 'true'
  }
  const allModels: KiroModel[] = []; let nextToken: string | undefined
  try {
    do {
      const params = new URLSearchParams({ origin: 'AI_EDITOR', maxResults: '50' })
      if (account.profileArn) params.set('profileArn', account.profileArn)
      if (nextToken) params.set('nextToken', nextToken)
      const response = await fetch(`${baseUrl}/ListAvailableModels?${params}`, { method: 'GET', headers })
      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        let detail = ''; try { const e = JSON.parse(errText); detail = e.message || e.Message || '' } catch { detail = errText.slice(0, 200) }
        throw new Error(`ListAvailableModels failed: ${response.status}${detail ? ` - ${detail}` : ''}`)
      }
      const data = await response.json()
      allModels.push(...(data.models || [])); nextToken = data.nextToken
    } while (nextToken)
    logger.info('KiroAPI', `Fetched ${allModels.length} models`)
    return allModels
  } catch (error) {
    logger.error('KiroAPI', `ListAvailableModels error: ${(error as Error).message}`)
    if (allModels.length > 0) return allModels
    throw error
  }
}

