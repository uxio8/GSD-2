import test from 'node:test'
import assert from 'node:assert/strict'

const { extractRetryAfterMs } = await import(
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
