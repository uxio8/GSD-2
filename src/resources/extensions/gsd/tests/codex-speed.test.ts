import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  applyCodexReasoningEffort,
  applyCodexFastMode,
  mapTaskComplexityToCodexReasoningEffort,
  normalizeCodexSpeed,
  resolveActiveCodexTaskComplexity,
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

test('mapTaskComplexityToCodexReasoningEffort maps monitor complexity onto codex effort', () => {
  assert.equal(
    mapTaskComplexityToCodexReasoningEffort(
      'simple',
      { provider: 'openai-codex', id: 'gpt-5.4' },
    ),
    'medium',
  )
  assert.equal(
    mapTaskComplexityToCodexReasoningEffort(
      'media',
      { provider: 'openai-codex', id: 'gpt-5.4' },
    ),
    'high',
  )
  assert.equal(
    mapTaskComplexityToCodexReasoningEffort(
      'alta',
      { provider: 'openai-codex', id: 'gpt-5.4' },
    ),
    'xhigh',
  )
  assert.equal(
    mapTaskComplexityToCodexReasoningEffort(
      'alta',
      { provider: 'openai-codex', id: 'gpt-5.1' },
    ),
    'high',
  )
})

test('applyCodexReasoningEffort injects reasoning effort while preserving existing reasoning metadata', () => {
  const payload = {
    model: 'gpt-5.4',
    input: [],
    text: { verbosity: 'medium' },
    tool_choice: 'auto' as const,
    parallel_tool_calls: true as const,
    reasoning: { summary: 'auto' as const },
  }

  assert.deepEqual(
    applyCodexReasoningEffort(
      payload,
      { provider: 'openai-codex', id: 'gpt-5.4' },
      'alta',
    ),
    {
      ...payload,
      reasoning: {
        summary: 'auto',
        effort: 'xhigh',
      },
    },
  )

  assert.deepEqual(
    applyCodexReasoningEffort(
      {
        ...payload,
        reasoning: { effort: 'medium', summary: 'auto' as const },
      },
      { provider: 'openai-codex', id: 'gpt-5.4' },
      'alta',
    ),
    {
      ...payload,
      reasoning: { effort: 'medium', summary: 'auto' },
    },
  )
})

test('resolveActiveCodexTaskComplexity reads the active task classification from disk', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-codex-reasoning-'))
  const gsd = join(tmp, '.gsd')
  const milestoneDir = join(gsd, 'milestones', 'M001')
  const sliceDir = join(milestoneDir, 'slices', 'S01')
  const tasksDir = join(sliceDir, 'tasks')

  mkdirSync(tasksDir, { recursive: true })
  writeFileSync(join(gsd, 'REQUIREMENTS.md'), '# Requirements\n')
  writeFileSync(
    join(milestoneDir, 'M001-ROADMAP.md'),
    `# M001: Runtime hardening

## Slices
- [ ] **S01: Hosted session authority** \`risk:high\` \`depends:[]\`
> After this: session authority is hardened.
`,
  )
  writeFileSync(
    join(sliceDir, 'S01-PLAN.md'),
    `# S01: Hosted session authority

## Goal
Harden session authority.

## Demo
Published flows stay coherent.

## Tasks
- [ ] **T01: Browser runtime proof**
`,
  )
  writeFileSync(
    join(tasksDir, 'T01-PLAN.md'),
    `---
estimated_steps: 9
estimated_files: 10
---

# T01: Browser runtime proof

## Steps
- Wire the browser route proof.

## Must-Haves
- Prove the published route.

## Verification
- Run the browser proof.

## Observability Impact
- Add route diagnostics for cross-host session authority.
`,
  )

  try {
    assert.equal(await resolveActiveCodexTaskComplexity(tmp), 'alta')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
