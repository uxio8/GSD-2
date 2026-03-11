import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  applyCodexFastMode,
  normalizeCodexSpeed,
  resolveCodexSpeed,
  shouldUseCodexFastMode,
} from '../codex-speed.ts'

test('normalizeCodexSpeed accepts fast and standard aliases', () => {
  assert.equal(normalizeCodexSpeed('fast'), 'fast')
  assert.equal(normalizeCodexSpeed('standard'), 'standard')
  assert.equal(normalizeCodexSpeed('default'), 'standard')
  assert.equal(normalizeCodexSpeed('auto'), 'standard')
  assert.equal(normalizeCodexSpeed('priority'), undefined)
})

test('resolveCodexSpeed prefers env over project over global settings', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-codex-speed-'))
  const globalSettingsPath = join(tmp, 'global-settings.json')
  const projectSettingsPath = join(tmp, 'project-settings.json')

  writeFileSync(globalSettingsPath, JSON.stringify({ service_tier: 'standard' }, null, 2))
  writeFileSync(projectSettingsPath, JSON.stringify({ service_tier: 'fast' }, null, 2))

  try {
    assert.equal(
      resolveCodexSpeed(
        tmp,
        {},
        { globalSettingsPath, projectSettingsPath },
      ),
      'fast',
    )

    assert.equal(
      resolveCodexSpeed(
        tmp,
        { GSD_CODEX_SPEED: 'standard' },
        { globalSettingsPath, projectSettingsPath },
      ),
      'standard',
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('shouldUseCodexFastMode only enables fast for oauth-backed openai-codex gpt-5.4', () => {
  assert.equal(
    shouldUseCodexFastMode(
      { provider: 'openai-codex', id: 'gpt-5.4' },
      true,
      'fast',
    ),
    true,
  )

  assert.equal(
    shouldUseCodexFastMode(
      { provider: 'openai-codex', id: 'gpt-5.4' },
      false,
      'fast',
    ),
    false,
  )

  assert.equal(
    shouldUseCodexFastMode(
      { provider: 'openai-codex', id: 'gpt-5.3-codex' },
      true,
      'fast',
    ),
    false,
  )
})

test('applyCodexFastMode injects service_tier fast only for Codex responses payloads', () => {
  const payload = {
    model: 'gpt-5.4',
    input: [],
    text: { verbosity: 'medium' },
    tool_choice: 'auto' as const,
    parallel_tool_calls: true as const,
  }

  assert.deepEqual(
    applyCodexFastMode(
      payload,
      { provider: 'openai-codex', id: 'gpt-5.4' },
      true,
      'fast',
    ),
    {
      ...payload,
      service_tier: 'fast',
    },
  )

  assert.deepEqual(
    applyCodexFastMode(
      payload,
      { provider: 'openai-codex', id: 'gpt-5.4' },
      true,
      'standard',
    ),
    payload,
  )

  assert.deepEqual(
    applyCodexFastMode(
      { model: 'gpt-5.4', input: [] },
      { provider: 'openai-codex', id: 'gpt-5.4' },
      true,
      'fast',
    ),
    { model: 'gpt-5.4', input: [] },
  )
})
