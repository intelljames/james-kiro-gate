#!/usr/bin/env bash

# Tool Call 测试脚本 - 用于验证 KiroGate 的 tool call 闭环处理

set -e

KIROGATE_URL="http://localhost:8000"
API_KEY="changeme_proxy_secret"

echo "=== KiroGate Tool Call 测试 ==="
echo "目标: 验证 tool call 的完整闭环处理"
echo "URL: $KIROGATE_URL"
echo ""

# 测试 1: OpenAI 格式的 tool call
echo "测试 1: OpenAI 格式 - 单个 tool call"
echo "----------------------------------------"

RESPONSE1=$(curl -s -X POST "$KIROGATE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
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
                "name": "$TOOL_NAME",
                "arguments": $TOOL_ARGS
              }
            },
            "required": ["city"]
          }
        }
      }
    ],
    "stream": false
  }')

echo "响应 1:"
echo "$RESPONSE1" | jq '.'
echo ""

# 提取 tool call 信息
TOOL_CALL_ID=$(echo "$RESPONSE1" | jq -r '.choices[0].message.tool_calls[0].id // empty')
TOOL_NAME=$(echo "$RESPONSE1" | jq -r '.choices[0].message.tool_calls[0].function.name // empty')
TOOL_ARGS=$(echo "$RESPONSE1" | jq -r '.choices[0].message.tool_calls[0].function.arguments // empty')

if [ -n "$TOOL_CALL_ID" ]; then
  echo "检测到 tool call:"
  echo "  ID: $TOOL_CALL_ID"
  echo "  Name: $TOOL_NAME"
  echo "  Args: $TOOL_ARGS"
  echo ""
  
  # 测试 2: 发送 tool result
  echo "测试 2: 发送 tool result"
  echo "----------------------------------------"
  
  RESPONSE2=$(curl -s -X POST "$KIROGATE_URL/v1/chat/completions" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"claude-sonnet-4-5\",
      \"messages\": [
        {\"role\": \"user\", \"content\": \"请帮我获取今天的天气信息，我在北京\"},
        {
          \"role\": \"assistant\",
          \"content\": null,
          \"tool_calls\": [
            {
              \"id\": \"$TOOL_CALL_ID\",
              \"type\": \"function\",
              \"function\": {
                \"name\": \"$TOOL_NAME\",
                \"arguments\": \"$TOOL_ARGS\"
              }
            }
          ]
        },
        {
          \"role\": \"tool\",
          \"tool_call_id\": \"$TOOL_CALL_ID\",
          \"content\": \"北京今天天气：晴朗，温度 15-25°C，湿度 45%，风力 2-3 级\"
        }
      ],
      \"stream\": false
    }")
  
  echo "响应 2:"
  echo "$RESPONSE2" | jq '.'
  echo ""
  
  # 分析响应
  ASSISTANT_CONTENT=$(echo "$RESPONSE2" | jq -r '.choices[0].message.content // empty')
  NEW_TOOL_CALLS=$(echo "$RESPONSE2" | jq -r '.choices[0].message.tool_calls // empty')
  
  echo "分析结果:"
  echo "  Assistant 内容: $ASSISTANT_CONTENT"
  echo "  新的 tool calls: $NEW_TOOL_CALLS"
  
  if [ "$NEW_TOOL_CALLS" = "null" ] && [ -n "$ASSISTANT_CONTENT" ]; then
    echo "  ✅ Tool call 闭环成功 - LLM 正确处理了 tool result"
  else
    echo "  ❌ Tool call 闭环失败 - LLM 可能误认为这是新对话"
  fi
else
  echo "❌ 未检测到 tool call，跳过后续测试"
fi

echo ""
echo "测试 3: Anthropic 格式 - 单个 tool call"
echo "----------------------------------------"

RESPONSE3=$(curl -s -X POST "$KIROGATE_URL/v1/messages" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "请帮我计算 15 * 23 的结果"}
    ],
    "tools": [
      {
        "name": "calculator",
        "description": "执行数学计算",
        "input_schema": {
          "type": "object",
          "properties": {
            "expression": {
              "type": "string",
              "description": "要计算的数学表达式"
            }
          },
          "required": ["expression"]
        }
      }
    ]
  }')

echo "响应 3:"
echo "$RESPONSE3" | jq '.'
echo ""

# 提取 Anthropic tool use 信息
TOOL_USE_ID=$(echo "$RESPONSE3" | jq -r '.content[] | select(.type == "tool_use") | .id // empty')
TOOL_USE_NAME=$(echo "$RESPONSE3" | jq -r '.content[] | select(.type == "tool_use") | .name // empty')
TOOL_USE_INPUT=$(echo "$RESPONSE3" | jq -r '.content[] | select(.type == "tool_use") | .input // empty')

if [ -n "$TOOL_USE_ID" ]; then
  echo "检测到 tool use:"
  echo "  ID: $TOOL_USE_ID"
  echo "  Name: $TOOL_USE_NAME"
  echo "  Input: $TOOL_USE_INPUT"
  echo ""
  
  # 测试 4: 发送 tool result (Anthropic 格式)
  echo "测试 4: 发送 tool result (Anthropic 格式)"
  echo "----------------------------------------"
  
  RESPONSE4=$(curl -s -X POST "$KIROGATE_URL/v1/messages" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"claude-sonnet-4-5\",
      \"max_tokens\": 1024,
      \"messages\": [
        {\"role\": \"user\", \"content\": \"请帮我计算 15 * 23 的结果\"},
        {
          \"role\": \"assistant\",
          \"content\": [
            {
              \"type\": \"tool_use\",
              \"id\": \"$TOOL_USE_ID\",
              \"name\": \"$TOOL_USE_NAME\",
              \"input\": $TOOL_USE_INPUT
            }
          ]
        },
        {
          \"role\": \"user\",
          \"content\": [
            {
              \"type\": \"tool_result\",
              \"tool_use_id\": \"$TOOL_USE_ID\",
              \"content\": \"345\"
            }
          ]
        }
      ]
    }")
  
  echo "响应 4:"
  echo "$RESPONSE4" | jq '.'
  echo ""
  
  # 分析响应
  TEXT_CONTENT=$(echo "$RESPONSE4" | jq -r '.content[] | select(.type == "text") | .text // empty')
  NEW_TOOL_USES=$(echo "$RESPONSE4" | jq -r '[.content[] | select(.type == "tool_use")] | length')
  
  echo "分析结果:"
  echo "  文本内容: $TEXT_CONTENT"
  echo "  新的 tool uses: $NEW_TOOL_USES"
  
  if [ "$NEW_TOOL_USES" = "0" ] && [ -n "$TEXT_CONTENT" ]; then
    echo "  ✅ Tool call 闭环成功 - LLM 正确处理了 tool result"
  else
    echo "  ❌ Tool call 闭环失败 - LLM 可能误认为这是新对话"
  fi
else
  echo "❌ 未检测到 tool use，跳过后续测试"
fi

echo ""
echo "=== 测试完成 ==="
echo "请检查 KiroGate 日志中的 ToolCallDebug 信息以获取详细的调试数据"