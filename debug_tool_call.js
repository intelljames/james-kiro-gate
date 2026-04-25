#!/usr/bin/env node

// 简单的测试脚本来验证 OpenAI 到 Kiro 的转换逻辑

const testMessages = [
  {"role": "user", "content": "请帮我获取今天的天气信息，我在北京"},
  {
    "role": "assistant",
    "content": null,
    "tool_calls": [
      {
        "id": "test_tool_123",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"city\":\"北京\"}"
        }
      }
    ]
  },
  {
    "role": "tool",
    "tool_call_id": "test_tool_123",
    "content": "北京今天天气：晴朗，温度 15-25°C"
  }
];

console.log("=== 测试消息序列 ===");
console.log(JSON.stringify(testMessages, null, 2));

console.log("\n=== 预期的 Kiro 格式 ===");
console.log("History 应该包含:");
console.log("1. user: 请帮我获取今天的天气信息，我在北京");
console.log("2. assistant: (with tool_use)");
console.log("3. user: Tool results provided. (with toolResults in userInputMessageContext)");
console.log("\nCurrent message 应该是:");
console.log("user: Continue (没有 toolResults)");
