# testapi

这个目录用于直连上游 Kiro API，做黑盒行为研究，不修改现有 `KiroGate` 实现。

目标：

- 验证 `conversationState.history` / `currentMessage` 的真实约束
- 验证空 `content`、`toolUses`、`toolResults` 等场景的上游行为
- 优先研究 CLI 链路，也就是 `q.{region}.amazonaws.com/generateAssistantResponse`
- 输出可复现的实验结果，帮助后续重构代理层

运行方式：

```bash
"/Users/wangchang/.deno/bin/deno" test --allow-net --allow-env --allow-read --allow-write --allow-run=sqlite3 --unstable-kv testapi/kiro_api_behavior_test.ts
```

说明：

- 测试会读取本机 Kiro CLI 凭证与 `kirogate.kv` 中保存的账号
- 测试会直接请求真实上游 API，可能消耗额度
- 默认只做最小化验证；工具调用类实验会显式标记
