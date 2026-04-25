import {
  assert,
  assertEquals,
} from 'https://deno.land/std/assert/mod.ts'

type Json = Record<string, unknown>

type CredentialBundle = {
  accessToken: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region: string
  machineId?: string
}

type HttpResult = {
  status: number
  headers: Headers
  bytes: Uint8Array
  text: string
  json: unknown
}

type ScenarioObservation = {
  name: string
  status: number
  contentType: string | null
  snippet: string
}

type DecodedEvent = {
  eventType: string
  payload: Json
}

const HOME = Deno.env.get('HOME') || ''
const KV_PATH = '/Users/wangchang/KiroGate/kirogate.kv'
const SQLITE_PATH = `${HOME}/Library/Application Support/kiro-cli/data.sqlite3`
const DEFAULT_REGION = 'us-east-1'
const DEFAULT_MACHINE_ID = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function codewhispererUrl(region = DEFAULT_REGION): string {
  return `https://codewhisperer.${region}.amazonaws.com/generateAssistantResponse`
}

function qUrl(region = DEFAULT_REGION): string {
  return `https://q.${region}.amazonaws.com/ListAvailableModels?origin=AI_EDITOR&maxResults=3`
}

function qGenerateUrl(region = DEFAULT_REGION): string {
  return `https://q.${region}.amazonaws.com/generateAssistantResponse`
}

function baseHeaders(creds: CredentialBundle, includeTarget = true): Headers {
  const machineId = creds.machineId || DEFAULT_MACHINE_ID
  const headers = new Headers({
    Authorization: `Bearer ${creds.accessToken}`,
    'Content-Type': 'application/json',
    Accept: '*/*',
    'User-Agent': `aws-sdk-js/1.0.27 ua/2.1 os/windows lang/js md/nodejs#20.16.0 api/codewhispererstreaming#1.0.27 m/E KiroIDE-0.9.40-${machineId}`,
    'x-amz-user-agent': `aws-sdk-js/1.0.27 KiroIDE 0.9.40 ${machineId}`,
    'x-amzn-kiro-agent-mode': 'vibe',
    'x-amzn-codewhisperer-optout': 'true',
    'Amz-Sdk-Request': 'attempt=1; max=3',
    'Amz-Sdk-Invocation-Id': crypto.randomUUID(),
  })
  if (includeTarget) {
    headers.set('X-Amz-Target', 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse')
  }
  return headers
}

function cliHeaders(creds: CredentialBundle): Headers {
  return new Headers({
    Authorization: `Bearer ${creds.accessToken}`,
    'Content-Type': 'application/json',
    Accept: '*/*',
    'User-Agent': 'aws-sdk-rust/1.3.9 os/macos lang/rust/1.87.0',
    'x-amz-user-agent': 'aws-sdk-rust/1.3.9 ua/2.1 api/ssooidc/1.88.0 os/macos lang/rust/1.87.0 m/E app/AmazonQ-For-CLI',
    'x-amzn-kiro-agent-mode': 'spec',
    'x-amzn-codewhisperer-optout': 'true',
    'Amz-Sdk-Request': 'attempt=1; max=3',
    'Amz-Sdk-Invocation-Id': crypto.randomUUID(),
    'X-Amz-Target': 'AmazonQDeveloperStreamingService.SendMessage',
  })
}

async function readSqliteJson(key: string): Promise<Json | null> {
  const cmd = new Deno.Command('sqlite3', {
    args: [SQLITE_PATH, `SELECT value FROM auth_kv WHERE key = '${key}';`],
    stdout: 'piped',
    stderr: 'piped',
  })
  const { code, stdout, stderr } = await cmd.output()
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr))
  const text = new TextDecoder().decode(stdout).trim()
  if (!text) return null
  return JSON.parse(text)
}

async function readStoredAccount(): Promise<CredentialBundle | null> {
  const kv = await Deno.openKv(KV_PATH)
  try {
    for await (const entry of kv.list<CredentialBundle>({ prefix: ['accounts'] })) {
      if (entry.value?.accessToken) {
        return {
          accessToken: entry.value.accessToken,
          refreshToken: entry.value.refreshToken,
          clientId: entry.value.clientId,
          clientSecret: entry.value.clientSecret,
          region: entry.value.region || DEFAULT_REGION,
          machineId: entry.value.machineId,
        }
      }
    }
  } finally {
    kv.close()
  }
  return null
}

async function loadCredentials(): Promise<CredentialBundle> {
  const stored = await readStoredAccount()
  const tokenJson = await readSqliteJson('kirocli:odic:token')
  const deviceJson = await readSqliteJson('kirocli:odic:device-registration')

  if (stored) {
    return stored
  }

  if (!tokenJson || !deviceJson) {
    throw new Error('Kiro credentials not found in kv or sqlite')
  }

  return {
    accessToken: String(tokenJson.access_token || ''),
    refreshToken: String(tokenJson.refresh_token || ''),
    clientId: String(deviceJson.client_id || ''),
    clientSecret: String(deviceJson.client_secret || ''),
    region: String(tokenJson.region || DEFAULT_REGION),
  }
}

async function refreshAccessToken(creds: CredentialBundle): Promise<CredentialBundle> {
  if (!creds.refreshToken || !creds.clientId || !creds.clientSecret) return creds
  const response = await fetch('https://oidc.us-east-1.amazonaws.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refreshToken: creds.refreshToken,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      grantType: 'refresh_token',
    }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status} ${text}`)
  const json = JSON.parse(text)
  return {
    ...creds,
    accessToken: String(json.accessToken),
    refreshToken: String(json.refreshToken || creds.refreshToken),
  }
}

async function fetchJsonLike(url: string, init: RequestInit): Promise<HttpResult> {
  const response = await fetch(url, init)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const text = new TextDecoder().decode(bytes)
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: response.status, headers: response.headers, bytes, text, json }
}

function minimalConversation(content: string): Json {
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: `test-${crypto.randomUUID()}`,
      currentMessage: {
        userInputMessage: {
          content,
          modelId: 'claude-sonnet-4.5',
          origin: 'AI_EDITOR',
        },
      },
      agentContinuationId: crypto.randomUUID(),
      agentTaskType: 'vibe',
    },
  }
}

function minimalToolDefinition(name = 'get_weather'): Json {
  return {
    toolSpecification: {
      name,
      description: `Tool: ${name}`,
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            city: { type: 'string' },
          },
          required: ['city'],
        },
      },
    },
  }
}

function observe(name: string, result: HttpResult): ScenarioObservation {
  return {
    name,
    status: result.status,
    contentType: result.headers.get('content-type'),
    snippet: result.text.slice(0, 500),
  }
}

function decodeEventType(headers: Uint8Array): string {
  let offset = 0
  while (offset < headers.length) {
    const nameLen = headers[offset]
    offset += 1
    const name = new TextDecoder().decode(headers.slice(offset, offset + nameLen))
    offset += nameLen
    const valueType = headers[offset]
    offset += 1
    if (valueType === 7) {
      const valueLen = (headers[offset] << 8) | headers[offset + 1]
      offset += 2
      const value = new TextDecoder().decode(headers.slice(offset, offset + valueLen))
      offset += valueLen
      if (name === ':event-type') return value
      continue
    }
    const skipSizes: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }
    if (valueType === 6) {
      const len = (headers[offset] << 8) | headers[offset + 1]
      offset += 2 + len
    } else {
      offset += skipSizes[valueType] ?? 0
    }
  }
  return ''
}

function decodeEventStream(bytes: Uint8Array): DecodedEvent[] {
  const events: DecodedEvent[] = []
  let offset = 0
  while (offset + 16 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset)
    const totalLength = view.getUint32(0, false)
    const headersLength = view.getUint32(4, false)
    if (totalLength < 16 || offset + totalLength > bytes.length) break
    const headers = bytes.slice(offset + 12, offset + 12 + headersLength)
    const payloadBytes = bytes.slice(offset + 12 + headersLength, offset + totalLength - 4)
    const payloadText = new TextDecoder().decode(payloadBytes)
    try {
      events.push({
        eventType: decodeEventType(headers),
        payload: JSON.parse(payloadText),
      })
    } catch {
      // ignore undecodable frames for now
    }
    offset += totalLength
  }
  return events
}

function extractAssistantText(result: HttpResult): string {
  const events = decodeEventStream(result.bytes)
  return events
    .filter((event) => event.eventType === 'assistantResponseEvent')
    .map((event) => String(event.payload.content || ''))
    .join('')
}

async function ensureAccepted(result: HttpResult, scenario: string): Promise<void> {
  if (result.status !== 200) {
    throw new Error(`${scenario} expected 200, got ${result.status}: ${result.text.slice(0, 500)}`)
  }
}

Deno.test('setup: ListAvailableModels works with refreshed token', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const result = await fetchJsonLike(qUrl(creds.region), {
    method: 'GET',
    headers: new Headers({
      Authorization: `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'aws-sdk-js/1.0.27 ua/2.1 os/windows lang/js md/nodejs#20.16.0 api/codewhispererstreaming#1.0.27 m/E KiroIDE-0.9.40-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'x-amz-user-agent': 'aws-sdk-js/1.0.27 KiroIDE 0.9.40 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'x-amzn-codewhisperer-optout': 'true',
    }),
  })

  await ensureAccepted(result, 'ListAvailableModels')
  assert(Array.isArray((result.json as Json).models))
})

Deno.test('minimal conversation with valid model is accepted by Kiro API', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const result = await fetchJsonLike(codewhispererUrl(creds.region), {
    method: 'POST',
    headers: baseHeaders(creds),
    body: JSON.stringify(minimalConversation('Hello from testapi. Reply briefly.')),
  })

  await ensureAccepted(result, 'minimal conversation')
  assert(result.text.length > 0)
})

Deno.test('empty current message content is rejected or handled explicitly', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('')
  const result = await fetchJsonLike(codewhispererUrl(creds.region), {
    method: 'POST',
    headers: baseHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('empty-current-content', JSON.stringify(observe('empty-current-content', result)))
  assert(result.status === 200 || result.status === 400)
  if (result.status === 200) {
    const text = extractAssistantText(result)
    assert(text.length > 0)
    console.log('empty-current-content-text', text.slice(0, 200))
  }
})

Deno.test('assistant-first history behavior is observable', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('Continue.')
  ;(payload.conversationState as Json).history = [
    { assistantResponseMessage: { content: 'I understand.' } },
  ]
  const result = await fetchJsonLike(codewhispererUrl(creds.region), {
    method: 'POST',
    headers: baseHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('assistant-first-history', JSON.stringify(observe('assistant-first-history', result)))
  assert(result.status === 200 || result.status === 400)
  if (result.status === 200) {
    const text = extractAssistantText(result)
    assert(text.length > 0)
    console.log('assistant-first-history-text', text.slice(0, 200))
  }
})

Deno.test('assistant toolUses with single-space content is observable', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('Continue.')
  ;(payload.conversationState as Json).history = [
    {
      userInputMessage: {
        content: 'Look up Beijing weather.',
        modelId: 'claude-sonnet-4.5',
        origin: 'AI_EDITOR',
      },
    },
    {
      assistantResponseMessage: {
        content: ' ',
        toolUses: [
          {
            toolUseId: 'toolu_space_1',
            name: 'get_weather',
            input: { city: 'Beijing' },
          },
        ],
      },
    },
  ]
  const result = await fetchJsonLike(codewhispererUrl(creds.region), {
    method: 'POST',
    headers: baseHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('assistant-tooluses-space-content', JSON.stringify(observe('assistant-tooluses-space-content', result)))
  assert(result.status === 200 || result.status === 400)
})

Deno.test('matched history toolUses plus following toolResults is observable', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('Continue.')
  ;(payload.conversationState as Json).history = [
    {
      userInputMessage: {
        content: 'Look up Beijing weather.',
        modelId: 'claude-sonnet-4.5',
        origin: 'AI_EDITOR',
      },
    },
    {
      assistantResponseMessage: {
        content: ' ',
        toolUses: [
          {
            toolUseId: 'toolu_matched_1',
            name: 'get_weather',
            input: { city: 'Beijing' },
          },
        ],
      },
    },
    {
      userInputMessage: {
        content: 'Tool results provided.',
        modelId: 'claude-sonnet-4.5',
        origin: 'AI_EDITOR',
        userInputMessageContext: {
          toolResults: [
            {
              toolUseId: 'toolu_matched_1',
              content: [{ text: 'Sunny, 25C' }],
              status: 'success',
            },
          ],
        },
      },
    },
  ]
  const result = await fetchJsonLike(codewhispererUrl(creds.region), {
    method: 'POST',
    headers: baseHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('matched-tool-loop-history', JSON.stringify(observe('matched-tool-loop-history', result)))
  assert(result.status === 200 || result.status === 400)
})

Deno.test('currentMessage toolResults with matching history toolUse is observable', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('Tool results provided.')
  ;(payload.conversationState as Json).history = [
    {
      userInputMessage: {
        content: 'Look up Beijing weather.',
        modelId: 'claude-sonnet-4.5',
        origin: 'AI_EDITOR',
      },
    },
    {
      assistantResponseMessage: {
        content: ' ',
        toolUses: [
          {
            toolUseId: 'toolu_current_match_1',
            name: 'get_weather',
            input: { city: 'Beijing' },
          },
        ],
      },
    },
  ]
  ;((payload.conversationState as Json).currentMessage as Json).userInputMessage = {
    content: 'Tool results provided.',
    modelId: 'claude-sonnet-4.5',
    origin: 'AI_EDITOR',
    userInputMessageContext: {
      toolResults: [
        {
          toolUseId: 'toolu_current_match_1',
          content: [{ text: 'Sunny, 25C' }],
          status: 'success',
        },
      ],
    },
  }
  const result = await fetchJsonLike(codewhispererUrl(creds.region), {
    method: 'POST',
    headers: baseHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('current-tool-results-with-match', JSON.stringify(observe('current-tool-results-with-match', result)))
  assert(result.status === 200 || result.status === 400)
})

Deno.test('history toolResults without matching toolUses is observable', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('Continue.')
  ;(payload.conversationState as Json).history = [
    {
      userInputMessage: {
        content: 'Tool results provided.',
        modelId: 'claude-sonnet-4.5',
        origin: 'AI_EDITOR',
        userInputMessageContext: {
          toolResults: [
            {
              toolUseId: 'toolu_orphan_1',
              content: [{ text: 'orphan result' }],
              status: 'success',
            },
          ],
        },
      },
    },
  ]
  const result = await fetchJsonLike(codewhispererUrl(creds.region), {
    method: 'POST',
    headers: baseHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('orphan-tool-results', JSON.stringify(observe('orphan-tool-results', result)))
  assert(result.status === 200 || result.status === 400)
})

Deno.test('assistant toolUses with empty content is observable', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('Continue.')
  ;(payload.conversationState as Json).history = [
    {
      userInputMessage: {
        content: 'Look up Beijing weather.',
        modelId: 'claude-sonnet-4.5',
        origin: 'AI_EDITOR',
      },
    },
    {
      assistantResponseMessage: {
        content: '',
        toolUses: [
          {
            toolUseId: 'toolu_1',
            name: 'get_weather',
            input: { city: 'Beijing' },
          },
        ],
      },
    },
  ]
  const result = await fetchJsonLike(codewhispererUrl(creds.region), {
    method: 'POST',
    headers: baseHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('assistant-tooluses-empty-content', JSON.stringify(observe('assistant-tooluses-empty-content', result)))
  assert(result.status === 200 || result.status === 400)
})

Deno.test('assistant toolUses with empty content and declared current tools is observable', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('Continue.')
  ;(payload.conversationState as Json).history = [
    {
      userInputMessage: {
        content: 'Look up Beijing weather.',
        modelId: 'claude-sonnet-4.5',
        origin: 'AI_EDITOR',
      },
    },
    {
      assistantResponseMessage: {
        content: '',
        toolUses: [
          {
            toolUseId: 'toolu_empty_declared_1',
            name: 'get_weather',
            input: { city: 'Beijing' },
          },
        ],
      },
    },
  ]
  ;((payload.conversationState as Json).currentMessage as Json).userInputMessage = {
    content: 'Continue.',
    modelId: 'claude-sonnet-4.5',
    origin: 'AI_EDITOR',
    userInputMessageContext: {
      tools: [minimalToolDefinition('get_weather')],
    },
  }
  const result = await fetchJsonLike(codewhispererUrl(creds.region), {
    method: 'POST',
    headers: baseHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('assistant-tooluses-empty-content-with-tools', JSON.stringify(observe('assistant-tooluses-empty-content-with-tools', result)))
  assert(result.status === 200 || result.status === 400)
})

Deno.test('assistant toolUses with single-space content and declared current tools is observable', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('Continue.')
  ;(payload.conversationState as Json).history = [
    {
      userInputMessage: {
        content: 'Look up Beijing weather.',
        modelId: 'claude-sonnet-4.5',
        origin: 'AI_EDITOR',
      },
    },
    {
      assistantResponseMessage: {
        content: ' ',
        toolUses: [
          {
            toolUseId: 'toolu_space_declared_1',
            name: 'get_weather',
            input: { city: 'Beijing' },
          },
        ],
      },
    },
  ]
  ;((payload.conversationState as Json).currentMessage as Json).userInputMessage = {
    content: 'Continue.',
    modelId: 'claude-sonnet-4.5',
    origin: 'AI_EDITOR',
    userInputMessageContext: {
      tools: [minimalToolDefinition('get_weather')],
    },
  }
  const result = await fetchJsonLike(codewhispererUrl(creds.region), {
    method: 'POST',
    headers: baseHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('assistant-tooluses-space-content-with-tools', JSON.stringify(observe('assistant-tooluses-space-content-with-tools', result)))
  assert(result.status === 200 || result.status === 400)
})

Deno.test('matched history tool loop with declared current tools is observable', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('Continue.')
  ;(payload.conversationState as Json).history = [
    {
      userInputMessage: {
        content: 'Look up Beijing weather.',
        modelId: 'claude-sonnet-4.5',
        origin: 'AI_EDITOR',
      },
    },
    {
      assistantResponseMessage: {
        content: '',
        toolUses: [
          {
            toolUseId: 'toolu_matched_declared_1',
            name: 'get_weather',
            input: { city: 'Beijing' },
          },
        ],
      },
    },
    {
      userInputMessage: {
        content: '',
        modelId: 'claude-sonnet-4.5',
        origin: 'AI_EDITOR',
        userInputMessageContext: {
          toolResults: [
            {
              toolUseId: 'toolu_matched_declared_1',
              content: [{ text: 'Sunny, 25C' }],
              status: 'success',
            },
          ],
        },
      },
    },
  ]
  ;((payload.conversationState as Json).currentMessage as Json).userInputMessage = {
    content: 'Continue.',
    modelId: 'claude-sonnet-4.5',
    origin: 'AI_EDITOR',
    userInputMessageContext: {
      tools: [minimalToolDefinition('get_weather')],
    },
  }
  const result = await fetchJsonLike(codewhispererUrl(creds.region), {
    method: 'POST',
    headers: baseHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('matched-tool-loop-history-with-tools', JSON.stringify(observe('matched-tool-loop-history-with-tools', result)))
  assert(result.status === 200 || result.status === 400)
})

Deno.test('matched history tool loop without current tools is observable', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('Continue.')
  ;(payload.conversationState as Json).history = [
    {
      userInputMessage: {
        content: 'Look up Beijing weather.',
        modelId: 'claude-sonnet-4.5',
        origin: 'AI_EDITOR',
      },
    },
    {
      assistantResponseMessage: {
        content: '',
        toolUses: [
          {
            toolUseId: 'toolu_no_current_tools_1',
            name: 'get_weather',
            input: { city: 'Beijing' },
          },
        ],
      },
    },
    {
      userInputMessage: {
        content: '',
        modelId: 'claude-sonnet-4.5',
        origin: 'AI_EDITOR',
        userInputMessageContext: {
          toolResults: [
            {
              toolUseId: 'toolu_no_current_tools_1',
              content: [{ text: 'Sunny, 25C' }],
              status: 'success',
            },
          ],
        },
      },
    },
  ]
  const result = await fetchJsonLike(codewhispererUrl(creds.region), {
    method: 'POST',
    headers: baseHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('matched-tool-loop-history-no-current-tools', JSON.stringify(observe('matched-tool-loop-history-no-current-tools', result)))
  assert(result.status === 200 || result.status === 400)
})

Deno.test('matched history tool loop with mismatched current tool name is observable', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('Continue.')
  ;(payload.conversationState as Json).history = [
    {
      userInputMessage: {
        content: 'Look up Beijing weather.',
        modelId: 'claude-sonnet-4.5',
        origin: 'AI_EDITOR',
      },
    },
    {
      assistantResponseMessage: {
        content: '',
        toolUses: [
          {
            toolUseId: 'toolu_name_mismatch_1',
            name: 'get_weather',
            input: { city: 'Beijing' },
          },
        ],
      },
    },
    {
      userInputMessage: {
        content: '',
        modelId: 'claude-sonnet-4.5',
        origin: 'AI_EDITOR',
        userInputMessageContext: {
          toolResults: [
            {
              toolUseId: 'toolu_name_mismatch_1',
              content: [{ text: 'Sunny, 25C' }],
              status: 'success',
            },
          ],
        },
      },
    },
  ]
  ;((payload.conversationState as Json).currentMessage as Json).userInputMessage = {
    content: 'Continue.',
    modelId: 'claude-sonnet-4.5',
    origin: 'AI_EDITOR',
    userInputMessageContext: {
      tools: [minimalToolDefinition('weather_lookup')],
    },
  }
  const result = await fetchJsonLike(codewhispererUrl(creds.region), {
    method: 'POST',
    headers: baseHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('matched-tool-loop-history-mismatched-current-tool', JSON.stringify(observe('matched-tool-loop-history-mismatched-current-tool', result)))
  assert(result.status === 200 || result.status === 400)
})

Deno.test('matched history tool loop with empty tool result text is observable', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('Continue.')
  ;(payload.conversationState as Json).history = [
    {
      userInputMessage: {
        content: 'Look up Beijing weather.',
        modelId: 'claude-sonnet-4.5',
        origin: 'AI_EDITOR',
      },
    },
    {
      assistantResponseMessage: {
        content: '',
        toolUses: [
          {
            toolUseId: 'toolu_empty_result_text_1',
            name: 'get_weather',
            input: { city: 'Beijing' },
          },
        ],
      },
    },
    {
      userInputMessage: {
        content: '',
        modelId: 'claude-sonnet-4.5',
        origin: 'AI_EDITOR',
        userInputMessageContext: {
          toolResults: [
            {
              toolUseId: 'toolu_empty_result_text_1',
              content: [{ text: '' }],
              status: 'success',
            },
          ],
        },
      },
    },
  ]
  ;((payload.conversationState as Json).currentMessage as Json).userInputMessage = {
    content: 'Continue.',
    modelId: 'claude-sonnet-4.5',
    origin: 'AI_EDITOR',
    userInputMessageContext: {
      tools: [minimalToolDefinition('get_weather')],
    },
  }
  const result = await fetchJsonLike(codewhispererUrl(creds.region), {
    method: 'POST',
    headers: baseHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('matched-tool-loop-history-empty-result-text', JSON.stringify(observe('matched-tool-loop-history-empty-result-text', result)))
  assert(result.status === 200 || result.status === 400)
})

Deno.test('currentMessage toolResults with no history tool call is observable', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('Tool results provided.')
  ;((payload.conversationState as Json).currentMessage as Json).userInputMessage = {
    content: 'Tool results provided.',
    modelId: 'claude-sonnet-4.5',
    origin: 'AI_EDITOR',
    userInputMessageContext: {
      toolResults: [
        {
          toolUseId: 'toolu_lonely_1',
          content: [{ text: 'lonely result' }],
          status: 'success',
        },
      ],
    },
  }
  const result = await fetchJsonLike(codewhispererUrl(creds.region), {
    method: 'POST',
    headers: baseHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('current-tool-results-no-history', JSON.stringify(observe('current-tool-results-no-history', result)))
  assert(result.status === 200 || result.status === 400)
})

Deno.test('CLI lane: minimal conversation with q endpoint is accepted', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('Hello from Amazon Q CLI lane.')
  ;((payload.conversationState as Json).currentMessage as Json).userInputMessage = {
    content: 'Hello from Amazon Q CLI lane.',
    modelId: 'claude-sonnet-4.5',
    origin: 'CLI',
  }
  const result = await fetchJsonLike(qGenerateUrl(creds.region), {
    method: 'POST',
    headers: cliHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('cli-minimal-q-endpoint', JSON.stringify(observe('cli-minimal-q-endpoint', result)))
  assert(result.status === 200 || result.status === 403)
})

Deno.test('CLI lane: empty current content behavior is observable', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('')
  ;((payload.conversationState as Json).currentMessage as Json).userInputMessage = {
    content: '',
    modelId: 'claude-sonnet-4.5',
    origin: 'CLI',
  }
  const result = await fetchJsonLike(qGenerateUrl(creds.region), {
    method: 'POST',
    headers: cliHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('cli-empty-current', JSON.stringify(observe('cli-empty-current', result)))
  assert(result.status === 200 || result.status === 400 || result.status === 403)
})

Deno.test('CLI lane: assistant-first history behavior is observable', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('Continue.')
  ;(payload.conversationState as Json).history = [
    { assistantResponseMessage: { content: 'understood' } },
  ]
  ;((payload.conversationState as Json).currentMessage as Json).userInputMessage = {
    content: 'Continue.',
    modelId: 'claude-sonnet-4.5',
    origin: 'CLI',
  }
  const result = await fetchJsonLike(qGenerateUrl(creds.region), {
    method: 'POST',
    headers: cliHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('cli-assistant-first-history', JSON.stringify(observe('cli-assistant-first-history', result)))
  assert(result.status === 200 || result.status === 400 || result.status === 403)
})

Deno.test('CLI lane: matched tool loop history is observable', async () => {
  const creds = await refreshAccessToken(await loadCredentials())
  const payload = minimalConversation('Continue.')
  ;(payload.conversationState as Json).history = [
    {
      userInputMessage: {
        content: 'Look up Beijing weather.',
        modelId: 'claude-sonnet-4.5',
        origin: 'CLI',
      },
    },
    {
      assistantResponseMessage: {
        content: ' ',
        toolUses: [
          {
            toolUseId: 'toolu_cli_1',
            name: 'get_weather',
            input: { city: 'Beijing' },
          },
        ],
      },
    },
    {
      userInputMessage: {
        content: 'Tool results provided.',
        modelId: 'claude-sonnet-4.5',
        origin: 'CLI',
        userInputMessageContext: {
          toolResults: [
            {
              toolUseId: 'toolu_cli_1',
              content: [{ text: 'Sunny, 25C' }],
              status: 'success',
            },
          ],
        },
      },
    },
  ]
  ;((payload.conversationState as Json).currentMessage as Json).userInputMessage = {
    content: 'Continue.',
    modelId: 'claude-sonnet-4.5',
    origin: 'CLI',
  }
  const result = await fetchJsonLike(qGenerateUrl(creds.region), {
    method: 'POST',
    headers: cliHeaders(creds),
    body: JSON.stringify(payload),
  })

  console.log('cli-matched-tool-loop', JSON.stringify(observe('cli-matched-tool-loop', result)))
  assert(result.status === 200 || result.status === 400 || result.status === 403)
})
