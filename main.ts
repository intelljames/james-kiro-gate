/**
 * KiroGate - Deno Modular Edition
 *
 * OpenAI & Anthropic 兼容的 Kiro API 网关
 * 基于 KiroGate by dext7r，整合 kiro-account-manager 全部功能
 *
 * 用法: deno run --allow-net --allow-env --unstable-kv main.ts
 */

// ============================================================================
// 模块导入
// ============================================================================
import type { ProxyAccount, RequestLog } from './lib/types.ts'
import { logger, setLogLevel } from './lib/logger.ts'
import {
  initStorage, closeStorage,
  setAccount as storageSetAccount,
  deleteAccount as storageDeleteAccount, getAllAccounts as storageGetAllAccounts,
  getApiKey as storageGetApiKey, setApiKey as storageSetApiKey,
  deleteApiKey as storageDeleteApiKey, getAllApiKeys as storageGetAllApiKeys,
  saveStats, loadStats, saveRequestLogs, loadRequestLogs
} from './lib/storage.ts'
import type { ApiKey } from './lib/types.ts'
import { AccountPool } from './lib/accountPool.ts'
import {
  fetchKiroModels, updateModelCache, getCachedModels,
  prewarmDNS,
  getEndpointHealthStats, getDNSCacheStats, summarizeKiroPayload
} from './lib/kiroApi.ts'
import { CircuitBreaker } from './lib/errorHandler.ts'
import { RateLimiter } from './lib/rateLimiter.ts'
import {
  getCompressorConfig, updateCompressorConfig, getCompressionStats,
  startPeriodicCleanup, getCacheInfo
} from './lib/compressor.ts'
import {
  renderHomePage, renderDocsPage, renderPlaygroundPage, renderDeployPage,
  renderDashboardPage, renderSwaggerPage, renderAccountsPage, renderApiKeysPage,
  generateOpenAPISpec
} from './lib/pages.ts'
import { handleAnthropicMessages, handleChatCompletions } from './lib/http_handlers.ts'

// ============================================================================
// 静态资源代理基地址
// ============================================================================
const PROXY_BASE = "";

// 应用配置
// ============================================================================
const APP_VERSION = '3.0.0-deno'
const APP_TITLE = 'KiroGate'

interface AppSettings {
  proxyApiKey: string
  adminPassword: string
  port: number
  logLevel: string
  rateLimitPerMinute: number
  enableCompression: boolean
  debugPayload: boolean
  debugFullPayload: boolean
}

function loadSettings(): AppSettings {
  return {
    proxyApiKey: Deno.env.get('PROXY_API_KEY') || 'changeme_proxy_secret',
    adminPassword: Deno.env.get('ADMIN_PASSWORD') || 'admin',
    port: parseInt(Deno.env.get('PORT') || '8000'),
    logLevel: Deno.env.get('LOG_LEVEL') || 'INFO',
    rateLimitPerMinute: parseInt(Deno.env.get('RATE_LIMIT_PER_MINUTE') || '0'),
    enableCompression: Deno.env.get('ENABLE_COMPRESSION') !== 'false',
    debugPayload: Deno.env.get('DEBUG_KIRO_PAYLOAD') === 'true',
    debugFullPayload: Deno.env.get('DEBUG_KIRO_FULL_PAYLOAD') === 'true',
  }
}

const settings = loadSettings()

// ============================================================================
// 全局状态
// ============================================================================
const accountPool = new AccountPool()
const rateLimiter = new RateLimiter()
const circuitBreaker = new CircuitBreaker(5, 60000)

// 请求统计
type DashboardRequestLog = {
  timestamp: number
  method: string
  path: string
  status: number
  duration: number
  model?: string
  apiType?: string
  error?: string
  accountId?: string
  tokens?: number
}

type PersistedStats = {
  totalRequests?: number
  successRequests?: number
  errorRequests?: number
  streamRequests?: number
  nonStreamRequests?: number
  totalTokens?: number
  totalInputTokens?: number
  totalOutputTokens?: number
  startTime?: number
}

const metrics = {
  totalRequests: 0, successRequests: 0, errorRequests: 0,
  streamRequests: 0, nonStreamRequests: 0,
  totalTokens: 0, totalInputTokens: 0, totalOutputTokens: 0,
  startTime: Date.now(), requestLog: [] as DashboardRequestLog[]
}

// Token 刷新相关
const KIRO_REFRESH_URL = (region: string) => `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`
const KIRO_IDC_TOKEN_URL = (region: string) => `https://oidc.${region}.amazonaws.com/token`

// 从 kiro-cli SQLite 读取 OIDC 凭证
async function readKiroCliCredentials(): Promise<{ clientId: string; clientSecret: string } | null> {
  try {
    const dbPath = `${Deno.env.get('HOME')}/Library/Application Support/kiro-cli/data.sqlite3`
    const cmd = new Deno.Command('sqlite3', {
      args: [dbPath, "SELECT json_extract(value, '$.client_id'), json_extract(value, '$.client_secret') FROM auth_kv WHERE key = 'kirocli:odic:device-registration'"],
      stdout: 'piped',
      stderr: 'null'
    })
    const { stdout } = await cmd.output()
    const output = new TextDecoder().decode(stdout).trim()
    const parts = output.split('|')
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { clientId: parts[0], clientSecret: parts[1] }
    }
    return null
  } catch {
    return null
  }
}

// ============================================================================
// Token 刷新
// ============================================================================
async function refreshAccountToken(account: ProxyAccount): Promise<boolean> {
  if (!account.refreshToken) return false
  const region = account.region || 'us-east-1'
  const isIdc =
    account.authMethod === 'idc' ||
    account.authMethod === 'IdC' ||
    (!!account.clientId && !!account.clientSecret)
  try {
    if (isIdc && (!account.clientId || !account.clientSecret)) {
      logger.error('Auth', `IDC refresh missing client credentials for ${account.email || account.id}`)
      accountPool.markRefreshComplete(account.id, false, undefined, true)
      return false
    }

    const refreshUrl = isIdc ? KIRO_IDC_TOKEN_URL(region) : KIRO_REFRESH_URL(region)
    const requestBody = isIdc
      ? {
          refreshToken: account.refreshToken,
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          grantType: 'refresh_token'
        }
      : {
          refreshToken: account.refreshToken
        }

    const resp = await fetch(refreshUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    })

    // Social login 401 时自动回退到 IDC 方式
    if (!resp.ok && (resp.status === 400 || resp.status === 401) && !isIdc) {
      logger.warn('Auth', `Social refresh failed for ${account.email || account.id}, trying IDC fallback...`)

      // 先用账号自带的 clientId/clientSecret 试
      let idcClientId = account.clientId
      let idcClientSecret = account.clientSecret

      // 没有的话从 kiro-cli SQLite 读
      if (!idcClientId || !idcClientSecret) {
        const creds = await readKiroCliCredentials()
        if (creds) {
          idcClientId = creds.clientId
          idcClientSecret = creds.clientSecret
          logger.info('Auth', `Using kiro-cli credentials for IDC fallback`)
        }
      }

      if (idcClientId && idcClientSecret) {
        const idcResp = await fetch(KIRO_IDC_TOKEN_URL(region), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            refreshToken: account.refreshToken,
            clientId: idcClientId,
            clientSecret: idcClientSecret,
            grantType: 'refresh_token'
          })
        })
        if (idcResp.ok) {
          const data = await idcResp.json()
          const newToken = data.accessToken || data.access_token
          const expiresIn = data.expiresIn || data.expires_in || 3600
          if (newToken) {
            accountPool.updateAccount(account.id, {
              accessToken: newToken,
              expiresAt: Date.now() + expiresIn * 1000,
              refreshToken: data.refreshToken || data.refresh_token || account.refreshToken,
              authMethod: account.authMethod || 'idc',
              clientId: account.clientId || idcClientId,
              clientSecret: account.clientSecret || idcClientSecret
            })
            accountPool.markRefreshComplete(account.id, true)
            logger.info('Auth', `Token refreshed via IDC fallback for ${account.email || account.id}`)
            return true
          }
        }
        const idcText = await idcResp.text().catch(() => '')
        logger.error('Auth', `IDC fallback failed for ${account.email || account.id}: ${idcResp.status} ${idcText.slice(0, 200)}`)
      } else {
        logger.error('Auth', `IDC fallback skipped: no clientId/clientSecret available for ${account.email || account.id}`)
      }
      accountPool.markRefreshComplete(account.id, false, undefined, true)
      return false
    }

    if (!resp.ok) {
      const text = await resp.text()
      logger.error('Auth', `Refresh failed for ${account.email || account.id}: ${resp.status} ${text.slice(0, 200)}`)
      if (resp.status === 400 || resp.status === 401) {
        accountPool.markRefreshComplete(account.id, false, undefined, true)
        return false
      }
      accountPool.markRefreshComplete(account.id, false)
      return false
    }
    const data = await resp.json()
    const newToken = data.accessToken || data.access_token
    const expiresIn = data.expiresIn || data.expires_in || 3600
    if (!newToken) { accountPool.markRefreshComplete(account.id, false); return false }
    accountPool.updateAccount(account.id, {
      accessToken: newToken,
      expiresAt: Date.now() + expiresIn * 1000,
      refreshToken: data.refreshToken || data.refresh_token || account.refreshToken
    })
    accountPool.markRefreshComplete(account.id, true)
    logger.info('Auth', `Token refreshed for ${account.email || account.id}`)
    return true
  } catch (e) {
    logger.error('Auth', `Refresh error: ${(e as Error).message}`)
    accountPool.markRefreshComplete(account.id, false)
    return false
  }
}

async function ensureValidToken(account: ProxyAccount): Promise<ProxyAccount> {
  if (account.expiresAt && account.expiresAt - Date.now() < 300000) {
    accountPool.markNeedsRefresh(account.id)
    await refreshAccountToken(account)
    return accountPool.getAccount(account.id) || account
  }
  return account
}

// ============================================================================
// 工具函数
// ============================================================================
function maskToken(token: string): string {
  if (!token || token.length < 8) return '***'
  return token.slice(0, 4) + '...' + token.slice(-4)
}

function recordRequest(entry: DashboardRequestLog) {
  if (entry.status < 400) metrics.successRequests++
  else metrics.errorRequests++
  if (entry.tokens) {
    metrics.totalTokens += entry.tokens
  }
  metrics.requestLog.push(entry)
  if (metrics.requestLog.length > 200) metrics.requestLog.shift()
}

function toPersistedRequestLogs(logs: DashboardRequestLog[]): RequestLog[] {
  return logs.map((log) => ({
    timestamp: log.timestamp,
    path: log.path,
    model: log.model || log.apiType || 'unknown',
    accountId: log.accountId || 'unknown',
    inputTokens: 0,
    outputTokens: log.tokens || 0,
    responseTime: log.duration,
    success: log.status < 400,
    error: log.error
  }))
}

function fromPersistedRequestLogs(logs: RequestLog[]): DashboardRequestLog[] {
  return logs.map((log) => ({
    timestamp: log.timestamp,
    method: 'POST',
    path: log.path,
    status: log.success ? 200 : 500,
    duration: log.responseTime,
    model: log.model,
    accountId: log.accountId,
    tokens: log.inputTokens + log.outputTokens,
    error: log.error
  }))
}

function readStatNumber(stats: PersistedStats | null, key: keyof PersistedStats): number {
  const value = stats?.[key]
  return typeof value === 'number' ? value : 0
}

// ============================================================================
// API Key 验证
// ============================================================================
async function verifyApiKey(req: Request): Promise<{ valid: boolean; refreshToken?: string; apiKey?: string; accountId?: string; apiKeyId?: string }> {
  const authHeader = req.headers.get('Authorization')
  const xApiKey = req.headers.get('x-api-key')
  let token = ''
  if (authHeader?.startsWith('Bearer ')) token = authHeader.slice(7)
  const providedKey = xApiKey || token
  if (!providedKey) return { valid: false }

  // 组合格式: PROXY_API_KEY:REFRESH_TOKEN
  const colonIndex = providedKey.indexOf(':')
  if (colonIndex > 0) {
    const apiKey = providedKey.slice(0, colonIndex)
    const refreshToken = providedKey.slice(colonIndex + 1)
    if (apiKey === settings.proxyApiKey) {
      logger.debug('Auth', `Multi-tenant: key:token (token: ${maskToken(refreshToken)})`)
      return { valid: true, refreshToken, apiKey }
    }
  }

  // 简单格式
  if (providedKey === settings.proxyApiKey) {
    logger.debug('Auth', 'Simple mode: API key only')
    return { valid: true, apiKey: providedKey }
  }

  // 检查存储的 API Key
  const storedKeys = await storageGetAllApiKeys()
  for (const key of storedKeys) {
    if (key.key === providedKey && key.enabled) {
      return { valid: true, apiKey: key.key, accountId: key.allowedAccountIds?.[0], apiKeyId: key.id }
    }
  }

  logger.warn('Auth', `Invalid API key: ${maskToken(providedKey)}`)
  return { valid: false }
}

// ============================================================================
// 账号选择 + Token 确保
// ============================================================================
async function selectAccount(model?: string, accountId?: string): Promise<ProxyAccount> {
  // 如果指定了 accountId，直接使用
  if (accountId) {
    const account = accountPool.getAccount(accountId)
    if (account) return await ensureValidToken(account)
  }
  // 从池中选择
  const account = accountPool.getNextAccount(model)
  if (!account) throw new Error('No available accounts. Please add accounts first.')
  return await ensureValidToken(account)
}

// 从 refreshToken 创建临时账号
async function getAccountFromRefreshToken(refreshToken: string): Promise<ProxyAccount> {
  // 检查池中是否已有此 refreshToken 的账号
  const accounts = accountPool.getAllAccounts()
  for (const acc of accounts) {
    if (acc.refreshToken === refreshToken) return await ensureValidToken(acc)
  }
  // 创建临时账号
  const tempId = 'temp_' + refreshToken.slice(0, 8)
  const existing = accountPool.getAccount(tempId)
  if (existing) return await ensureValidToken(existing)

  const tempAccount: ProxyAccount = {
    id: tempId, email: 'multi-tenant', refreshToken,
    accessToken: '', region: 'us-east-1', isAvailable: true, disabled: false,
    requestCount: 0, errorCount: 0
  }
  accountPool.addAccount(tempAccount)
  await refreshAccountToken(tempAccount)
  return accountPool.getAccount(tempId) || tempAccount
}

// ============================================================================
// 管理 API - Admin 密码验证
// ============================================================================
function verifyAdmin(req: Request): boolean {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return false
  return authHeader.slice(7) === settings.adminPassword
}

function adminGuard(req: Request): Response | null {
  if (!verifyAdmin(req)) {
    return Response.json({ error: 'Unauthorized: invalid admin password' }, { status: 401 })
  }
  return null
}

// ============================================================================
// 管理 API - 账号管理
// ============================================================================
async function handleAccountsApi(req: Request, path: string): Promise<Response> {
  const guard = adminGuard(req)
  if (guard) return guard

  // GET /api/accounts - 列出所有账号
  if (req.method === 'GET' && path === '/api/accounts') {
    const accounts = accountPool.getAllAccounts()
    const safeAccounts = accounts.map(a => ({
      id: a.id, email: a.email, region: a.region || 'us-east-1',
      subscriptionType: a.subscriptionType || 'unknown',
      hasRefreshToken: !!a.refreshToken, hasAccessToken: !!a.accessToken,
      expiresAt: a.expiresAt, machineId: a.machineId ? maskToken(a.machineId) : undefined,
      isAvailable: a.isAvailable !== false, disabled: a.disabled || false,
      quotaExhausted: a.quotaExhausted || false,
      requestCount: a.requestCount || 0, errorCount: a.errorCount || 0,
      lastUsed: a.lastUsed, profileArn: a.profileArn ? maskToken(a.profileArn) : undefined
    }))
    return Response.json({ accounts: safeAccounts, total: safeAccounts.length })
  }

  // POST /api/accounts - 添加账号
  if (req.method === 'POST' && path === '/api/accounts') {
    let body: Record<string, unknown>
    try { body = await req.json() } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    const refreshToken = body.refreshToken as string
    if (!refreshToken) {
      return Response.json({ error: 'refreshToken is required' }, { status: 400 })
    }
    const id = body.id as string || `acc_${crypto.randomUUID().slice(0, 8)}`
    const account: ProxyAccount = {
      id, email: (body.email as string) || '', accessToken: '',
      refreshToken, region: (body.region as string) || 'us-east-1',
      authMethod: body.authMethod as ('social' | 'idc' | 'IdC') | undefined,
      clientId: body.clientId as string,
      clientSecret: body.clientSecret as string,
      machineId: body.machineId as string, profileArn: body.profileArn as string,
      isAvailable: true, disabled: false, requestCount: 0, errorCount: 0
    }
    accountPool.addAccount(account)
    await storageSetAccount(account)
    // 立即刷新 token
    const refreshed = await refreshAccountToken(account)
    const updated = accountPool.getAccount(id)
    logger.info('Admin', `Account added: ${id} (refreshed: ${refreshed})`)
    return Response.json({ success: true, account: { id, email: account.email, refreshed }, subscriptionType: updated?.subscriptionType })
  }

  // 带 ID 的路由: /api/accounts/:id/...
  const idMatch = path.match(/^\/api\/accounts\/([^/]+)(.*)$/)
  if (!idMatch) return Response.json({ error: 'Not found' }, { status: 404 })
  const accountId = decodeURIComponent(idMatch[1])
  const subPath = idMatch[2]

  // DELETE /api/accounts/:id
  if (req.method === 'DELETE' && !subPath) {
    accountPool.removeAccount(accountId)
    await storageDeleteAccount(accountId)
    logger.info('Admin', `Account deleted: ${accountId}`)
    return Response.json({ success: true })
  }

  // PUT /api/accounts/:id
  if (req.method === 'PUT' && !subPath) {
    const account = accountPool.getAccount(accountId)
    if (!account) return Response.json({ error: 'Account not found' }, { status: 404 })
    let body: Record<string, unknown>
    try { body = await req.json() } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    const updates: Partial<ProxyAccount> = {}
    if (body.email !== undefined) updates.email = body.email as string
    if (body.region !== undefined) updates.region = body.region as string
    if (body.disabled !== undefined) updates.disabled = body.disabled as boolean
    if (body.isAvailable !== undefined) updates.isAvailable = body.isAvailable as boolean
    if (body.quotaExhausted !== undefined) updates.quotaExhausted = body.quotaExhausted as boolean
    if (body.refreshToken !== undefined) updates.refreshToken = body.refreshToken as string
    if (body.machineId !== undefined) updates.machineId = body.machineId as string
    if (body.authMethod !== undefined) updates.authMethod = body.authMethod as 'social' | 'idc' | 'IdC'
    if (body.clientId !== undefined) updates.clientId = body.clientId as string
    if (body.clientSecret !== undefined) updates.clientSecret = body.clientSecret as string
    if (body.profileArn !== undefined) updates.profileArn = body.profileArn as string
    accountPool.updateAccount(accountId, updates)
    const updated = accountPool.getAccount(accountId)
    if (updated) await storageSetAccount(updated)
    return Response.json({ success: true })
  }

  // POST /api/accounts/:id/refresh
  if (req.method === 'POST' && subPath === '/refresh') {
    const account = accountPool.getAccount(accountId)
    if (!account) return Response.json({ error: 'Account not found' }, { status: 404 })
    const success = await refreshAccountToken(account)
    const updated = accountPool.getAccount(accountId)
    return Response.json({ success, expiresAt: updated?.expiresAt, subscriptionType: updated?.subscriptionType })
  }

  // POST /api/accounts/:id/verify
  if (req.method === 'POST' && subPath === '/verify') {
    const account = accountPool.getAccount(accountId)
    if (!account) return Response.json({ error: 'Account not found' }, { status: 404 })
    try {
      const ensured = await ensureValidToken(account)
      return Response.json({ valid: !!ensured.accessToken, expiresAt: ensured.expiresAt })
    } catch (e) {
      return Response.json({ valid: false, error: (e as Error).message })
    }
  }

  // GET /api/accounts/:id/usage
  if (req.method === 'GET' && subPath === '/usage') {
    const account = accountPool.getAccount(accountId)
    if (!account) return Response.json({ error: 'Account not found' }, { status: 404 })
    return Response.json({
      id: accountId, requestCount: account.requestCount || 0,
      errorCount: account.errorCount || 0, lastUsed: account.lastUsed,
      subscriptionType: account.subscriptionType
    })
  }

  return Response.json({ error: 'Not found' }, { status: 404 })
}

// ============================================================================
// 管理 API - API Key 管理
// ============================================================================
async function handleApiKeysApi(req: Request, path: string): Promise<Response> {
  const guard = adminGuard(req)
  if (guard) return guard

  // GET /api/keys
  if (req.method === 'GET' && path === '/api/keys') {
    const keys = await storageGetAllApiKeys()
    const safeKeys = keys.map(k => ({
      id: k.id, name: k.name, key: maskToken(k.key), enabled: k.enabled,
      createdAt: k.createdAt, lastUsedAt: k.lastUsedAt,
      creditLimit: k.creditLimit, allowedModels: k.allowedModels,
      allowedAccountIds: k.allowedAccountIds,
      stats: { totalRequests: k.stats.totalRequests, totalCredits: k.stats.totalCredits }
    }))
    return Response.json({ keys: safeKeys, total: safeKeys.length })
  }

  // POST /api/keys
  if (req.method === 'POST' && path === '/api/keys') {
    let body: Record<string, unknown>
    try { body = await req.json() } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    const id = `key_${crypto.randomUUID().slice(0, 8)}`
    const key = `kg-${crypto.randomUUID().replace(/-/g, '')}`
    const apiKey: ApiKey = {
      id, key, name: (body.name as string) || 'Unnamed Key',
      enabled: true, createdAt: Date.now(),
      creditLimit: body.creditLimit as number | undefined,
      allowedAccountIds: body.allowedAccountIds as string[] | undefined,
      allowedModels: body.allowedModels as string[] | undefined,
      stats: { totalRequests: 0, successRequests: 0, failedRequests: 0, totalCredits: 0, inputTokens: 0, outputTokens: 0, daily: {}, byModel: {}, byAccount: {} }
    }
    await storageSetApiKey(apiKey)
    logger.info('Admin', `API Key created: ${id} (${apiKey.name})`)
    return Response.json({ success: true, id, key, name: apiKey.name })
  }

  // 带 ID 的路由
  const idMatch = path.match(/^\/api\/keys\/([^/]+)$/)
  if (!idMatch) return Response.json({ error: 'Not found' }, { status: 404 })
  const keyId = decodeURIComponent(idMatch[1])

  // DELETE /api/keys/:id
  if (req.method === 'DELETE') {
    await storageDeleteApiKey(keyId)
    logger.info('Admin', `API Key deleted: ${keyId}`)
    return Response.json({ success: true })
  }

  // PUT /api/keys/:id
  if (req.method === 'PUT') {
    const existing = await storageGetApiKey(keyId)
    if (!existing) return Response.json({ error: 'Key not found' }, { status: 404 })
    let body: Record<string, unknown>
    try { body = await req.json() } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (body.name !== undefined) existing.name = body.name as string
    if (body.enabled !== undefined) existing.enabled = body.enabled as boolean
    if (body.creditLimit !== undefined) existing.creditLimit = body.creditLimit as number
    if (body.allowedModels !== undefined) existing.allowedModels = body.allowedModels as string[]
    if (body.allowedAccountIds !== undefined) existing.allowedAccountIds = body.allowedAccountIds as string[]
    await storageSetApiKey(existing)
    return Response.json({ success: true })
  }

  return Response.json({ error: 'Not found' }, { status: 404 })
}

// ============================================================================
// 管理 API - 代理状态 / 统计 / 健康 / 设置 / 模型
// ============================================================================
async function handleProxyApi(req: Request, path: string): Promise<Response> {
  // GET /api/proxy/status - 无需 admin
  if (req.method === 'GET' && path === '/api/proxy/status') {
    return Response.json({
      status: 'running', version: APP_VERSION,
      uptime: Math.floor((Date.now() - metrics.startTime) / 1000),
      accounts: accountPool.getAllAccounts().length,
      circuitBreaker: circuitBreaker.canExecute() ? 'closed' : 'open'
    })
  }

  // GET /api/proxy/health - 无需 admin
  if (req.method === 'GET' && path === '/api/proxy/health') {
    const accounts = accountPool.getAllAccounts()
    const available = accounts.filter(a => a.isAvailable !== false && !a.disabled)
    return Response.json({
      healthy: available.length > 0 && circuitBreaker.canExecute(),
      accounts: { total: accounts.length, available: available.length },
      circuitBreaker: circuitBreaker.canExecute() ? 'closed' : 'open',
      endpointHealth: getEndpointHealthStats(),
      dnsCache: getDNSCacheStats(),
      compression: getCompressionStats(),
      cacheInfo: getCacheInfo()
    })
  }

  // GET /api/metrics - 无需 admin（兼容旧 dashboard）
  if (req.method === 'GET' && path === '/api/metrics') {
    return Response.json({
      ...metrics,
      uptime: Math.floor((Date.now() - metrics.startTime) / 1000),
      accounts: accountPool.getAllAccounts().length
    })
  }

  // 以下需要 admin
  const guard = adminGuard(req)
  if (guard) return guard

  // GET /api/proxy/stats
  if (req.method === 'GET' && path === '/api/proxy/stats') {
    return Response.json({
      ...metrics,
      endpointHealth: getEndpointHealthStats(),
      compression: getCompressionStats()
    })
  }

  // GET /api/proxy/logs
  if (req.method === 'GET' && path === '/api/proxy/logs') {
    return Response.json({ logs: metrics.requestLog.slice(-100).reverse() })
  }

  // PUT /api/proxy/config
  if (req.method === 'PUT' && path === '/api/proxy/config') {
    let body: Record<string, unknown>
    try { body = await req.json() } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (body.rateLimitPerMinute !== undefined) settings.rateLimitPerMinute = body.rateLimitPerMinute as number
    if (body.logLevel !== undefined) settings.logLevel = body.logLevel as string
    if (body.enableCompression !== undefined) settings.enableCompression = body.enableCompression as boolean
    // 更新压缩器配置
    if (body.compressionConfig) updateCompressorConfig(body.compressionConfig as Record<string, unknown>)
    return Response.json({ success: true, settings: { rateLimitPerMinute: settings.rateLimitPerMinute, logLevel: settings.logLevel, enableCompression: settings.enableCompression } })
  }

  return Response.json({ error: 'Not found' }, { status: 404 })
}

// GET /api/settings
async function handleSettingsApi(req: Request, path: string): Promise<Response> {
  const guard = adminGuard(req)
  if (guard) return guard

  if (req.method === 'GET' && path === '/api/settings') {
    return Response.json({
      version: APP_VERSION, port: settings.port,
      logLevel: settings.logLevel, rateLimitPerMinute: settings.rateLimitPerMinute,
      enableCompression: settings.enableCompression,
      compressionConfig: getCompressorConfig(),
      accounts: accountPool.getAllAccounts().length
    })
  }

  if (req.method === 'PUT' && path === '/api/settings') {
    let body: Record<string, unknown>
    try { body = await req.json() } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (body.adminPassword !== undefined) settings.adminPassword = body.adminPassword as string
    if (body.logLevel !== undefined) settings.logLevel = body.logLevel as string
    if (body.rateLimitPerMinute !== undefined) settings.rateLimitPerMinute = body.rateLimitPerMinute as number
    if (body.enableCompression !== undefined) settings.enableCompression = body.enableCompression as boolean
    return Response.json({ success: true })
  }

  return Response.json({ error: 'Not found' }, { status: 404 })
}

// GET /api/models - 获取可用模型列表
async function handleModelsApi(req: Request): Promise<Response> {
  const authResult = await verifyApiKey(req)
  if (!authResult.valid) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // 尝试从缓存获取模型列表
  let models = getCachedModels()
  if (!models || models.length === 0) {
    // 尝试从 Kiro API 获取
    try {
      const accounts = accountPool.getAllAccounts()
      if (accounts.length > 0) {
        const account = await ensureValidToken(accounts[0])
        models = await fetchKiroModels(account)
        if (models) updateModelCache(models)
      }
    } catch (e) {
      logger.warn('API', `Failed to fetch models: ${(e as Error).message}`)
    }
  }
  // 返回 OpenAI 兼容格式
  const modelList = models?.map(m => ({
    id: m.modelId, object: 'model', created: Math.floor(Date.now() / 1000),
    owned_by: 'anthropic', description: m.description
  })) || DEFAULT_MODELS.map(m => ({
    id: m, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'anthropic'
  }))
  return Response.json({ object: 'list', data: modelList })
}

// 默认模型列表（缓存为空时的降级）
const DEFAULT_MODELS = [
  'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4',
  'claude-haiku-4-5', 'claude-3-7-sonnet-20250219'
]

// ============================================================================
// HTTP 路由分发
// ============================================================================
function htmlResponse(html: string): Response {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method
  const startTime = Date.now()

  // CORS 预检
  if (method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
        'Access-Control-Max-Age': '86400'
      }
    })
  }

  logger.info('HTTP', `${method} ${path}`)

  let response: Response

  try {
    // ---- 静态页面 ----
    if (method === 'GET') {
      switch (path) {
        case '/': return htmlResponse(renderHomePage(APP_VERSION))
        case '/docs': return htmlResponse(renderDocsPage(APP_VERSION))
        case '/playground': return htmlResponse(renderPlaygroundPage(APP_VERSION))
        case '/deploy': return htmlResponse(renderDeployPage(APP_VERSION))
        case '/dashboard': return htmlResponse(renderDashboardPage(APP_VERSION))
        case '/swagger': return htmlResponse(renderSwaggerPage(APP_VERSION))
        case '/admin/accounts': return htmlResponse(renderAccountsPage(APP_VERSION))
        case '/admin/keys': return htmlResponse(renderApiKeysPage(APP_VERSION))
        case '/openapi.json': return Response.json(generateOpenAPISpec(APP_VERSION))
        case '/health': return Response.json({ status: 'healthy', version: APP_VERSION, timestamp: new Date().toISOString() })
      }
    }

    // ---- API 路由 ----
    // 模型列表
    if (method === 'GET' && path === '/v1/models') {
      return await handleModelsApi(req)
    }

    // OpenAI Chat Completions
    if (method === 'POST' && path === '/v1/chat/completions') {
      metrics.totalRequests++
      const r = await handleChatCompletions(req, {
        settings,
        accountPool,
        rateLimiter,
        circuitBreaker,
        verifyApiKey,
        getAccountFromRefreshToken,
        selectAccount,
        createRequestDebugID,
        detectThinkingHeader,
      })
      const duration = Date.now() - startTime
      recordRequest({ timestamp: Date.now(), method, path, status: r.status, duration, apiType: 'openai' })
      return addCorsHeaders(r)
    }

    // Anthropic Messages
    if (method === 'POST' && (path === '/v1/messages' || path === '/messages')) {
      metrics.totalRequests++
      const r = await handleAnthropicMessages(req, {
        settings,
        accountPool,
        rateLimiter,
        circuitBreaker,
        verifyApiKey,
        getAccountFromRefreshToken,
        selectAccount,
        createRequestDebugID,
        detectThinkingHeader,
      })
      const duration = Date.now() - startTime
      recordRequest({ timestamp: Date.now(), method, path, status: r.status, duration, apiType: 'anthropic' })
      return addCorsHeaders(r)
    }

    // ---- 管理 API ----
    // 账号管理
    if (path.startsWith('/api/accounts')) {
      return await handleAccountsApi(req, path)
    }

    // API Key 管理
    if (path.startsWith('/api/keys')) {
      return await handleApiKeysApi(req, path)
    }

    // 代理状态/统计/健康/日志/配置
    if (path.startsWith('/api/proxy') || path === '/api/metrics') {
      return await handleProxyApi(req, path)
    }

    // 设置
    if (path.startsWith('/api/settings')) {
      return await handleSettingsApi(req, path)
    }

    // 404
    return Response.json({ error: 'Not Found' }, { status: 404 })

  } catch (e) {
    const err = e as Error
    logger.error('HTTP', `Unhandled error: ${err.message}`)
    return Response.json({ error: err.message }, { status: 500 })
  }
}

function addCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function createRequestDebugID(prefix: 'oa' | 'cl'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

function detectThinkingHeader(req: Request): string {
  return req.headers.get('anthropic-beta') || req.headers.get('Anthropic-Beta') || ''
}

// ============================================================================
// 应用启动
// ============================================================================
async function loadAccountsFromStorage() {
  try {
    const accounts = await storageGetAllAccounts()
    for (const acc of accounts) {
      accountPool.addAccount(acc)
    }
    logger.info('Init', `Loaded ${accounts.length} accounts from storage`)
  } catch (e) {
    logger.warn('Init', `Failed to load accounts: ${(e as Error).message}`)
  }
}

async function persistState() {
  try {
    const accounts = accountPool.getAllAccounts()
    for (const acc of accounts) {
      await storageSetAccount(acc)
    }
    await saveStats({
      totalRequests: metrics.totalRequests,
      successRequests: metrics.successRequests,
      errorRequests: metrics.errorRequests,
      streamRequests: metrics.streamRequests,
      nonStreamRequests: metrics.nonStreamRequests,
      totalTokens: metrics.totalTokens,
      totalInputTokens: metrics.totalInputTokens,
      totalOutputTokens: metrics.totalOutputTokens,
      startTime: metrics.startTime
    })
    await saveRequestLogs(toPersistedRequestLogs(metrics.requestLog))
  } catch (e) {
    logger.error('Persist', `Failed: ${(e as Error).message}`)
  }
}

async function main() {
  const level = settings.logLevel.toLowerCase()
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
    setLogLevel(level)
  }
  logger.info('Init', `KiroGate v${APP_VERSION} starting...`)

  // 初始化存储
  await initStorage()

  // 加载持久化的账号
  await loadAccountsFromStorage()

  // 加载持久化的统计数据
  try {
    const stats = await loadStats() as PersistedStats | null
    if (stats) {
      metrics.totalRequests = readStatNumber(stats, 'totalRequests')
      metrics.successRequests = readStatNumber(stats, 'successRequests')
      metrics.errorRequests = readStatNumber(stats, 'errorRequests')
      metrics.streamRequests = readStatNumber(stats, 'streamRequests')
      metrics.nonStreamRequests = readStatNumber(stats, 'nonStreamRequests')
      metrics.totalTokens = readStatNumber(stats, 'totalTokens')
      metrics.totalInputTokens = readStatNumber(stats, 'totalInputTokens')
      metrics.totalOutputTokens = readStatNumber(stats, 'totalOutputTokens')
      const persistedStartTime = readStatNumber(stats, 'startTime')
      if (persistedStartTime > 0) metrics.startTime = persistedStartTime
    }
    const logs = await loadRequestLogs()
    if (logs?.length) metrics.requestLog = fromPersistedRequestLogs(logs)
  } catch { /* ignore */ }

  // DNS 预热
  try { await prewarmDNS() } catch { /* ignore */ }

  // 启动压缩器定期清理
  startPeriodicCleanup()

  // 定期持久化（每 60 秒）
  const persistInterval = setInterval(persistState, 60000)

  // 优雅关闭
  const shutdown = async () => {
    logger.info('Init', 'Shutting down...')
    clearInterval(persistInterval)
    await persistState()
    await closeStorage()
    Deno.exit(0)
  }

  try { Deno.addSignalListener('SIGINT', shutdown) } catch { /* Windows */ }
  try { Deno.addSignalListener('SIGTERM', shutdown) } catch { /* Windows */ }

  logger.info('Init', `Port: ${settings.port}`)
  logger.info('Init', `Accounts: ${accountPool.getAllAccounts().length}`)
  logger.info('Init', `Rate limit: ${settings.rateLimitPerMinute || 'disabled'}`)

  // 启动 HTTP 服务器
  Deno.serve({ port: settings.port }, handleRequest)
}

main()
