<div align="center">

# KiroGate

**OpenAI & Anthropic 兼容的 Kiro IDE API 代理网关**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Deno](https://img.shields.io/badge/Deno-2.x-blue.svg)](https://deno.land/)

*通过任何支持 OpenAI 或 Anthropic API 的工具使用 Claude 模型*

[功能特性](#-功能特性) • [快速开始](#-快速开始) • [配置说明](#%EF%B8%8F-配置说明) • [API 参考](#-api-参考) • [部署](#-部署)

</div>

---

> **致谢**: 本项目基于 [kiro-openai-gateway](https://github.com/Jwadow/kiro-openai-gateway) by [@Jwadow](https://github.com/jwadow) 开发，整合 [kiro-account-manager](https://github.com/dext7r/kiro-account-manager) 全部功能。

---

## ✨ 功能特性

- **双 API 兼容** — 同时支持 OpenAI (`/v1/chat/completions`) 和 Anthropic (`/v1/messages`) 格式
- **完整流式传输** — SSE 流式响应，支持 Thinking 标签解析
- **工具调用** — 完整的 Function Calling / Tool Use 支持
- **多账号智能调度** — 账号池 + 健康分数 + 自动故障转移 + 配额追踪
- **多租户认证** — 简单 API Key / 组合模式 / 托管 API Key 三种认证方式
- **上下文压缩** — 三层缓存 + AI 摘要，自动压缩超长对话
- **熔断器 + 限流** — 令牌桶限流 + 熔断器模式保护后端
- **管理面板** — 内置 Web UI，账号管理、API Key 管理、Dashboard 监控
- **零外部依赖** — Deno 原生运行，内置 KV 存储，无需 Redis/数据库

## 📁 项目结构

```
kirogate/
├── main.ts              # 入口 + HTTP 路由 + 管理 API
├── CHANGELOG.md         # 变更记录
├── lib/
│   ├── types.ts                 # 类型定义和归一化会话类型
│   ├── kiroApi.ts               # Kiro API 客户端（双端点、重试、状态决策）
│   ├── kiroCompiler.ts          # OpenAI / Anthropic -> Kiro 请求编译层
│   ├── http_handlers.ts         # OpenAI / Anthropic HTTP 处理器
│   ├── translator.ts            # 协议适配（OpenAI / Anthropic ↔ Kiro）
│   ├── stream.ts                # 流处理（AWS Event Stream + SSE）
│   ├── accountPool.ts           # 多账号智能调度池
│   ├── compressor.ts            # 上下文压缩（三层缓存 + AI 摘要）
│   ├── storage.ts               # Deno KV 存储层
│   ├── rateLimiter.ts           # 令牌桶限流
│   ├── errorHandler.ts          # 错误分类 + 熔断器
│   ├── logger.ts                # 日志系统
│   ├── toolCallDebugger.ts      # tool loop 调试追踪
│   └── pages.ts                 # 嵌入式 HTML 前端页面
├── testapi/                     # 上游 Kiro API 黑盒 canary
├── lib/*_test.ts                # 本地单元 / 集成回归测试
└── deno.json            # Deno 配置
```

## 🧪 测试

```bash
# 类型检查
deno check main.ts lib/http_handlers.ts lib/kiroApi.ts

# 本地回归测试
deno test lib/kiroApi_test.ts lib/kiroCompiler_test.ts lib/translator_test.ts lib/gateway_integration_test.ts lib/http_handlers_test.ts

# 上游 Kiro API 黑盒 canary
deno test --allow-net --allow-env --allow-read --allow-write --allow-run=sqlite3 --unstable-kv testapi/kiro_api_behavior_test.ts
```

## 🚀 快速开始

### 环境要求

- [Deno](https://deno.land/) 2.x+

### 本地运行

```bash
# 设置环境变量
export PROXY_API_KEY="your-secret-api-key"
export ADMIN_PASSWORD="your-admin-password"

# 启动服务
deno run --allow-net --allow-env --unstable-kv main.ts

# 或使用 deno task
deno task start

# 开发模式（自动重载）
deno task dev
```

服务启动后访问 `http://localhost:8000` 查看首页。

### 添加账号

1. 访问 `http://localhost:8000/admin/accounts`
2. 输入管理密码（`ADMIN_PASSWORD`）
3. 点击「添加账号」，粘贴 Kiro 的 Refresh Token
4. 系统会自动刷新 Access Token

### 发送请求

```bash
# OpenAI 格式
curl http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'

# Anthropic 格式
curl http://localhost:8000/v1/messages \
  -H "x-api-key: your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## ⚙️ 配置说明

通过环境变量配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXY_API_KEY` | `changeme_proxy_secret` | API 代理密钥 |
| `ADMIN_PASSWORD` | `admin` | 管理面板密码 |
| `PORT` | `8000` | 监听端口 |
| `LOG_LEVEL` | `INFO` | 日志级别（DEBUG/INFO/WARN/ERROR） |
| `RATE_LIMIT_PER_MINUTE` | `0` | 全局限流（0=不限） |
| `ENABLE_COMPRESSION` | `true` | 启用上下文压缩 |

## 🔑 认证方式

支持三种认证模式：

### 模式 1: 简单模式

使用 `PROXY_API_KEY` 直接认证，请求由服务端账号池分配账号：

```
Authorization: Bearer YOUR_PROXY_API_KEY
```

### 模式 2: 组合模式（多租户）

用户自带 Refresh Token，格式为 `PROXY_API_KEY:REFRESH_TOKEN`：

```
Authorization: Bearer YOUR_PROXY_API_KEY:YOUR_REFRESH_TOKEN
```

### 模式 3: 托管 API Key

通过管理面板创建的 `kg-` 前缀 Key，支持额度限制和模型限制：

```
Authorization: Bearer kg-xxxxxxxxxxxxxxxx
```

## 📡 API 参考

### 代理端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1/models` | 获取可用模型列表 |
| `POST` | `/v1/chat/completions` | OpenAI 聊天补全 |
| `POST` | `/v1/messages` | Anthropic Messages API |
| `GET` | `/health` | 健康检查 |

### 管理端点（需 Admin 密码）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET/POST` | `/api/accounts` | 账号列表 / 添加账号 |
| `PUT/DELETE` | `/api/accounts/:id` | 更新 / 删除账号 |
| `POST` | `/api/accounts/:id/refresh` | 手动刷新 Token |
| `GET/POST` | `/api/keys` | API Key 列表 / 创建 Key |
| `PUT/DELETE` | `/api/keys/:id` | 更新 / 删除 Key |
| `GET` | `/api/proxy/status` | 代理状态（无需认证） |
| `GET` | `/api/proxy/health` | 健康报告（无需认证） |
| `GET` | `/api/proxy/stats` | 详细统计 |
| `GET` | `/api/proxy/logs` | 请求日志 |
| `PUT` | `/api/proxy/config` | 更新运行时配置 |
| `GET/PUT` | `/api/settings` | 获取 / 更新设置 |

### 前端页面

| 路径 | 说明 |
|------|------|
| `/` | 首页 |
| `/docs` | API 文档 |
| `/swagger` | Swagger UI |
| `/playground` | 在线测试 |
| `/deploy` | 部署指南 |
| `/dashboard` | 监控面板 |
| `/admin/accounts` | 账号管理 |
| `/admin/keys` | API Key 管理 |

### 支持的模型

- `claude-opus-4-5`
- `claude-sonnet-4-5`
- `claude-sonnet-4`
- `claude-haiku-4-5`
- `claude-3-7-sonnet-20250219`

## 💻 SDK 使用示例

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8000/v1",
    api_key="your-secret-api-key"
)

response = client.chat.completions.create(
    model="claude-sonnet-4-5",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content, end="")
```

### Python (Anthropic SDK)

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:8000",
    api_key="your-secret-api-key"
)

message = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content[0].text)
```

### Node.js (OpenAI SDK)

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8000/v1",
  apiKey: "your-secret-api-key",
});

const stream = await client.chat.completions.create({
  model: "claude-sonnet-4-5",
  messages: [{ role: "user", content: "Hello!" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

## 🐳 部署

### Docker

```dockerfile
FROM denoland/deno:latest
WORKDIR /app
COPY . .
EXPOSE 8000
CMD ["run", "--allow-net", "--allow-env", "--unstable-kv", "main.ts"]
```

```bash
docker build -t kirogate .
docker run -d -p 8000:8000 \
  -e PROXY_API_KEY="your-key" \
  -e ADMIN_PASSWORD="admin123" \
  kirogate
```

### Docker Compose

```yaml
version: "3"
services:
  kirogate:
    build: .
    ports:
      - "8000:8000"
    environment:
      - PROXY_API_KEY=your-key
      - ADMIN_PASSWORD=admin123
    restart: unless-stopped
```

### Deno Deploy

```bash
deno install -A jsr:@deno/deployctl
deployctl deploy --project=your-project main.ts
```

## 🏗️ 架构说明

### 多账号调度

账号池支持三种调度模式：
- **Smart**（默认）— 基于健康分数 + 并发感知的智能调度
- **Priority** — 按优先级顺序使用
- **Balanced** — 均匀分配请求

每个账号维护 0-100 的健康分数，基于成功率、错误率和冷却状态动态调整。全部账号不可用时自动触发自愈机制。

### 上下文压缩

当对话超过 token 阈值时自动触发：
1. 保留最近 N 条消息不压缩
2. 历史消息分批发送给 Claude Haiku 生成摘要
3. 三层缓存加速：增量内存 → LRU 内存 → Deno KV 持久化

### 熔断器

采用 CLOSED → OPEN → HALF_OPEN 三态模型，连续失败达到阈值后自动熔断，保护后端服务。

## 📄 许可证

[AGPL-3.0](LICENSE)
