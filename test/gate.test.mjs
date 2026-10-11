// Gate-guard tests: the default-off byte-for-byte house rule (zero listeners,
// zero filesystem touches), the invalid-value fail-open direction, and the
// volatile hot-flip semantics.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'
import { normalizeImproveLoop, snapshotConfig } from '../lib/config.js'

function fakeHost() {
  const listeners = new Map()
  return {
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
    },
    dispatch(event, ...args) {
      for (const l of listeners.get(event) ?? []) l(...args)
    },
    listenerCount: (event) => (listeners.get(event)?.length ?? 0),
  }
}

test('OFF GUARD: default apply registers zero listeners', async () => {
  const host = fakeHost()
  const probes = { peer: 0, root: 0 }
  await apply(host, {}, {
    openPeer: async () => { probes.peer++; return undefined },
    bundleRoot: () => { probes.root++; return '/nonexistent-dsh-self-improve-probe' },
    now: () => '2026-10-11T00:00:00.000Z',
  })
  assert.equal(host.listenerCount('session/event'), 0)
  assert.equal(host.listenerCount('agent/disposed'), 0)
  assert.equal(host.listenerCount('session/disposed'), 0)
  assert.equal(probes.peer + probes.root, 0, 'off touches neither the peer seam nor the bundle root')
})

test('OFF GUARD: explicit off registers zero listeners', async () => {
  const host = fakeHost()
  await apply(host, { improveLoop: 'off' })
  assert.equal(host.listenerCount('session/event'), 0)
})

test('OFF GUARD: an invalid gate value degrades to off (never widens the loop)', async () => {
  const host = fakeHost()
  await apply(host, { improveLoop: 'ON ' })
  assert.equal(host.listenerCount('session/event'), 0)
  const host2 = fakeHost()
  await apply(host2, { improveLoop: 'murder-hobo' })
  assert.equal(host2.listenerCount('session/event'), 0)
})

test('OFF GUARD: volatile ref holding off registers zero listeners', async () => {
  const host = fakeHost()
  await apply(host, { improveLoop: { get: () => 'off' } })
  assert.equal(host.listenerCount('session/event'), 0)
})

test('OFF GUARD: jev keys alone arm nothing (N4 wiring lands later)', async () => {
  const host = fakeHost()
  await apply(host, { improveLoop: 'off', improveJevBackend: 'zen', improveJevModel: 'jev-1.13-free' })
  assert.equal(host.listenerCount('session/event'), 0)
})

test('shadow and on arm the firehose listener', async () => {
  const shadowHost = fakeHost()
  await apply(shadowHost, { improveLoop: 'shadow', improveJevBackend: { get: () => '' }, improveJevModel: { get: () => '' } }, { openPeer: async () => undefined, bundleRoot: () => '/nonexistent-dsh-self-improve-probe', now: () => '2026-10-11T00:00:00.000Z' })
  assert.equal(shadowHost.listenerCount('session/event'), 1)
  const onHost = fakeHost()
  await apply(onHost, { improveLoop: 'on' }, { openPeer: async () => undefined, bundleRoot: () => '/nonexistent-dsh-self-improve-probe', now: () => '2026-10-11T00:00:00.000Z' })
  assert.equal(onHost.listenerCount('session/event'), 1)
})

test('config snapshot: plain values and live refs fold to defaults for absent keys', () => {
  assert.deepEqual(snapshotConfig(undefined), { improveLoop: 'off', improveJevBackend: '', improveJevModel: '' })
  assert.deepEqual(snapshotConfig({ improveLoop: 'shadow' }), { improveLoop: 'shadow', improveJevBackend: '', improveJevModel: '' })
  assert.deepEqual(
    snapshotConfig({ improveLoop: { get: () => 'on' }, improveJevBackend: { get: () => 'zen' } }),
    { improveLoop: 'on', improveJevBackend: 'zen', improveJevModel: '' },
  )
})

test('normalizeImproveLoop: three states only', () => {
  assert.equal(normalizeImproveLoop('off'), 'off')
  assert.equal(normalizeImproveLoop('shadow'), 'shadow')
  assert.equal(normalizeImproveLoop('on'), 'on')
  assert.equal(normalizeImproveLoop('ON'), 'off')
  assert.equal(normalizeImproveLoop(true), 'off')
  assert.equal(normalizeImproveLoop(undefined), 'off')
})
