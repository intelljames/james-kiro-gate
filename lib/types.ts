// KiroGate 类型定义 - 合并 OpenAI/Claude/Kiro 格式 + 账号管理 + 代理配置

// ============ OpenAI 兼容格式 ============
export interface OpenAIChatRequest {
  model: string
  messages: OpenAIMessage[]
  temperature?: number
  top_p?: number
  max_tokens?: number
  stream?: boolean
  tools?: OpenAITool[]
  tool_choice?: string | { type: string; function: { name: string } }
  response_format?: { type: string; json_schema?: unknown }
  reasoning_effort?: 'low' | 'medium' | 'high'
  reasoning?: { max_tokens?: number }
  thinking?: unknown
}

export interface OpenAIMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIContentPart[]
  name?: string
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

export interface OpenAIContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string; detail?: string }
}

export interface OpenAITool {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface OpenAIChatResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: OpenAIChoice[]
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export interface OpenAIChoice {
  index: number
  message: {
    role: 'assistant'
    content: string | null
    reasoning_content?: string
    tool_calls?: OpenAIToolCall[]
  }
  finish_reason: 'stop' | 'length' | 'tool_calls' | null
}
export interface OpenAIStreamChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: {
    index: number
    delta: {
      role?: 'assistant'
      content?: string
      reasoning_content?: string
      tool_calls?: Partial<OpenAIToolCall>[]
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | null
  }[]
}

// ============ Claude 兼容格式 ============
export interface ClaudeRequest {
  model: string
  messages: ClaudeMessage[]
  max_tokens: number
  temperature?: number
  top_p?: number
  stream?: boolean
  system?: string | ClaudeSystemBlock[]
  tools?: ClaudeTool[]
  tool_choice?: { type: string; name?: string }
  thinking?: unknown
  metadata?: { user_id?: string }
  output_config?: { effort?: string }
}

export interface ClaudeMessage {
  role: 'user' | 'assistant'
  content: string | ClaudeContentBlock[]
}

export interface ClaudeSystemBlock { type: 'text'; text: string }

export interface ClaudeBase64Source {
  type: 'base64'
  media_type: string
  data: string
}

export interface ClaudeTextSource {
  type: 'text'
  media_type: string
  data: string
}

export interface ClaudeUrlSource {
  type: 'url'
  url: string
}

export interface ClaudeContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result' | 'thinking' | 'redacted_thinking' | 'document'
  text?: string
  thinking?: string
  signature?: string
  data?: string
  source?: ClaudeBase64Source | ClaudeTextSource | ClaudeUrlSource
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string | ClaudeContentBlock[]
}

export interface ClaudeTool {
  name: string
  description: string
  input_schema: unknown
}

export interface ClaudeResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: ClaudeContentBlock[]
  model: string
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | null
  stop_sequence: string | null
  usage: { input_tokens: number; output_tokens: number }
}

export interface ClaudeStreamEvent {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop' | 'ping' | 'error'
  message?: Partial<ClaudeResponse>
  index?: number
  content_block?: ClaudeContentBlock
  delta?: { type: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string; stop_sequence?: string }
  usage?: ClaudeUsage
  error?: { type: string; message: string }
}

export interface ClaudeUsage {
  input_tokens?: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

// ============ 归一化会话模型 ============
export interface NormalizedConversation {
  instructions: string[]
  turns: NormalizedTurn[]
  tools: NormalizedToolDefinition[]
  currentInput: NormalizedCurrentInput
}

export type NormalizedTurn =
  | NormalizedUserTurn
  | NormalizedAssistantTurn

export interface NormalizedUserTurn {
  role: 'user'
  text: string
  images?: KiroImage[]
  toolResults?: NormalizedToolResult[]
}

export interface NormalizedAssistantTurn {
  role: 'assistant'
  text: string
  toolCalls?: NormalizedToolCall[]
}

export interface NormalizedCurrentInput {
  text: string
  images?: KiroImage[]
  toolResults?: NormalizedToolResult[]
}

export interface NormalizedToolDefinition {
  name: string
  description: string
  inputSchema: unknown
}

export interface NormalizedToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface NormalizedToolResult {
  toolCallId: string
  text: string
  status: 'success' | 'error'
}

// ============ Kiro API 格式 ============
export interface KiroPayload {
  conversationState: KiroConversationState
  profileArn?: string
  inferenceConfig?: KiroInferenceConfig
}

export interface KiroConversationState {
  chatTriggerType: 'MANUAL'
  conversationId: string
  currentMessage: { userInputMessage: KiroUserInputMessage }
  history?: KiroHistoryMessage[]
  agentContinuationId?: string
  agentTaskType?: string
}

export interface KiroUserInputMessage {
  content: string
  modelId?: string
  origin: string
  images?: KiroImage[]
  userInputMessageContext?: {
    toolResults?: KiroToolResult[]
    tools?: KiroToolWrapper[]
  }
}

export interface KiroImage {
  format: string
  source: { bytes: string }
}

export interface KiroToolResult {
  content: { text: string }[]
  status: 'success' | 'error'
  toolUseId: string
}

export interface KiroToolWrapper {
  toolSpecification: {
    name: string
    description: string
    inputSchema: { json: unknown }
  }
}

export interface KiroHistoryMessage {
  userInputMessage?: KiroUserInputMessage
  assistantResponseMessage?: KiroAssistantResponseMessage
}

export interface KiroAssistantResponseMessage {
  content: string
  toolUses?: KiroToolUse[]
}

export interface KiroToolUse {
  toolUseId: string
  name: string
  input: Record<string, unknown>
}

export interface KiroToolUseStream {
  toolUseId: string
  name?: string
  inputFragment?: string
  isStart?: boolean
  isStop?: boolean
}

export interface KiroInferenceConfig {
  maxTokens?: number
  temperature?: number
  topP?: number
  reasoningConfig?: {
    type: 'enabled' | 'disabled' | 'adaptive'
    budgetTokens?: number
  }
}

// ============ 账号和代理配置 ============
export interface ProxyAccount {
  id: string
  email?: string
  accessToken: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: 'social' | 'idc' | 'IdC'
  provider?: string
  profileArn?: string
  expiresAt?: number
  machineId?: string
  subscriptionType?: string
  lastUsed?: number
  requestCount?: number
  errorCount?: number
  isAvailable?: boolean
  cooldownUntil?: number
  quotaExhausted?: boolean
  disabled?: boolean
}


// ============ 统计和日志 ============
export interface AccountStats {
  requests: number
  tokens: number
  inputTokens: number
  outputTokens: number
  errors: number
  lastUsed: number
  avgResponseTime: number
  totalResponseTime: number
}

export interface RequestLog {
  timestamp: number
  path: string
  model: string
  requestedModel?: string
  accountId: string
  apiKeyId?: string
  inputTokens: number
  outputTokens: number
  credits?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  compressed?: boolean
  responseTime: number
  success: boolean
  error?: string
}

// ============ API Key 管理 ============
export interface ApiKeyStats {
  totalRequests: number
  successRequests: number
  failedRequests: number
  totalCredits: number
  inputTokens: number
  outputTokens: number
  daily: Record<string, { requests: number; credits: number; inputTokens: number; outputTokens: number }>
  byModel: Record<string, { requests: number; credits: number; inputTokens: number; outputTokens: number }>
  byAccount: Record<string, { requests: number; credits: number; inputTokens: number; outputTokens: number }>
}

export interface ApiKey {
  id: string
  key: string
  name: string
  enabled: boolean
  isDefault?: boolean
  createdAt: number
  lastUsedAt?: number
  creditLimit?: number
  allowedAccountIds?: string[]
  allowedModels?: string[]
  stats: ApiKeyStats
}

// ============ Kiro 模型信息 ============
export interface KiroModel {
  modelId: string
  modelName: string
  description: string
  rateMultiplier?: number
  rateUnit?: string
  supportedInputTypes?: string[]
  tokenLimits?: { maxInputTokens?: number | null; maxOutputTokens?: number | null }
}

// ============ 端点健康度 ============
export interface EndpointHealth {
  totalRequests: number
  successCount: number
  failCount: number
  avgLatencyMs: number
  lastFailTime: number
  lastSuccessTime: number
  consecutiveErrors: number
}

// ============ 错误分类 ============
export type ErrorType = 'NETWORK' | 'AUTH' | 'QUOTA' | 'RATE_LIMIT' | 'SERVER' | 'CLIENT' | 'BANNED' | 'CONTENT_TOO_LONG' | 'INVALID_REQUEST' | 'INVALID_MODEL' | 'UNKNOWN'

// ============ 熔断器状态 ============
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

// ============ 负载均衡模式 ============
export type LoadBalancingMode = 'smart' | 'priority' | 'balanced'
