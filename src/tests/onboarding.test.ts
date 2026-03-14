import test from 'node:test'
import assert from 'node:assert/strict'

import { AuthStorage } from '@mariozechner/pi-coding-agent'
import {
  getConfiguredLlmProviderId,
  getConfiguredSearchLabel,
  shouldRunOnboarding,
} from '../onboarding.ts'

test('shouldRunOnboarding only returns true when no LLM auth exists on a TTY', () => {
  const auth = AuthStorage.inMemory()
  const originalTTY = process.stdin.isTTY

  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: true,
  })

  try {
    assert.equal(shouldRunOnboarding(auth), true)
    auth.set('anthropic', { type: 'api_key', key: 'sk-ant-test' })
    assert.equal(shouldRunOnboarding(auth), false)
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: originalTTY,
    })
  }
})

test('getConfiguredLlmProviderId returns the first known configured provider', () => {
  const auth = AuthStorage.inMemory({
    tavily: { type: 'api_key', key: 'tavily-key' },
    openai: { type: 'api_key', key: 'sk-test' },
  })

  assert.equal(getConfiguredLlmProviderId(auth), 'openai')
})

test('getConfiguredSearchLabel understands anthropic built-in and explicit providers', () => {
  const auth = AuthStorage.inMemory()

  assert.equal(getConfiguredSearchLabel(auth, 'anthropic'), 'Anthropic built-in')

  auth.set('brave', { type: 'api_key', key: 'brave-key' })
  assert.equal(getConfiguredSearchLabel(auth, 'openai'), 'Brave')

  auth.remove('brave')
  auth.set('tavily', { type: 'api_key', key: 'tavily-key' })
  assert.equal(getConfiguredSearchLabel(auth, 'openai'), 'Tavily')
})
