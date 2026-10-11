import { test } from 'node:test'
import assert from 'node:assert/strict'

test('scaffold: plugin identity and inert apply', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'dsh-self-improve')
  assert.equal(typeof mod.apply, 'function')
  await assert.doesNotReject(() => mod.apply({}, { improveLoop: 'off' }))
})
