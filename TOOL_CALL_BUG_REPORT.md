# Tool Call 闭环问题 - Bug 报告

## 问题描述

当使用 OpenAI 格式发送包含 tool result 的请求时，LLM 会忽略 tool result 并重新发起工具调用，导致 tool call 无法正确闭环。

## 复现步骤

### 测试场景
1. 发送包含工具定义的请求
2. LLM 返回 tool call
3. 发送包含 tool result 的后续请求
4. **预期**：LLM 应该基于 tool result 给出最终答案
5. **实际**：LLM 忽略 tool result，重新发起工具调用

### 测试代码
```bash
# 步骤 1: 发送初始请求
curl -X POST "http://localhost:8000/v1/chat/completions" \
  -H "Authorization: Bearer changeme_proxy_secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [
      {"role": "user", "content": "请帮我获取今天的天气信息，我在北京"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "获取指定城市的天气信息",
          "parameters": {
            "type": "object",
            "properties": {
              "city": {"type": "string", "description": "城市名称"}
            },
            "required": ["city"]
          }
        }
      }
    ],
    "stream": false
  }'

# 响应包含 tool call:
# {
#   "choices": [{
#     "message": {
#       "tool_calls": [{
#         "id": "tooluse_5K4WIqjyPt78DN4Ps8KRLK",
#         "function": {
#           "name": "get_weather",
#           "arguments": "{\"city\":\"北京\"}"
#         }
#       }]
#     }
#   }]
# }

# 步骤 2: 发送 tool result
curl -X POST "http://localhost:8000/v1/chat/completions" \
  -H "Authorization: Bearer changeme_proxy_secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [
      {"role": "user", "content": "请帮我获取今天的天气信息，我在北京"},
      {
        "role": "assistant",
        "content": null,
        "tool_calls": [{
          "id": "tooluse_5K4WIqjyPt78DN4Ps8KRLK",
          "type": "function",
          "function": {
            "name": "get_weather",
            "arguments": "{\"city\":\"北京\"}"
          }
        }]
      },
      {
        "role": "tool",
        "tool_call_id": "tooluse_5K4WIqjyPt78DN4Ps8KRLK",
        "content": "北京今天天气：晴朗，温度 15-25°C"
      }
    ],
    "stream": false
  }'

# 实际响应：
# {
#   "choices": [{
#     "message": {
#       "content": "我来帮你查询北京今天的天气信息。\n\n<search_web>..."
#     }
#   }]
# }
# LLM 完全忽略了 tool result，重新发起了查询
```

## 根本原因分析

### 问题位置
文件：`lib/translator.ts`
行号：159-176

### 问题代码
```typescript
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
  if (shouldFlush && toolResults.length > 0 && !isLast) {  // ← 问题在这里
    history.push({ userInputMessage: {
      content: 'Tool results provided.', modelId, origin,
      userInputMessageContext: { toolResults: [...toolResults] }
    }})
    toolResults.length = 0
  }
}
```

### 问题分析

**第 169 行的条件判断有误：**
```typescript
if (shouldFlush && toolResults.length > 0 && !isLast)
```

这个条件中的 `!isLast` 导致：
- 当 tool message 是消息列表中的最后一条时，tool results **不会**被添加到 history 中
- 相反，tool results 会在第 182-194 行被添加到 **current message** 的 `userInputMessageContext` 中

**为什么这会导致问题？**

在 Kiro API 的格式中：
1. **History** 中的 `userInputMessage` 包含 `toolResults` → Kiro 理解这是历史对话中的工具执行结果
2. **Current message** 中的 `userInputMessage` 包含 `toolResults` → Kiro 理解这是**当前轮次**需要处理的工具结果

当 tool result 被放在 current message 中时，Kiro API 会认为：
- 这是一个新的对话轮次
- 用户刚刚提供了工具执行结果
- 但是没有对应的 assistant 工具调用在 history 中
- 因此 LLM 无法将 tool result 与之前的 tool call 关联起来
- 结果就是 LLM 忽略 tool result，重新开始对话

### 对比：Anthropic 格式为什么能正常工作？

查看 `claudeToKiro` 函数（第 310-400 行），Anthropic 格式的处理逻辑不同：

```typescript
// Anthropic 格式会正确地将 tool_result 放入 history
if (msg.role === 'user') {
  // ... 处理 tool_result blocks
  if (toolResults.length > 0) {
    history.push({ userInputMessage: {
      content: userContent || 'Tool results provided.',
      modelId, origin,
      userInputMessageContext: { toolResults: [...toolResults] }
    }})
  }
}
```

Anthropic 格式没有 `!isLast` 的限制，所以 tool results 总是被正确地添加到 history 中。

## 证据总结

### 证据 1：测试结果
- **OpenAI 格式**：Tool call 闭环失败 ❌
- **Anthropic 格式**：Tool call 闭环成功 ✅

### 证据 2：代码分析
- `lib/translator.ts:169` - `!isLast` 条件导致最后的 tool message 处理不当
- `lib/translator.ts:182-194` - Tool results 被错误地放在 current message 而不是 history

### 证据 3：Kiro API 行为
- 当 tool results 在 current message 中时，Kiro 无法将其与 history 中的 tool call 关联
- LLM 因此忽略 tool result，重新开始对话

## 根本原因（更新）

经过进一步分析，发现问题有**两个层面**：

### 问题 1：translator.ts 中的 `!isLast` 条件
第 169 行的 `!isLast` 条件阻止了最后的 tool message 被添加到 history。

### 问题 2：buildKiroPayload 中的重复添加
即使修复了问题 1，`buildKiroPayload` 函数（kiroApi.ts:462-466）仍然会将 `toolResults` 参数添加到 current message 中：

```typescript
const validatedToolResults = validateToolResults(toolResults, history)
if (tools.length > 0 || validatedToolResults.length > 0) {
  currentUserInputMessage.userInputMessageContext = {}
  if (tools.length > 0) currentUserInputMessage.userInputMessageContext.tools = tools
  if (validatedToolResults.length > 0) currentUserInputMessage.userInputMessageContext.toolResults = validatedToolResults
}
```

这导致即使 tool results 已经在 history 中，它们仍然会被添加到 current message，造成混淆。

## 修复方案（完整版）

需要同时修复两个问题：

### 修复 1：移除 translator.ts 中的 `!isLast` 条件

**文件：** `lib/translator.ts`  
**行号：** 169

```typescript
// 修改前
if (shouldFlush && toolResults.length > 0 && !isLast) {
  history.push({ userInputMessage: {
    content: 'Tool results provided.', modelId, origin,
    userInputMessageContext: { toolResults: [...toolResults] }
  }})
  toolResults.length = 0
}

// 修改后
if (shouldFlush && toolResults.length > 0) {
  history.push({ userInputMessage: {
    content: 'Tool results provided.', modelId, origin,
    userInputMessageContext: { toolResults: [...toolResults] }
  }})
  toolResults.length = 0
}
```

### 修复 2：确保 toolResults 不会传递到 buildKiroPayload

**文件：** `lib/translator.ts`  
**行号：** 195-199

```typescript
// 修改前
return buildKiroPayload(
  finalContent, modelId, origin, history, kiroTools, toolResults, images, profileArn,
  { maxTokens: request.max_tokens, temperature: request.temperature, topP: request.top_p },
  thinkingEnabled, conversationId, thinkingBudget
)

// 修改后
// 如果 toolResults 已经被添加到 history 中，则不应该再传递给 buildKiroPayload
// 因为这会导致它们被重复添加到 current message 中
return buildKiroPayload(
  finalContent, modelId, origin, history, kiroTools, [], images, profileArn,
  { maxTokens: request.max_tokens, temperature: request.temperature, topP: request.top_p },
  thinkingEnabled, conversationId, thinkingBudget
)
```

**理由：**
- 修复 1 确保 tool results 被正确添加到 history
- 修复 2 确保 tool results 不会被重复添加到 current message
- 这样 Kiro API 才能正确理解对话上下文

## 验证方法

修复后，使用以下测试验证：

```bash
# 运行测试脚本
./test_tool_calls.sh

# 预期结果：
# - OpenAI 格式测试 2 应该成功 ✅
# - LLM 应该基于 tool result 给出最终答案，而不是重新发起工具调用
```

## 影响范围

- **受影响**：所有使用 OpenAI 格式的 tool call 请求
- **不受影响**：Anthropic 格式的 tool call 请求（已经正常工作）
- **严重程度**：高 - 导致 tool call 功能完全无法正常使用

## 相关文件

- `lib/translator.ts` - 主要问题所在
- `lib/kiroApi.ts` - Kiro API 调用逻辑
- `test_tool_calls.sh` - 测试脚本
- `lib/toolCallDebugger.ts` - 调试工具（新增）

## 时间线

- 2026-04-16 15:00 - 问题报告
- 2026-04-16 15:05 - 添加调试日志
- 2026-04-16 15:10 - 定位根本原因
- 2026-04-16 15:15 - 编写修复方案
