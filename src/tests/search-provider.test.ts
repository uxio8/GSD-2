import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { setSearchProviderPreference } from '../resources/extensions/search-the-web/provider.ts'

test('setSearchProviderPreference replaces the stored preference instead of accumulating it', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-search-provider-'))
  const authPath = join(tmp, 'auth.json')

  try {
    setSearchProviderPreference('tavily', authPath)
    setSearchProviderPreference('brave', authPath)

    const stored = JSON.parse(readFileSync(authPath, 'utf-8')) as Record<string, unknown>
    assert.deepEqual(stored.search_provider, { type: 'api_key', key: 'brave' })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
