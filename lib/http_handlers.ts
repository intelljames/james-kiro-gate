import type { ProxyAccount, RequestLog } from './types.ts'
import { logger } from './logger.ts'
import {
  callKiroApi,
  callKiroApiStream,
  summarizeKiroPayload,
} from './kiroApi.ts'
import {
  claudeToKiro,
  getThinkingBudgetFromRequest,
  isClaudeThinkingEnabled,
  isThinkingModel,
  kiroToClaudeResponse,
  kiroToOpenaiResponse,
  openaiToKiro,
} from './translator.ts'
import { ClaudeStreamHandler, OpenAIStreamHandler, claudeSSE } from './stream.ts'
import { classifyError, CircuitBreaker } from './errorHandler.ts'
import type { AccountPool } from './accountPool.ts'
import type { RateLimiter } from './rateLimiter.ts'
import {
  createToolCallSession,
  completeToolCallSession,
  getToolCallSessionReport,
  traceToolCallFlow,
} from './toolCallDebugger.ts'

export interface HandlerSettings {
  proxyApiKey: string
  rateLimitPerMinute: number
  debugPayload: boolean
}

export interface AuthResult {
  valid: boolean
  refreshToken?: string
  apiKey?: string
  accountId?: string
  apiKeyId?: string
}

export interface ChatHandlerDeps {
  settings: HandlerSettings
  accountPool: AccountPool
  rateLimiter: RateLimiter
  circuitBreaker: CircuitBreaker
  verifyApiKey: (req: Request) => Promise<AuthResult>
  getAccountFromRefreshToken: (refreshToken: string) => Promise<ProxyAccount>
  selectAccount: (model?: string, accountId?: string) => Promise<ProxyAccount>
  createRequestDebugID: (prefix: 'oa' | 'cl') => string
  detectThinkingHeader: (req: Request) => string
}

export function summarizeIncomingOpenAIRequest(body: Record<string, unknown>, thinkingHeader: string): Record<string, unknown> {
  return {
    model: body.model ?? null,
    thinkingHeader: thinkingHeader || null,
    reasoningEffort: body.reasoning_effort ?? null,
    reasoning: body.reasoning ?? null,
    thinking: body.thinking ?? null,
    stream: body.stream === true,
    messageCount: (body.messages as unknown[])?.length || 0,
    toolCount: (body.tools as unknown[])?.length || 0,
  }
}

export function summarizeIncomingClaudeRequest(body: Record<string, unknown>, thinkingHeader: string): Record<string, unknown> {
  return {
    model: body.model ?? null,
    thinkingHeader: thinkingHeader || null,
    thinking: body.thinking ?? null,
    maxTokens: body.max_tokens ?? null,
    stream: body.stream === true,
    messageCount: (body.messages as unknown[])?.length || 0,
    toolCount: (body.tools as unknown[])?.length || 0,
  }
}

export async function handleChatCompletions(req: Request, deps: ChatHandlerDeps): Promise<Response> {
  const authResult = await deps.verifyApiKey(req)
  if (!authResult.valid) {
    return Response.json({ error: { message: 'Invalid or missing API Key', type: 'authentication_error' } }, { status: 401 })
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return Response.json({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }, { status: 400 })
  }

  const model = (body.model as string) || 'claude-sonnet-4.5'
  const isStream = body.stream === true
  const requestDebugID = deps.createRequestDebugID('oa')
  const thinkingHeader = deps.detectThinkingHeader(req)
  createToolCallSession(requestDebugID)

  logger.info('API', `OpenAI ingress id=${requestDebugID} ${JSON.stringify(summarizeIncomingOpenAIRequest(body, thinkingHeader))}`)

  traceToolCallFlow(requestDebugID, 'request', 'openai', body, {
    hasTools: !!(body.tools as unknown[])?.length,
    toolCount: (body.tools as unknown[])?.length || 0,
    messageCount: (body.messages as unknown[])?.length || 0,
    hasToolMessages: (body.messages as Array<{ role?: string }>)?.some((m) => m.role === 'tool') || false,
  })

  logger.info('API', `OpenAI: id=${requestDebugID} model=${model} stream=${isStream} msgs=${(body.messages as unknown[])?.length || 0}`)

  if (deps.settings.rateLimitPerMinute > 0 && !deps.rateLimiter.tryAcquire('global').allowed) {
    completeToolCallSession(requestDebugID, 'error')
    return Response.json({ error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } }, { status: 429 })
  }

  try {
    const account = authResult.refreshToken
      ? await deps.getAccountFromRefreshToken(authResult.refreshToken)
      : await deps.selectAccount(model, authResult.accountId)

    if (!deps.circuitBreaker.canExecute()) {
      completeToolCallSession(requestDebugID, 'error')
      return Response.json({ error: { message: 'Service temporarily unavailable (circuit breaker open)', type: 'server_error' } }, { status: 503 })
    }

    const thinkingEnabled = isThinkingModel(model) || isClaudeThinkingEnabled(body.thinking) || getThinkingBudgetFromRequest(body.reasoning_effort as string | undefined, body.reasoning as { max_tokens?: number } | undefined) !== undefined
    const kiroPayload = openaiToKiro(body as any, account.profileArn, thinkingEnabled)

    traceToolCallFlow(requestDebugID, 'kiro_request', 'kiro', kiroPayload, {
      toolsCount: kiroPayload.conversationState.currentMessage.userInputMessage?.userInputMessageContext?.tools?.length || 0,
      toolResultsCount: kiroPayload.conversationState.currentMessage.userInputMessage?.userInputMessageContext?.toolResults?.length || 0,
      historyCount: kiroPayload.conversationState.history?.length || 0,
    })

    logger.info('API', `OpenAI request debug id=${requestDebugID} thinkingHeader=${thinkingHeader || '-'} thinkingEnabled=${thinkingEnabled} maxTokens=${(body.max_tokens as number | undefined) ?? '-'} reasoningEffort=${(body.reasoning_effort as string | undefined) ?? '-'} reasoningMax=${((body.reasoning as { max_tokens?: number } | undefined)?.max_tokens) ?? '-'} payloadReasoning=${kiroPayload.inferenceConfig?.reasoningConfig ? JSON.stringify(kiroPayload.inferenceConfig.reasoningConfig) : 'off'} history=${kiroPayload.conversationState.history?.length || 0} tools=${kiroPayload.conversationState.currentMessage.userInputMessage?.userInputMessageContext?.tools?.length || 0}`)

    if (deps.settings.debugPayload) logger.info('Payload', `OpenAI id=${requestDebugID} ${JSON.stringify(summarizeKiroPayload(kiroPayload))}`)

    if (isStream) {
      return handleOpenAIStream(account, kiroPayload, model, thinkingEnabled, requestDebugID, deps)
    }
    return await handleOpenAINonStream(account, kiroPayload, model, thinkingEnabled, requestDebugID, deps)
  } catch (e) {
    const err = e as Error
    logger.error('API', `OpenAI error: ${err.message}`)
    completeToolCallSession(requestDebugID, 'error')
    logger.error('ToolCallDebug', `Session ${requestDebugID} failed: ${err.message}`)
    const classified = classifyError(err)
    deps.circuitBreaker.recordFailure()
    return Response.json({
      error: { message: err.message, type: classified.type === 'AUTH' ? 'authentication_error' : 'server_error' },
    }, { status: classified.type === 'AUTH' ? 401 : classified.type === 'RATE_LIMIT' ? 429 : 500 })
  }
}

function handleOpenAIStream(account: ProxyAccount, payload: any, model: string, thinkingEnabled: boolean, requestDebugID: string, deps: ChatHandlerDeps): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      const handler = new OpenAIStreamHandler({
        model,
        enableThinkingParsing: thinkingEnabled,
        onWrite: (data: string) => {
          try { controller.enqueue(encoder.encode(data)); return true } catch { return false }
        },
      })
      handler.sendInitial()

      callKiroApiStream(account, payload,
        (text, toolUse, isThinking, toolUseStream) => {
          if (toolUse) {
            traceToolCallFlow(requestDebugID, 'kiro_response', 'kiro', {
              type: 'toolUse', toolUseId: toolUse.toolUseId, name: toolUse.name, input: toolUse.input,
            }, { isContentLengthExceeded: toolUse.toolUseId === '__content_length_exceeded__' })
          }
          if (toolUseStream) {
            traceToolCallFlow(requestDebugID, 'kiro_response', 'kiro', {
              type: 'toolUseStream',
              toolUseId: toolUseStream.toolUseId,
              name: toolUseStream.name,
              inputFragment: toolUseStream.inputFragment,
              isStop: toolUseStream.isStop,
            })
          }
          if (text) handler.handleContent(text)
          if (toolUse) {
            if (toolUse.toolUseId === '__content_length_exceeded__') handler.handleContentLengthExceeded()
            else handler.handleToolUse(toolUse.toolUseId, toolUse.name, toolUse.input, true)
          }
          if (toolUseStream) {
            handler.handleToolUse(toolUseStream.toolUseId, toolUseStream.name, toolUseStream.inputFragment, toolUseStream.isStop || false)
          }
        },
        (usage) => {
          const finalResponse = {
            toolCalls: handler.getToolCalls(),
            responseText: handler.getResponseText(),
            reasoningText: handler.getThinkingText(),
            outputTokens: handler.getOutputTokens(),
            usage,
          }
          logger.info('API', `OpenAI egress id=${requestDebugID} ${JSON.stringify({
            finish: handler.getToolCalls().length > 0 ? 'tool_calls' : (usage.truncated || usage.contextWindowExceeded ? 'length' : 'stop'),
            contentChars: handler.getResponseText().length,
            reasoningChars: handler.getThinkingText().length,
            toolCalls: handler.getToolCalls().length,
            outputTokens: usage.outputTokens,
          })}`)
          traceToolCallFlow(requestDebugID, 'response', 'openai', finalResponse, {
            toolCallsCount: handler.getToolCalls().length,
            hasToolCalls: handler.getToolCalls().length > 0,
            outputTokens: usage.outputTokens,
          })
          handler.finish({
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            reasoningTokens: usage.reasoningTokens,
            contextWindowExceeded: usage.contextWindowExceeded,
            truncated: usage.truncated,
          })
          completeToolCallSession(requestDebugID, 'completed')
          if (handler.getToolCalls().length > 0) logger.debug('ToolCallDebug', getToolCallSessionReport(requestDebugID))
          deps.circuitBreaker.recordSuccess()
          deps.accountPool.recordSuccess(account.id, usage.outputTokens)
          try { controller.close() } catch { /* client disconnected */ }
        },
        (error) => {
          completeToolCallSession(requestDebugID, 'error')
          deps.circuitBreaker.recordFailure()
          deps.accountPool.recordError(account.id, 'other')
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: error.message })}\n\n`))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          } catch { /* ignore */ }
          try { controller.close() } catch { /* client disconnected */ }
        },
        undefined, undefined, thinkingEnabled, undefined, { requestID: requestDebugID },
      )
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' },
  })
}

async function handleOpenAINonStream(account: ProxyAccount, payload: any, model: string, thinkingEnabled: boolean, requestDebugID: string, deps: ChatHandlerDeps): Promise<Response> {
  const result = await callKiroApi(account, payload, undefined, undefined, thinkingEnabled, { requestID: requestDebugID })
  traceToolCallFlow(requestDebugID, 'kiro_response', 'kiro', {
    content: result.content,
    toolUses: result.toolUses,
    usage: result.usage,
    thinkingContent: result.thinkingContent,
  }, {
    toolUsesCount: result.toolUses?.length || 0,
    hasToolUses: !!(result.toolUses?.length),
    outputTokens: result.usage.outputTokens,
  })
  deps.circuitBreaker.recordSuccess()
  deps.accountPool.recordSuccess(account.id, result.usage.outputTokens)
  const response = kiroToOpenaiResponse(result.content, result.toolUses, {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    cacheWriteTokens: result.usage.cacheWriteTokens,
    reasoningTokens: result.usage.reasoningTokens,
    contextWindowExceeded: result.usage.contextWindowExceeded,
    truncated: result.usage.truncated,
  }, model, result.thinkingContent || undefined)
  logger.info('API', `OpenAI egress id=${requestDebugID} ${JSON.stringify({
    finish: response.choices?.[0]?.finish_reason || null,
    contentChars: result.content.length,
    reasoningChars: (result.thinkingContent || '').length,
    toolCalls: result.toolUses.length,
    outputTokens: result.usage.outputTokens,
  })}`)
  traceToolCallFlow(requestDebugID, 'response', 'openai', response, {
    toolCallsCount: response.choices?.[0]?.message?.tool_calls?.length || 0,
    hasToolCalls: !!(response.choices?.[0]?.message?.tool_calls?.length),
    finishReason: response.choices?.[0]?.finish_reason,
  })
  completeToolCallSession(requestDebugID, 'completed')
  return Response.json(response)
}

export async function handleAnthropicMessages(req: Request, deps: ChatHandlerDeps): Promise<Response> {
  const authResult = await deps.verifyApiKey(req)
  if (!authResult.valid) {
    return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid or missing API Key' } }, { status: 401 })
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } }, { status: 400 })
  }

  if (!body.max_tokens) {
    return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens is required' } }, { status: 400 })
  }

  const model = (body.model as string) || 'claude-sonnet-4.5'
  const isStream = body.stream === true
  const requestDebugID = deps.createRequestDebugID('cl')
  const thinkingHeader = deps.detectThinkingHeader(req)
  createToolCallSession(requestDebugID)

  logger.info('API', `Claude ingress id=${requestDebugID} ${JSON.stringify(summarizeIncomingClaudeRequest(body, thinkingHeader))}`)

  traceToolCallFlow(requestDebugID, 'request', 'anthropic', body, {
    hasTools: !!(body.tools as unknown[])?.length,
    toolCount: (body.tools as unknown[])?.length || 0,
    messageCount: (body.messages as unknown[])?.length || 0,
    hasToolResultMessages: (body.messages as Array<{ content?: Array<{ type?: string }> }>)?.some((m) => m.content?.some?.((block) => block.type === 'tool_result')) || false,
  })

  logger.info('API', `Claude: id=${requestDebugID} model=${model} stream=${isStream} msgs=${(body.messages as unknown[])?.length || 0}`)

  if (deps.settings.rateLimitPerMinute > 0 && !deps.rateLimiter.tryAcquire('global').allowed) {
    completeToolCallSession(requestDebugID, 'error')
    return Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } }, { status: 429 })
  }

  try {
    const account = authResult.refreshToken
      ? await deps.getAccountFromRefreshToken(authResult.refreshToken)
      : await deps.selectAccount(model, authResult.accountId)

    if (!deps.circuitBreaker.canExecute()) {
      completeToolCallSession(requestDebugID, 'error')
      return Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'Service temporarily unavailable' } }, { status: 529 })
    }

    const thinkingEnabled = isClaudeThinkingEnabled(body.thinking) || isThinkingModel(model)
    const kiroPayload = claudeToKiro(body as any, account.profileArn, thinkingEnabled)
    logger.info('API', `Claude request debug id=${requestDebugID} thinkingHeader=${thinkingHeader || '-'} thinkingBody=${JSON.stringify(body.thinking ?? null)} thinkingEnabled=${thinkingEnabled} maxTokens=${(body.max_tokens as number | undefined) ?? '-'} payloadReasoning=${kiroPayload.inferenceConfig?.reasoningConfig ? JSON.stringify(kiroPayload.inferenceConfig.reasoningConfig) : 'off'} history=${kiroPayload.conversationState.history?.length || 0} tools=${kiroPayload.conversationState.currentMessage.userInputMessage?.userInputMessageContext?.tools?.length || 0}`)
    if (deps.settings.debugPayload) logger.info('Payload', `Claude id=${requestDebugID} ${JSON.stringify(summarizeKiroPayload(kiroPayload))}`)

    if (isStream) {
      return handleClaudeStream(account, kiroPayload, model, thinkingEnabled, requestDebugID, deps)
    }
    return await handleClaudeNonStream(account, kiroPayload, model, thinkingEnabled, requestDebugID, deps)
  } catch (e) {
    const err = e as Error
    logger.error('API', `Claude error: ${err.message}`)
    deps.circuitBreaker.recordFailure()
    return Response.json({ type: 'error', error: { type: 'api_error', message: err.message } }, { status: 500 })
  }
}

function handleClaudeStream(account: ProxyAccount, payload: any, model: string, thinkingEnabled: boolean, requestDebugID: string, deps: ChatHandlerDeps): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      const handler = new ClaudeStreamHandler({
        model,
        inputTokens: 0,
        enableThinkingParsing: thinkingEnabled,
        onWrite: (data: string) => {
          try { controller.enqueue(encoder.encode(data)); return true } catch { return false }
        },
      })
      handler.sendMessageStart()

      callKiroApiStream(account, payload,
        (text, toolUse, _isThinking, toolUseStream) => {
          if (text) handler.handleContent(text)
          if (toolUse) {
            if (toolUse.toolUseId === '__content_length_exceeded__') handler.handleContentLengthExceeded()
            else handler.handleToolUse(toolUse.toolUseId, toolUse.name, toolUse.input, true)
          }
          if (toolUseStream) {
            handler.handleToolUse(toolUseStream.toolUseId, toolUseStream.name, toolUseStream.inputFragment, toolUseStream.isStop || false)
          }
        },
        (usage) => {
          logger.info('API', `Claude egress id=${requestDebugID} ${JSON.stringify({
            finish: handler.getToolCalls().length > 0 ? 'tool_use' : (usage.truncated || usage.contextWindowExceeded ? 'max_tokens' : 'end_turn'),
            contentChars: handler.getResponseText().length,
            reasoningChars: handler.getThinkingText().length,
            toolCalls: handler.getToolCalls().length,
            outputTokens: usage.outputTokens,
          })}`)
          handler.finish({
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            contextWindowExceeded: usage.contextWindowExceeded,
            truncated: usage.truncated,
          })
          deps.circuitBreaker.recordSuccess()
          deps.accountPool.recordSuccess(account.id, usage.outputTokens)
          try { controller.close() } catch { /* client disconnected */ }
        },
        (error) => {
          deps.circuitBreaker.recordFailure()
          deps.accountPool.recordError(account.id, 'other')
          try { controller.enqueue(encoder.encode(claudeSSE.error(error.message))) } catch { /* ignore */ }
          try { controller.close() } catch { /* client disconnected */ }
        },
        undefined, undefined, thinkingEnabled, undefined, { requestID: requestDebugID },
      )
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' },
  })
}

async function handleClaudeNonStream(account: ProxyAccount, payload: any, model: string, thinkingEnabled: boolean, requestDebugID: string, deps: ChatHandlerDeps): Promise<Response> {
  const result = await callKiroApi(account, payload, undefined, undefined, thinkingEnabled, { requestID: requestDebugID })
  deps.circuitBreaker.recordSuccess()
  deps.accountPool.recordSuccess(account.id, result.usage.outputTokens)
  const response = kiroToClaudeResponse(result.content, result.toolUses, {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    cacheWriteTokens: result.usage.cacheWriteTokens,
    contextWindowExceeded: result.usage.contextWindowExceeded,
    truncated: result.usage.truncated,
  }, model, result.thinkingContent || undefined)
  logger.info('API', `Claude egress id=${requestDebugID} ${JSON.stringify({
    finish: response.stop_reason,
    contentChars: result.content.length,
    reasoningChars: (result.thinkingContent || '').length,
    toolCalls: result.toolUses.length,
    outputTokens: result.usage.outputTokens,
  })}`)
  return Response.json(response)
}
