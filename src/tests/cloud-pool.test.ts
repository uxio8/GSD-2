import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildPiOpenAICodexCredential,
  createCloudPoolAuthStorage,
  prepareCloudPoolSession,
} from '../cloud-pool.ts'

function makeJwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

test('buildPiOpenAICodexCredential translates leased Codex auth into Pi OAuth shape', () => {
  const accessToken = makeJwt({
    exp: 1_777_777_777,
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-from-jwt',
    },
  })

  const credential = buildPiOpenAICodexCredential({
    tokens: {
      access_token: accessToken,
      refresh_token: 'refresh-token',
      account_id: 'acct-from-snapshot',
    },
  })

  assert.deepEqual(credential, {
    type: 'oauth',
    access: accessToken,
    refresh: 'refresh-token',
    expires: 1_777_777_777_000,
    accountId: 'acct-from-snapshot',
  })
})

test('cloud pool auth overlay keeps openai-codex session-only and persists local keys', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-cloud-pool-test-'))
  const authPath = join(tmp, 'auth.json')
  writeFileSync(
    authPath,
    JSON.stringify({
      brave: { type: 'api_key', key: 'brave-key' },
    }, null, 2),
  )

  const initialCredential = {
    type: 'oauth' as const,
    access: makeJwt({
      exp: 1_800_000_000,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' },
    }),
    refresh: 'refresh-1',
    expires: 1_800_000_000_000,
    accountId: 'acct-1',
  }

  try {
    const authStorage = createCloudPoolAuthStorage(authPath, initialCredential)

    assert.deepEqual(authStorage.get('openai-codex'), initialCredential)
    assert.deepEqual(authStorage.get('brave'), { type: 'api_key', key: 'brave-key' })

    authStorage.set('context7', { type: 'api_key', key: 'ctx-key' })

    const rotatedCredential = {
      type: 'oauth' as const,
      access: makeJwt({
        exp: 1_900_000_000,
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' },
      }),
      refresh: 'refresh-2',
      expires: 1_900_000_000_000,
      accountId: 'acct-1',
    }
    authStorage.set('openai-codex', rotatedCredential)
    authStorage.reload()

    assert.deepEqual(authStorage.get('openai-codex'), rotatedCredential)
    assert.deepEqual(authStorage.get('context7'), { type: 'api_key', key: 'ctx-key' })

    const persisted = JSON.parse(readFileSync(authPath, 'utf8'))
    assert.equal(persisted['openai-codex'], undefined)
    assert.deepEqual(persisted.brave, { type: 'api_key', key: 'brave-key' })
    assert.deepEqual(persisted.context7, { type: 'api_key', key: 'ctx-key' })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('prepareCloudPoolSession loads pool credentials from env file fallback', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-cloud-pool-envfile-'))
  const authPath = join(tmp, 'auth.json')
  const envPath = join(tmp, 'cloud-pool.env')
  writeFileSync(authPath, JSON.stringify({}, null, 2))

  const accessToken = makeJwt({
    exp: 1_950_000_000,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-env-file' },
  })
  const requests: string[] = []

  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    if (req.url === '/v1/pools/main/leases/acquire' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ leaseId: 'lease-env-file', accountId: 'acct-env-file', sessionId: 'sess-env-file' }))
      return
    }

    if (req.url === '/v1/leases/lease-env-file/auth-snapshot' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        tokens: {
          access_token: accessToken,
          refresh_token: 'refresh-env-file',
          account_id: 'acct-env-file',
        },
      }))
      return
    }

    if (req.url === '/v1/leases/lease-env-file/release' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (req.url === '/v1/leases/lease-env-file/renew' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    res.writeHead(404)
    res.end('not found')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind test server')
  }

  writeFileSync(envPath, `POOL_URL=http://127.0.0.1:${address.port}\nPOOL_SLUG=main\nPOOL_TOKEN=pool-token\n`)

  const prevEnvFile = process.env.GSD_CLOUD_POOL_ENV_FILE
  const prevUrl = process.env.GSD_CLOUD_POOL_URL
  const prevToken = process.env.GSD_CLOUD_POOL_TOKEN
  const prevSlug = process.env.GSD_CLOUD_POOL_SLUG
  delete process.env.GSD_CLOUD_POOL_URL
  delete process.env.GSD_CLOUD_POOL_TOKEN
  delete process.env.GSD_CLOUD_POOL_SLUG
  process.env.GSD_CLOUD_POOL_ENV_FILE = envPath

  try {
    const session = await prepareCloudPoolSession(process.cwd(), authPath)
    assert.equal(session.poolActive, true)
    assert.equal(session.preferredProvider, 'openai-codex')
    assert.equal(session.authStorage.get('openai-codex')?.type, 'oauth')
    await session.cleanup()

    assert.ok(requests.includes('POST /v1/pools/main/leases/acquire'))
    assert.ok(requests.includes('GET /v1/leases/lease-env-file/auth-snapshot'))
    assert.ok(requests.includes('POST /v1/leases/lease-env-file/release'))
  } finally {
    if (prevEnvFile) process.env.GSD_CLOUD_POOL_ENV_FILE = prevEnvFile
    else delete process.env.GSD_CLOUD_POOL_ENV_FILE
    if (prevUrl) process.env.GSD_CLOUD_POOL_URL = prevUrl
    else delete process.env.GSD_CLOUD_POOL_URL
    if (prevToken) process.env.GSD_CLOUD_POOL_TOKEN = prevToken
    else delete process.env.GSD_CLOUD_POOL_TOKEN
    if (prevSlug) process.env.GSD_CLOUD_POOL_SLUG = prevSlug
    else delete process.env.GSD_CLOUD_POOL_SLUG
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    rmSync(tmp, { recursive: true, force: true })
  }
})
