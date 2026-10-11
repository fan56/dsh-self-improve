// Loop-wiring integration tests: shadow vs on feed difference (real
// topics-memory peer over a scratch bundle root), peer-absent degradation,
// action-ledger discipline, and the end-to-end red-line ⑤ probe.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { ActionLedger, LEDGER_MAX_BYTES } from '../lib/ledger.js'
import { resolveImproveBundleRoot, openPeerHandle } from '../lib/feed.js'

const NOW = () => '2026-10-11T00:00:00.000Z'

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

function scratchHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-self-improve-test-'))
}

const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : [])

async function waitFor(fn, ms = 2000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return fn()
}

test('resolveImproveBundleRoot follows the env ladder', () => {
  const home = scratchHome()
  try {
    process.env.DSH_TOPICS_HOME = join(home, 'explicit')
    assert.equal(resolveImproveBundleRoot(), join(home, 'explicit'))
    delete process.env.DSH_TOPICS_HOME
    process.env.DSH_HOME = home
    assert.equal(resolveImproveBundleRoot(), join(home, 'topics'))
    // Legacy migration: llmwiki present, topics absent → renamed.
    mkdirSync(join(home, 'llmwiki'), { recursive: true })
    rmSync(join(home, 'topics'), { recursive: true, force: true })
    assert.equal(resolveImproveBundleRoot(), join(home, 'topics'))
    assert.ok(existsSync(join(home, 'topics')), 'legacy bundle migrated')
  } finally {
    delete process.env.DSH_TOPICS_HOME
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('SHADOW: signals ledger only, never fed', async () => {
  const home = scratchHome()
  try {
    process.env.DSH_TOPICS_HOME = home
    const host = fakeHost()
    let peerAsked = false
    await apply(
      host,
      { improveLoop: 'shadow' },
      { openPeer: async () => { peerAsked = true; return undefined }, bundleRoot: () => home, now: NOW },
    )
    host.dispatch('session/event', { id: 's-shadow' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'E_SHADOW' } } } })
    // The flush path is synchronous for ledger lines.
    const actions = lines(join(home, 'meta', 'improve-actions.jsonl'))
    const signals = actions.filter((e) => e.kind === 'signal')
    assert.equal(signals.length, 1)
    assert.equal(signals[0].gate, 'shadow')
    assert.equal(signals[0].type, 'turn-end-negative')
    assert.deepEqual(signals[0].detail, { reason: 'error', turn: 1, errorCode: 'E_SHADOW' })
    assert.equal(signals[0].sessionId, 's-shadow')
    assert.ok(!existsSync(join(home, 'meta', 'observations.jsonl')), 'shadow never writes observations')
    await waitFor(() => peerAsked)
    assert.equal(actions.filter((e) => e.kind === 'feed').length, 0, 'no feed lines in shadow')
  } finally {
    delete process.env.DSH_TOPICS_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('ON: feeds the real peer AND ledgers the accepted/rejected outcome', async () => {
  const home = scratchHome()
  try {
    process.env.DSH_TOPICS_HOME = home
    const host = fakeHost()
    await apply(host, { improveLoop: 'on' }, { openPeer: openPeerHandle, bundleRoot: () => home, now: NOW })
    // Two negative signals in one turn → ONE batch → ONE feed line.
    host.dispatch('session/event', { id: 's-on' }, { type: 'tool/call', data: { callId: 'c1', name: 'bash' } })
    host.dispatch('session/event', { id: 's-on' }, { type: 'tool/result', data: { turn: 1, message: { toolCallId: 'c1', isError: true }, error: { name: 'ToolError', code: 'E1' } } })
    host.dispatch('session/event', { id: 's-on' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } })
    const observationsFile = join(home, 'meta', 'observations.jsonl')
    const fed = await waitFor(() => lines(observationsFile).filter((o) => o.source === 'fed').length >= 2)
    assert.ok(fed, 'observations reached the peer bundle')
    const obs = lines(observationsFile).filter((o) => o.source === 'fed')
    assert.ok(obs.every((o) => o.kind === 'signal'), 'fed observations carry kind signal')
    assert.ok(obs.every((o) => o.by === 'dsh-self-improve'), 'provenance actor stamped')
    const actions = lines(join(home, 'meta', 'improve-actions.jsonl'))
    const feeds = actions.filter((e) => e.kind === 'feed')
    assert.equal(feeds.length, 1, 'one feed line per turn batch (per-turn cadence)')
    assert.equal(feeds[0].gate, 'on')
    assert.equal(feeds[0].count, 2)
    assert.equal(feeds[0].accepted, 2)
    assert.equal(feeds[0].duplicates + feeds[0].rejected, 0)
    assert.equal(actions.filter((e) => e.kind === 'signal').length, 2, 'signals ledgered alongside the feed')
    // Repeat the identical batch: the peer dedups, the outcome lands.
    host.dispatch('session/event', { id: 's-on' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'max-tokens' } } })
    await waitFor(() => lines(join(home, 'meta', 'improve-actions.jsonl')).filter((e) => e.kind === 'feed').length >= 2)
    const feeds2 = lines(join(home, 'meta', 'improve-actions.jsonl')).filter((e) => e.kind === 'feed')
    assert.equal(feeds2[1].accepted + feeds2[1].duplicates + feeds2[1].rejected, feeds2[1].count, 'outcome accounting adds up')
  } finally {
    delete process.env.DSH_TOPICS_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('PEER ABSENT (on): collection continues, feed skipped, degradation ledgered once', async () => {
  const home = scratchHome()
  try {
    const host = fakeHost()
    await apply(host, { improveLoop: 'on' }, { openPeer: async () => undefined, bundleRoot: () => home, now: NOW })
    host.dispatch('session/event', { id: 's-degraded' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    host.dispatch('session/event', { id: 's-degraded' }, { type: 'user/message', data: { source: { kind: 'user' } } })
    host.dispatch('session/event', { id: 's-degraded' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    const actionsFile = join(home, 'meta', 'improve-actions.jsonl')
    const settled = await waitFor(() => lines(actionsFile).filter((e) => e.kind === 'feed-degraded').length >= 2)
    assert.ok(settled, 'both lanes recorded their degradation')
    const actions = lines(actionsFile)
    const degraded = actions.filter((e) => e.kind === 'feed-degraded')
    assert.equal(degraded.length, 2, 'one degradation per lane (feed lane + periodic lane), throttled')
    assert.ok(degraded.every((e) => e.reason === 'topics-memory-unavailable'))
    const signals = actions.filter((e) => e.kind === 'signal')
    assert.ok(signals.some((e) => e.type === 'turn-end-negative'), 'collection continues without the peer')
    assert.ok(signals.some((e) => e.type === 'interruption-pair'), 'pair signal collected without the peer')
    assert.ok(!existsSync(join(home, 'meta', 'observations.jsonl')), 'no bundle writes without the peer')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('unused-injection periodic signal: fires once per session from the peer aggregate', async () => {
  const home = scratchHome()
  try {
    const host = fakeHost()
    const usage = new Map([['ghost-topic', { hits: 4, opens: 0 }]])
    await apply(
      host,
      { improveLoop: 'shadow' },
      {
        openPeer: async () => ({ feed: async () => ({ accepted: 0, duplicates: 0, rejected: 0, ids: [] }), usageSignals: () => usage }),
        bundleRoot: () => home,
        now: NOW,
      },
    )
    host.dispatch('session/event', { id: 's-periodic' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    host.dispatch('session/event', { id: 's-periodic' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    const actionsFile = join(home, 'meta', 'improve-actions.jsonl')
    const settled = await waitFor(() => lines(actionsFile).some((e) => e.kind === 'signal' && e.type === 'unused-injection'))
    assert.ok(settled, 'periodic snapshot landed')
    const actions = lines(actionsFile)
    const unused = actions.filter((e) => e.kind === 'signal' && e.type === 'unused-injection')
    assert.equal(unused.length, 1, 'periodic check throttled to once per session')
    assert.equal(unused[0].detail.slug, 'ghost-topic')
    assert.equal(unused[0].sessionId, undefined, 'aggregate snapshot has no session dimension')
    assert.ok(!existsSync(join(home, 'meta', 'observations.jsonl')), 'shadow never feeds')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('HOT FLIP: shadow→on lands on the next batch; flip to off goes inert', async () => {
  const home = scratchHome()
  try {
    let gate = 'shadow'
    const host = fakeHost()
    const fedFromPeer = []
    await apply(
      host,
      { improveLoop: { get: () => gate } },
      {
        openPeer: async () => ({ feed: async (obs) => { fedFromPeer.push(obs.length); return { accepted: obs.length, duplicates: 0, rejected: 0, ids: [] } }, usageSignals: () => new Map() }),
        bundleRoot: () => home,
        now: NOW,
      },
    )
    const negative = { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'E_FLIP' } } } }
    host.dispatch('session/event', { id: 's-flip' }, negative)
    assert.equal(fedFromPeer.length, 0, 'shadow feeds nothing')
    gate = 'on'
    host.dispatch('session/event', { id: 's-flip' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'max-tokens' } } })
    await waitFor(() => fedFromPeer.length >= 1)
    assert.ok(fedFromPeer.length >= 1, 'on feeds after the hot flip')
    gate = 'off'
    host.dispatch('session/event', { id: 's-flip' }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'max-tokens' } } })
    const before = lines(join(home, 'meta', 'improve-actions.jsonl')).length
    host.dispatch('session/event', { id: 's-flip' }, { type: 'turn/end', data: { turn: 4, reason: { kind: 'error', error: { code: 'E_AFTER_OFF' } } } })
    assert.equal(lines(join(home, 'meta', 'improve-actions.jsonl')).length, before, 'off gate: no new ledger lines')
    assert.equal(fedFromPeer.length, 1, 'off gate: no new feeds')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('RED LINE ⑤ end-to-end: planted original text never reaches disk under on', async () => {
  const home = scratchHome()
  try {
    process.env.DSH_TOPICS_HOME = home
    const host = fakeHost()
    await apply(host, { improveLoop: 'on' }, { openPeer: openPeerHandle, bundleRoot: () => home, now: NOW })
    const planted = ['TOP-SECRET-ARGS-PAYLOAD', 'TOP-SECRET-REASON-TEXT', 'TOP-SECRET-USER-TEXT', 'TOP-SECRET-LLM-MESSAGE']
    host.dispatch('session/event', { id: 's-redline' }, { type: 'tool/call', data: { callId: 'c9', name: 'write', arguments: `{"path":"x","content":"${planted[0]}"}` } })
    host.dispatch('session/event', { id: 's-redline' }, { type: 'tool/result', data: { turn: 1, message: { toolCallId: 'c9', isError: true }, error: { name: 'Err', code: 'E_X', reason: planted[1] } } })
    host.dispatch('session/event', { id: 's-redline' }, { type: 'user/message', data: { content: [{ type: 'text', text: planted[2] }], source: { kind: 'repeat-tool-reminder', form: 'notice', summary: 'write × 3' } } })
    host.dispatch('session/event', { id: 's-redline' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: planted[3], code: 'E_Y' } } } })
    await waitFor(() => existsSync(join(home, 'meta', 'observations.jsonl')))
    await new Promise((r) => setTimeout(r, 100))
    const onDisk = [
      join(home, 'meta', 'observations.jsonl'),
      join(home, 'meta', 'improve-actions.jsonl'),
      join(home, 'meta', 'pipeline-events.jsonl'),
    ].filter(existsSync).map((f) => readFileSync(f, 'utf8')).join('\n')
    for (const secret of planted) {
      assert.ok(!onDisk.includes(secret), `planted text must not reach any ledger: ${secret}`)
    }
    // The features DID land.
    assert.ok(onDisk.includes('tool-error'), 'tool-error feature landed')
    assert.ok(onDisk.includes('repeat-call'), 'repeat-call feature landed')
    assert.ok(onDisk.includes('turn-end-negative'), 'turn-end-negative feature landed')
  } finally {
    delete process.env.DSH_TOPICS_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('LEDGER: whitelist entries, 512KB compaction keeps the newest tail, silent on failure', () => {
  const home = scratchHome()
  try {
    const file = join(home, 'meta', 'improve-actions.jsonl')
    const ledger = new ActionLedger(file)
    ledger.append({ at: NOW(), kind: 'signal', gate: 'shadow', sessionId: 's', type: 'tool-error', detail: { toolName: 'bash' } })
    const first = lines(file)
    assert.equal(first.length, 1)
    assert.equal(first[0].kind, 'signal')
    assert.equal(first[0].detail.toolName, 'bash')
    // Pad past the cap with filler lines written directly, then append.
    mkdirSync(join(home, 'meta'), { recursive: true })
    const filler = 'x'.repeat(1024)
    const big = [JSON.stringify({ at: NOW(), kind: 'feed-degraded', gate: 'shadow', reason: 'oldest-marker-0' })]
    for (let i = 0; i < 600; i++) big.push(JSON.stringify({ at: NOW(), kind: 'feed-degraded', gate: 'shadow', reason: filler }))
    big.push(JSON.stringify({ at: NOW(), kind: 'feed-degraded', gate: 'shadow', reason: 'keepme-newest-2' }))
    assert.ok(Buffer.byteLength(big.join('\n')) > LEDGER_MAX_BYTES, 'filler actually exceeds the cap')
    writeFileSync(file, big.join('\n') + '\n')
    ledger.append({ at: NOW(), kind: 'feed', gate: 'on', count: 1, accepted: 1, duplicates: 0, rejected: 0 })
    const size = readFileSync(file).byteLength
    assert.ok(size <= LEDGER_MAX_BYTES + 4096, `compacted under the cap (got ${size})`)
    const kept = lines(file)
    const reasons = kept.map((e) => e.reason)
    assert.ok(!reasons.includes('oldest-marker-0'), 'oldest quarter dropped')
    assert.ok(reasons.includes('keepme-newest-2'), 'newest entries survive compaction')
    assert.equal(kept.at(-1).kind, 'feed', 'newest entry kept')
    assert.deepEqual(kept.at(-1), { at: NOW(), kind: 'feed', gate: 'on', count: 1, accepted: 1, duplicates: 0, rejected: 0 })
    // Silent on failure: an unwritable path never throws.
    const broken = new ActionLedger(join(file, 'nested', 'bad.jsonl'))
    assert.doesNotThrow(() => broken.append({ at: NOW(), kind: 'feed-degraded', gate: 'shadow', reason: 'nope' }))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
