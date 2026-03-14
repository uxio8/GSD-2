import test from 'node:test'
import assert from 'node:assert/strict'

const { formatKeyForDisplay } = await import(
  new URL(
    '../../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/components/keybinding-hints.js?patched',
    import.meta.url,
  ).href,
)

test('formatKeyForDisplay uses platform-appropriate alt notation', () => {
  const displayed = formatKeyForDisplay('ctrl+alt+g')
  const expected = process.platform === 'darwin' ? 'ctrl+⌥g' : 'ctrl+alt+g'

  assert.equal(displayed, expected)
})
