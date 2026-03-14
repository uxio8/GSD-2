import test from 'node:test'
import assert from 'node:assert/strict'

const { extractRetryAfterMs, streamAnthropic } = await import(
  new URL('../../node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js?patched', import.meta.url).href,
)

test('extractRetryAfterMs parses retry-after seconds with a small safety buffer', () => {
  const headers = new Headers({ 'retry-after': '3' })
  const delay = extractRetryAfterMs(headers)

  assert.equal(typeof delay, 'number')
  assert.ok((delay ?? 0) >= 4000)
  assert.ok((delay ?? 0) <= 5000)
})

test('extractRetryAfterMs parses anthropic reset timestamps', () => {
  const resetAt = Math.floor((Date.now() + 2000) / 1000)
  const headers = new Headers({ 'x-ratelimit-reset-requests': String(resetAt) })
  const delay = extractRetryAfterMs(headers)

  assert.equal(typeof delay, 'number')
  assert.ok((delay ?? 0) >= 2000)
  assert.ok((delay ?? 0) <= 4000)
})

test('streamAnthropic strips variant suffixes from OAuth Anthropic model ids only', async () => {
  const model = {
    id: 'claude-opus-4-6[1m]',
    name: 'Claude Opus 4.6 (1M)',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: true,
    input: ['text'],
    maxTokens: 128000,
  }
  const context = {
    messages: [{ role: 'user', content: 'hello' }],
  }

  let oauthPayload = null
  const oauthStream = streamAnthropic(model, context, {
    apiKey: 'sk-ant-oat-test',
    onPayload: async (params) => {
      oauthPayload = params
      throw new Error('stop-after-payload')
    },
  })
  for await (const _event of oauthStream) {
    break
  }

  let apiKeyPayload = null
  const apiKeyStream = streamAnthropic(model, context, {
    apiKey: 'sk-ant-api-test',
    onPayload: async (params) => {
      apiKeyPayload = params
      throw new Error('stop-after-payload')
    },
  })
  for await (const _event of apiKeyStream) {
    break
  }

  assert.equal(oauthPayload?.model, 'claude-opus-4-6')
  assert.equal(apiKeyPayload?.model, 'claude-opus-4-6[1m]')
})
