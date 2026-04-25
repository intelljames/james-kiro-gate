// Tool Call 调试追踪器 - 用于定位 tool call 闭环问题
import { logger } from './logger.ts'
import type { KiroToolUse, KiroToolResult } from './types.ts'

export interface ToolCallTrace {
  id: string
  timestamp: number
  phase: 'request' | 'kiro_request' | 'kiro_response' | 'response'
  format: 'openai' | 'anthropic' | 'kiro'
  data: unknown
  metadata?: Record<string, unknown>
}

export interface ToolCallSession {
  sessionId: string
  traces: ToolCallTrace[]
  startTime: number
  endTime?: number
  status: 'active' | 'completed' | 'error'
}

class ToolCallDebugger {
  private sessions = new Map<string, ToolCallSession>()
  private enabled = true

  enable(): void {
    this.enabled = true
    logger.info('ToolCallDebugger', 'Tool call debugging enabled')
  }

  disable(): void {
    this.enabled = false
    logger.info('ToolCallDebugger', 'Tool call debugging disabled')
  }

  createSession(sessionId: string): void {
    if (!this.enabled) return
    
    this.sessions.set(sessionId, {
      sessionId,
      traces: [],
      startTime: Date.now(),
      status: 'active'
    })
    
    logger.debug('ToolCallDebugger', `Created session: ${sessionId}`)
  }

  addTrace(sessionId: string, trace: Omit<ToolCallTrace, 'timestamp'>): void {
    if (!this.enabled) return
    
    const session = this.sessions.get(sessionId)
    if (!session) {
      logger.warn('ToolCallDebugger', `Session not found: ${sessionId}`)
      return
    }

    const fullTrace: ToolCallTrace = {
      ...trace,
      timestamp: Date.now()
    }

    session.traces.push(fullTrace)
    
    logger.debug('ToolCallDebugger', `[${sessionId}] ${trace.phase} (${trace.format})`, {
      id: trace.id,
      dataType: typeof trace.data,
      metadata: trace.metadata
    })
  }

  // 记录原始 OpenAI/Anthropic 请求
  traceIncomingRequest(sessionId: string, format: 'openai' | 'anthropic', request: unknown): void {
    this.addTrace(sessionId, {
      id: `${sessionId}-incoming`,
      phase: 'request',
      format,
      data: request,
      metadata: { 
        hasTools: this.extractToolsInfo(request, format),
        messageCount: this.extractMessageCount(request, format)
      }
    })
  }

  // 记录转换后的 Kiro 请求
  traceKiroRequest(sessionId: string, kiroPayload: unknown): void {
    this.addTrace(sessionId, {
      id: `${sessionId}-kiro-req`,
      phase: 'kiro_request',
      format: 'kiro',
      data: kiroPayload,
      metadata: {
        toolsCount: this.extractKiroToolsCount(kiroPayload),
        toolResultsCount: this.extractKiroToolResultsCount(kiroPayload)
      }
    })
  }

  // 记录 Kiro 响应
  traceKiroResponse(sessionId: string, kiroResponse: unknown): void {
    this.addTrace(sessionId, {
      id: `${sessionId}-kiro-resp`,
      phase: 'kiro_response',
      format: 'kiro',
      data: kiroResponse,
      metadata: {
        toolCallsFound: this.extractKiroToolCalls(kiroResponse)
      }
    })
  }

  // 记录最终响应
  traceFinalResponse(sessionId: string, format: 'openai' | 'anthropic', response: unknown): void {
    this.addTrace(sessionId, {
      id: `${sessionId}-final`,
      phase: 'response',
      format,
      data: response,
      metadata: {
        toolCallsCount: this.extractFinalToolCallsCount(response, format)
      }
    })
  }

  // 完成会话
  completeSession(sessionId: string, status: 'completed' | 'error' = 'completed'): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.endTime = Date.now()
      session.status = status
      
      logger.info('ToolCallDebugger', `Session ${sessionId} completed`, {
        duration: session.endTime - session.startTime,
        traceCount: session.traces.length,
        status
      })
    }
  }

  // 获取会话详情
  getSession(sessionId: string): ToolCallSession | undefined {
    return this.sessions.get(sessionId)
  }

  // 获取所有会话
  getAllSessions(): ToolCallSession[] {
    return Array.from(this.sessions.values())
  }

  // 生成会话报告
  generateSessionReport(sessionId: string): string {
    const session = this.sessions.get(sessionId)
    if (!session) return `Session ${sessionId} not found`

    let report = `\n=== Tool Call Session Report: ${sessionId} ===\n`
    report += `Status: ${session.status}\n`
    report += `Duration: ${(session.endTime || Date.now()) - session.startTime}ms\n`
    report += `Traces: ${session.traces.length}\n\n`

    session.traces.forEach((trace, index) => {
      report += `${index + 1}. [${trace.phase}] ${trace.format} (${trace.id})\n`
      report += `   Time: ${new Date(trace.timestamp).toISOString()}\n`
      if (trace.metadata) {
        report += `   Metadata: ${JSON.stringify(trace.metadata, null, 2)}\n`
      }
      report += `   Data: ${JSON.stringify(trace.data, null, 2).substring(0, 500)}...\n\n`
    })

    return report
  }

  // 清理旧会话
  cleanup(maxAge: number = 3600000): void { // 1小时
    const now = Date.now()
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.startTime > maxAge) {
        this.sessions.delete(sessionId)
      }
    }
  }

  // 辅助方法：提取工具信息
  private extractToolsInfo(request: any, format: 'openai' | 'anthropic'): any {
    if (format === 'openai') {
      return {
        hasTools: !!request?.tools,
        toolCount: request?.tools?.length || 0,
        toolNames: request?.tools?.map((t: any) => t?.function?.name) || []
      }
    } else {
      return {
        hasTools: !!request?.tools,
        toolCount: request?.tools?.length || 0,
        toolNames: request?.tools?.map((t: any) => t?.name) || []
      }
    }
  }

  private extractMessageCount(request: any, format: 'openai' | 'anthropic'): number {
    return request?.messages?.length || 0
  }

  private extractKiroToolsCount(payload: any): number {
    return payload?.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.tools?.length || 0
  }

  private extractKiroToolResultsCount(payload: any): number {
    return payload?.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults?.length || 0
  }

  private extractKiroToolCalls(response: any): any {
    // 这里需要根据实际的 Kiro 响应格式来提取 tool calls
    return {
      // TODO: 实现具体的提取逻辑
      placeholder: 'TODO'
    }
  }

  private extractFinalToolCallsCount(response: any, format: 'openai' | 'anthropic'): number {
    if (format === 'openai') {
      return response?.choices?.[0]?.message?.tool_calls?.length || 0
    } else {
      const content = response?.content || []
      return content.filter((block: any) => block.type === 'tool_use').length
    }
  }
}

// 全局实例
export const toolCallDebugger = new ToolCallDebugger()

// 便捷函数
export function createToolCallSession(sessionId: string): void {
  toolCallDebugger.createSession(sessionId)
}

export function traceToolCallFlow(
  sessionId: string,
  phase: 'request' | 'kiro_request' | 'kiro_response' | 'response',
  format: 'openai' | 'anthropic' | 'kiro',
  data: unknown,
  metadata?: Record<string, unknown>
): void {
  toolCallDebugger.addTrace(sessionId, {
    id: `${sessionId}-${phase}`,
    phase,
    format,
    data,
    metadata
  })
}

export function completeToolCallSession(sessionId: string, status: 'completed' | 'error' = 'completed'): void {
  toolCallDebugger.completeSession(sessionId, status)
}

export function getToolCallSessionReport(sessionId: string): string {
  return toolCallDebugger.generateSessionReport(sessionId)
}