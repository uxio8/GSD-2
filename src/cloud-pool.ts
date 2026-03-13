import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import { AuthStorage, FileAuthStorageBackend } from '@mariozechner/pi-coding-agent'
import { appRoot } from './app-paths.js'

type LockResult<T> = {
  result: T
  next?: string
}

type JsonRecord = Record<string, unknown>

type OpenAICodexCredential = {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  accountId: string
}

interface PoolConfig {
  apiUrl: string
  apiKey: string
  poolId: string
  leaseTtlSec: number
  consumerId: string
  clientInstanceId: string
  consumerType: 'remote_runner' | 'paperclip_client'
  pinnedSessionId?: string
  excludedSessionIds: string[]
}

interface PoolAcquireResponse {
  leaseId: string
  accountId: string | null
  sessionId: string | null
}

type PoolCompleteOutcome =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'usage_limited'
  | 'auth_invalid'

type UsageLimitSignal = {
  message: string
  retryAt: Date | null
}

export interface PreparedCloudPoolSession {
  authStorage: AuthStorage
  poolActive: boolean
  preferredProvider: string | null
  rotateOnUsageLimit: (message: string) => Promise<boolean>
  cleanup: () => Promise<void>
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeUrlBase(value: string): string {
  return value.replace(/\/+$/, '')
}

function readPositiveInt(value: string, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseListEnv(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,\n]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  )
}

function cloudPoolError(message: string): Error {
  return new Error(`GSD cloud pool: ${message}`)
}

function parseRetryDelay(message: string, unit: 'second' | 'minute' | 'hour' | 'day'): number | null {
  const aliases: Record<typeof unit, string> = {
    second: 'seconds?|secs?|s',
    minute: 'minutes?|mins?|m',
    hour: 'hours?|hrs?|h',
    day: 'days?|d',
  }
  const match = message.match(new RegExp(`try again in\\s*~?(\\d+)\\s*(?:${aliases[unit]})\\b`, 'i'))
  if (!match) return null
  const amount = Number(match[1])
  return Number.isFinite(amount) && amount > 0 ? amount : null
}

function parseRetryClock(message: string, now: Date): Date | null {
  const match = message.match(/try again at\s+(\d{1,2}):(\d{2})(?:\s*([ap]m))?/i)
  if (!match) return null

  let hour = Number(match[1])
  const minute = Number(match[2])
  const suffix = match[3]?.toLowerCase()
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) return null

  if (suffix === 'pm' && hour < 12) hour += 12
  if (suffix === 'am' && hour === 12) hour = 0
  if (!suffix && hour > 23) return null

  const retryAt = new Date(now)
  retryAt.setSeconds(0, 0)
  retryAt.setHours(hour, minute, 0, 0)
  if (retryAt.getTime() <= now.getTime()) {
    retryAt.setDate(retryAt.getDate() + 1)
  }
  return retryAt
}

export function parseUsageLimitSignal(message: string, now = new Date()): UsageLimitSignal | null {
  const trimmed = trimString(message)
  if (!trimmed) return null

  const normalized = trimmed.toLowerCase()
  const looksLikeUsageLimit =
    normalized.includes('chatgpt usage limit') ||
    normalized.includes('hit your usage limit') ||
    normalized.includes("you've hit your usage limit")

  if (!looksLikeUsageLimit) return null

  const minutes = parseRetryDelay(trimmed, 'minute')
  const hours = minutes == null ? parseRetryDelay(trimmed, 'hour') : null
  const days = minutes == null && hours == null ? parseRetryDelay(trimmed, 'day') : null
  const seconds =
    minutes == null && hours == null && days == null ? parseRetryDelay(trimmed, 'second') : null

  let retryAt: Date | null = null
  if (minutes != null) retryAt = new Date(now.getTime() + minutes * 60_000)
  else if (hours != null) retryAt = new Date(now.getTime() + hours * 60 * 60_000)
  else if (days != null) retryAt = new Date(now.getTime() + days * 24 * 60 * 60_000)
  else if (seconds != null) retryAt = new Date(now.getTime() + seconds * 1_000)
  else retryAt = parseRetryClock(trimmed, now)

  return {
    message: trimmed,
    retryAt,
  }
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseEnvFile(filePath: string): Record<string, string> {
  const values: Record<string, string> = {}
  const content = readFileSync(filePath, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line
    const eqIndex = normalized.indexOf('=')
    if (eqIndex <= 0) continue
    const key = normalized.slice(0, eqIndex).trim()
    const value = unquoteEnvValue(normalized.slice(eqIndex + 1))
    if (key) values[key] = value
  }
  return values
}

function findDefaultPoolEnvFile(cwd: string): string | null {
  const explicit = trimString(process.env.GSD_CLOUD_POOL_ENV_FILE || process.env.POOL_ENV_FILE)
  if (explicit) {
    const resolvedExplicit = resolve(explicit)
    if (existsSync(resolvedExplicit)) return resolvedExplicit
  }

  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const candidates = [
    join(appRoot, 'cloud-pool.env'),
    resolve(cwd, '..', 'codex-pool-cloud', '.secrets', 'friend_pool_use.env'),
    resolve(packageRoot, '..', 'codex-pool-cloud', '.secrets', 'friend_pool_use.env'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return null
}

function readPoolConfig(cwd: string): PoolConfig | null {
  const envFilePath = findDefaultPoolEnvFile(cwd)
  const fileVars = envFilePath ? parseEnvFile(envFilePath) : {}

  const apiUrl = trimString(process.env.GSD_CLOUD_POOL_URL || process.env.POOL_URL || fileVars.POOL_URL)
  const apiKey = trimString(
    process.env.GSD_CLOUD_POOL_TOKEN || process.env.POOL_TOKEN || fileVars.POOL_TOKEN,
  )
  const poolId = trimString(
    process.env.GSD_CLOUD_POOL_SLUG || process.env.POOL_SLUG || fileVars.POOL_SLUG,
  )

  if (!apiUrl && !apiKey && !poolId) return null

  if (!apiUrl || !apiKey || !poolId) {
    throw cloudPoolError(
      'incomplete configuration. Set GSD_CLOUD_POOL_URL, GSD_CLOUD_POOL_TOKEN, and GSD_CLOUD_POOL_SLUG (or POOL_URL, POOL_TOKEN, and POOL_SLUG).',
    )
  }

  const consumerTypeRaw = trimString(
    process.env.GSD_CLOUD_POOL_CONSUMER_TYPE || process.env.POOL_CONSUMER_TYPE,
  )
  const consumerType =
    consumerTypeRaw === 'paperclip_client' ? 'paperclip_client' : 'remote_runner'
  const leaseTtlSec = readPositiveInt(
    trimString(process.env.GSD_CLOUD_POOL_LEASE_TTL_SEC || process.env.POOL_LEASE_TTL_SEC),
    300,
  )

  return {
    apiUrl: normalizeUrlBase(apiUrl),
    apiKey,
    poolId,
    leaseTtlSec,
    consumerType,
    consumerId:
      trimString(process.env.GSD_CLOUD_POOL_CONSUMER_ID || process.env.POOL_CONSUMER_ID) ||
      `gsd:${basename(cwd)}:${process.pid}`,
    clientInstanceId:
      trimString(process.env.GSD_CLOUD_POOL_CLIENT_INSTANCE_ID || process.env.POOL_CLIENT_INSTANCE_ID) ||
      `gsd-${hostname()}-${process.pid}`,
    pinnedSessionId: trimString(
      process.env.GSD_CLOUD_POOL_PINNED_SESSION_ID || process.env.POOL_PINNED_SESSION_ID,
    ) || undefined,
    excludedSessionIds: parseListEnv(
      trimString(
        process.env.GSD_CLOUD_POOL_EXCLUDED_SESSION_IDS || process.env.POOL_EXCLUDED_SESSION_IDS,
      ),
    ),
  }
}

async function poolRequest(
  config: PoolConfig,
  input: {
    path: string
    method?: 'GET' | 'POST'
    body?: unknown
    parseAs?: 'json' | 'text'
    timeoutMs?: number
  },
): Promise<{ body: unknown; headers: Headers }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(2_000, input.timeoutMs ?? 10_000))

  try {
    const response = await fetch(
      new URL(input.path.replace(/^\//, ''), `${config.apiUrl}/`),
      {
        method: input.method ?? (input.body == null ? 'GET' : 'POST'),
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          ...(input.body == null ? {} : { 'Content-Type': 'application/json' }),
        },
        body: input.body == null ? null : JSON.stringify(input.body),
        signal: controller.signal,
      },
    )

    const parseAsText =
      input.parseAs === 'text' ||
      !(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')
    const body = parseAsText ? await response.text() : await response.json().catch(() => null)

    if (!response.ok) {
      const message =
        typeof body === 'string'
          ? body.trim()
          : trimString((body as JsonRecord | null)?.error) ||
            trimString((body as JsonRecord | null)?.message) ||
            `request failed with status ${response.status}`
      throw cloudPoolError(message)
    }

    return { body, headers: response.headers }
  } finally {
    clearTimeout(timer)
  }
}

function decodeJwtPayload(token: string): JsonRecord {
  const parts = token.split('.')
  if (parts.length < 2) {
    throw cloudPoolError('invalid OpenAI Codex access token in leased auth snapshot')
  }

  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8')
    const parsed = JSON.parse(payload)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('payload is not an object')
    }
    return parsed as JsonRecord
  } catch (error) {
    throw cloudPoolError(
      `failed to decode OpenAI Codex access token payload: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function extractExpiryMs(accessToken: string): number {
  const payload = decodeJwtPayload(accessToken)
  const exp = payload.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw cloudPoolError('leased OpenAI Codex access token is missing exp')
  }
  return exp * 1_000
}

function extractAccountId(accessToken: string): string {
  const payload = decodeJwtPayload(accessToken)
  const auth = payload['https://api.openai.com/auth']
  if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
    const value = trimString((auth as JsonRecord).chatgpt_account_id)
    if (value) return value
  }
  return ''
}

function parseJsonRecord(raw: string | undefined): JsonRecord {
  if (!raw?.trim()) return {}
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected a JSON object')
  }
  return parsed as JsonRecord
}

export function buildPiOpenAICodexCredential(raw: unknown): OpenAICodexCredential {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw cloudPoolError('leased auth snapshot is not a JSON object')
  }

  const record = raw as JsonRecord
  const tokens =
    record.tokens && typeof record.tokens === 'object' && !Array.isArray(record.tokens)
      ? (record.tokens as JsonRecord)
      : null

  const access = trimString(tokens?.access_token)
  const refresh = trimString(tokens?.refresh_token)
  const accountId = trimString(tokens?.account_id) || extractAccountId(access)
  const expires = access ? extractExpiryMs(access) : 0

  if (!access || !refresh || !accountId || !expires) {
    throw cloudPoolError(
      'leased auth snapshot is missing tokens.access_token, tokens.refresh_token, tokens.account_id, or a valid token expiry',
    )
  }

  return {
    type: 'oauth',
    access,
    refresh,
    expires,
    accountId,
  }
}

export class OverlayAuthStorageBackend {
  private readonly fileBackend: FileAuthStorageBackend
  private readonly provider: string
  private overlayCredential: JsonRecord

  constructor(authPath: string, provider: string, overlayCredential: JsonRecord) {
    this.fileBackend = new FileAuthStorageBackend(authPath)
    this.provider = provider
    this.overlayCredential = { ...overlayCredential }
  }

  private injectOverlay(current: string | undefined): string {
    const data = parseJsonRecord(current)
    data[this.provider] = { ...this.overlayCredential }
    return JSON.stringify(data, null, 2)
  }

  private stripOverlay(next: string): string {
    const data = parseJsonRecord(next)
    const providerValue = data[this.provider]
    if (providerValue && typeof providerValue === 'object' && !Array.isArray(providerValue)) {
      this.overlayCredential = { ...(providerValue as JsonRecord) }
    }
    delete data[this.provider]
    return JSON.stringify(data, null, 2)
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    return this.fileBackend.withLock((current) => {
      const { result, next } = fn(this.injectOverlay(current))
      return next === undefined ? { result } : { result, next: this.stripOverlay(next) }
    })
  }

  withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    return this.fileBackend.withLockAsync(async (current) => {
      const { result, next } = await fn(this.injectOverlay(current))
      return next === undefined ? { result } : { result, next: this.stripOverlay(next) }
    })
  }
}

export function createCloudPoolAuthStorage(
  authPath: string,
  credential: OpenAICodexCredential,
): AuthStorage {
  return AuthStorage.fromStorage(
    new OverlayAuthStorageBackend(authPath, 'openai-codex', credential),
  )
}

function parseAcquireResponse(raw: unknown): PoolAcquireResponse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw cloudPoolError('invalid acquire response from pool')
  }

  const record = raw as JsonRecord
  const leaseId = trimString(record.leaseId)
  if (!leaseId) throw cloudPoolError('pool acquire response is missing leaseId')

  return {
    leaseId,
    accountId: trimString(record.accountId) || null,
    sessionId: trimString(record.sessionId) || null,
  }
}

async function releaseLease(config: PoolConfig, leaseId: string, reason: string): Promise<void> {
  await poolRequest(config, {
    path: `/v1/leases/${encodeURIComponent(leaseId)}/release`,
    method: 'POST',
    body: { reason },
  })
}

async function completeLease(
  config: PoolConfig,
  leaseId: string,
  input: {
    outcome: PoolCompleteOutcome
    message?: string
    usageLimitRetryAt?: Date | null
  },
): Promise<void> {
  await poolRequest(config, {
    path: `/v1/leases/${encodeURIComponent(leaseId)}/complete`,
    method: 'POST',
    body: {
      outcome: input.outcome,
      ...(input.message ? { message: input.message } : {}),
      ...(input.usageLimitRetryAt ? { usageLimitRetryAt: input.usageLimitRetryAt } : {}),
    },
  })
}

export async function prepareCloudPoolSession(
  cwd: string,
  authPath: string,
): Promise<PreparedCloudPoolSession> {
  const config = readPoolConfig(cwd)
  if (!config) {
    return {
      authStorage: AuthStorage.create(authPath),
      poolActive: false,
      preferredProvider: null,
      rotateOnUsageLimit: async () => false,
      cleanup: async () => {},
    }
  }

  const buildAcquireBody = (): JsonRecord => {
    const acquireBody: JsonRecord = {
      clientInstanceId: config.clientInstanceId,
      consumerType: config.consumerType,
      consumerId: config.consumerId,
      leaseTtlSec: config.leaseTtlSec,
    }
    if (config.pinnedSessionId) acquireBody.pinnedSessionId = config.pinnedSessionId
    if (config.excludedSessionIds.length > 0) {
      acquireBody.excludedSessionIds = config.excludedSessionIds
    }
    return acquireBody
  }

  const acquireLease = async (): Promise<PoolAcquireResponse> =>
    parseAcquireResponse(
      (
        await poolRequest(config, {
          path: `/v1/pools/${encodeURIComponent(config.poolId)}/leases/acquire`,
          method: 'POST',
          body: buildAcquireBody(),
        })
      ).body,
    )

  const readLeaseCredential = async (leaseId: string): Promise<OpenAICodexCredential> => {
    const snapshotResponse = await poolRequest(config, {
      path: `/v1/leases/${encodeURIComponent(leaseId)}/auth-snapshot`,
      parseAs: 'text',
    })
    const snapshotText =
      typeof snapshotResponse.body === 'string'
        ? snapshotResponse.body
        : JSON.stringify(snapshotResponse.body)
    return buildPiOpenAICodexCredential(JSON.parse(snapshotText))
  }

  let currentLease: PoolAcquireResponse | null = await acquireLease()
  let initialCredential: OpenAICodexCredential
  try {
    initialCredential = await readLeaseCredential(currentLease.leaseId)
  } catch (error) {
    await releaseLease(config, currentLease.leaseId, 'gsd_auth_snapshot_failed').catch(() => {})
    throw error
  }

  const authStorage = createCloudPoolAuthStorage(authPath, initialCredential)
  let renewTimer: NodeJS.Timeout | null = null
  let cleanedUp = false
  let rotationPromise: Promise<boolean> | null = null

  const stopRenewTimer = () => {
    if (renewTimer) {
      clearInterval(renewTimer)
      renewTimer = null
    }
  }

  const startRenewTimer = () => {
    stopRenewTimer()
    renewTimer = setInterval(() => {
      const leaseId = currentLease?.leaseId
      if (!leaseId) return
      void poolRequest(config, {
        path: `/v1/leases/${encodeURIComponent(leaseId)}/renew`,
        method: 'POST',
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[gsd] Cloud pool renew failed: ${message}\n`)
      })
    }, Math.max(1_000, Math.floor((config.leaseTtlSec * 1_000) / 3)))
  }

  const rotateOnUsageLimit = async (message: string): Promise<boolean> => {
    const signal = parseUsageLimitSignal(message)
    if (!signal || cleanedUp) return false
    if (rotationPromise) return rotationPromise

    rotationPromise = (async () => {
      const exhaustedLease = currentLease
      if (!exhaustedLease) return false

      stopRenewTimer()
      try {
        await completeLease(config, exhaustedLease.leaseId, {
          outcome: 'usage_limited',
          message: signal.message,
          usageLimitRetryAt: signal.retryAt,
        })
      } catch (error) {
        currentLease = exhaustedLease
        startRenewTimer()
        throw error
      }

      currentLease = null
      if (exhaustedLease.sessionId) {
        config.excludedSessionIds = Array.from(
          new Set([...config.excludedSessionIds, exhaustedLease.sessionId]),
        )
      }

      const nextLease = await acquireLease()
      const nextCredential = await readLeaseCredential(nextLease.leaseId)
      currentLease = nextLease
      authStorage.set('openai-codex', nextCredential)
      startRenewTimer()
      return true
    })().finally(() => {
      rotationPromise = null
    })

    return rotationPromise
  }

  const cleanup = async () => {
    if (cleanedUp) return
    cleanedUp = true
    await rotationPromise?.catch(() => {})
    stopRenewTimer()
    const leaseId = currentLease?.leaseId
    currentLease = null
    if (leaseId) {
      await releaseLease(config, leaseId, 'gsd_exit').catch(() => {})
    }
  }

  startRenewTimer()
  return {
    authStorage,
    poolActive: true,
    preferredProvider: 'openai-codex',
    rotateOnUsageLimit,
    cleanup,
  }
}
