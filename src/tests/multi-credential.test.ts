import test from 'node:test'
import assert from 'node:assert/strict'

import { AuthStorage } from '@mariozechner/pi-coding-agent'

test('AuthStorage appends distinct API keys and deduplicates duplicates', () => {
  const auth = AuthStorage.inMemory()

  auth.set('anthropic', { type: 'api_key', key: 'key-1' })
  auth.set('anthropic', { type: 'api_key', key: 'key-2' })
  auth.set('anthropic', { type: 'api_key', key: 'key-1' })

  const creds = auth.getCredentialsForProvider('anthropic')
  assert.deepEqual(
    creds.map((cred) => cred.type === 'api_key' ? cred.key : cred.type),
    ['key-1', 'key-2'],
  )
})

test('AuthStorage round-robins API keys without sessionId', async () => {
  const auth = AuthStorage.inMemory({
    anthropic: [
      { type: 'api_key', key: 'key-1' },
      { type: 'api_key', key: 'key-2' },
    ],
  })

  assert.equal(await auth.getApiKey('anthropic'), 'key-1')
  assert.equal(await auth.getApiKey('anthropic'), 'key-2')
  assert.equal(await auth.getApiKey('anthropic'), 'key-1')
})

test('AuthStorage uses sticky selection when sessionId is provided', async () => {
  const auth = AuthStorage.inMemory({
    anthropic: [
      { type: 'api_key', key: 'key-1' },
      { type: 'api_key', key: 'key-2' },
    ],
  })

  const first = await auth.getApiKey('anthropic', 'session-a')
  const second = await auth.getApiKey('anthropic', 'session-a')
  const third = await auth.getApiKey('anthropic', 'session-b')

  assert.equal(first, second)
  assert.ok(['key-1', 'key-2'].includes(third ?? ''))
})

test('markUsageLimitReached backs off the current credential and rotates to an alternate one', async () => {
  const auth = AuthStorage.inMemory({
    anthropic: [
      { type: 'api_key', key: 'key-1' },
      { type: 'api_key', key: 'key-2' },
    ],
  })

  assert.equal(await auth.getApiKey('anthropic'), 'key-1')
  assert.equal(auth.markUsageLimitReached('anthropic', undefined, { errorType: 'rate_limit' }), true)
  assert.equal(await auth.getApiKey('anthropic'), 'key-2')
})

test('markUsageLimitReached does not back off the only credential for transport errors', async () => {
  const auth = AuthStorage.inMemory({
    anthropic: [
      { type: 'api_key', key: 'key-1' },
    ],
  })

  assert.equal(auth.markUsageLimitReached('anthropic', undefined, { errorType: 'unknown' }), false)
  assert.equal(await auth.getApiKey('anthropic'), 'key-1')
})

test('OAuth credentials replace previous OAuth entries without multiplying them', () => {
  const auth = AuthStorage.inMemory()

  auth.set('openai-codex', { type: 'api_key', key: 'backup-key' })
  auth.set('openai-codex', {
    type: 'oauth',
    access: 'access-1',
    refresh: 'refresh-1',
    expires: Date.now() + 60_000,
    accountId: 'acct-1',
  } as any)
  auth.set('openai-codex', {
    type: 'oauth',
    access: 'access-2',
    refresh: 'refresh-2',
    expires: Date.now() + 120_000,
    accountId: 'acct-2',
  } as any)

  const creds = auth.getCredentialsForProvider('openai-codex')
  assert.equal(creds.length, 2)
  assert.deepEqual(creds[0], { type: 'api_key', key: 'backup-key' })
  assert.equal(creds[1].type, 'oauth')
  assert.equal((creds[1] as any).access, 'access-2')
})

test('setting an empty API key removes the provider entry', () => {
  const auth = AuthStorage.inMemory()

  auth.set('tavily', { type: 'api_key', key: 'test-key' })
  auth.set('tavily', { type: 'api_key', key: '' })

  assert.equal(auth.has('tavily'), false)
})
