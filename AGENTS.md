# AGENTS.md

Essential guidance for working with KiroGate - an API gateway for Kiro IDE.

## Development Commands

```bash
# Development with auto-reload
deno task dev

# Production start
deno task start

# Type checking
deno task check

# Manual run with permissions
deno run --allow-net --allow-env --unstable-kv main.ts
```

## Required Environment Variables

Critical for operation:
- `PROXY_API_KEY` - API gateway authentication key
- `ADMIN_PASSWORD` - Web UI admin access

## Key Architecture Points

### Storage System
- Uses Deno KV (--unstable-kv flag required)

### Account Management
Supports three auth modes:
1. Simple: `PROXY_API_KEY` only
2. Combined: `PROXY_API_KEY:REFRESH_TOKEN`
3. Managed: `kg-` prefixed keys with quotas

### API Compatibility
- OpenAI format: `/v1/chat/completions`
- Anthropic format: `/v1/messages`
- Both support streaming and tool calls

## Development Gotchas

### Deno Permissions
Always include `--unstable-kv` flag - the KV storage is essential for account/key management.

### Model Names
Uses Kiro-specific model identifiers:
- `claude-sonnet-4-5`
- `claude-opus-4-5`
- `claude-haiku-4-5`

### Admin UI Access
Web management interface at `/admin/accounts` and `/admin/keys` requires `ADMIN_PASSWORD`.

## Testing Endpoints

Quick verification commands:
```bash
# Health check
curl http://localhost:8000/health

# Model list
curl http://localhost:8000/v1/models

# OpenAI format test
curl http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"test"}]}'
```