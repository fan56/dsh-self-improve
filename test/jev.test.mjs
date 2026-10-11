// Wave-N4 tests: the jev decision layer — client fail-open semantics (no
// key / timeout / http / bad response → fallback band + decisions rows, never
// a throw), the three bands at both thresholds, the decisions-ledger
// discipline (whitelist rows, no judged text, 512KB compaction, silent), key
// resolution, and the enhancement-layer OFF guard (zero calls, zero rows,
// byte-for-byte N2/N3 pure-code paths).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { ActionLedger } from '../lib/ledger.js'
import { clearKeychainCache } from '@aiwayds/dsh-jev-core'
import {
  ADOPT_THRESHOLD,
  DECISIONS_MAX_BYTES,
  appendDecisionRow,
  bandOf,
  createJevGate,
  normalizeJevBackend,
  readDecisionRows,
  recentRowsFor,
  resolveJevModel,
  resolveZenKey,
  retireSuggestions,
  stateDigest,
  ZEN_DEFAULT_MODEL,
  ZEN_ENDPOINT,
} from '../lib/jev-gate.js'
import { clusterJudgeState, listRetireCandidates, scanRetireReview, scanTriggers } from '../lib/triggers.js'
import { draftProCon, generateSkillDraft, parseSkillMd, renderSkillMd, summaryLlm } from '../lib/skill-draft.js'
import { buildReviewCommand, retireInstalledSkill } from '../lib/review.js'

const NOW = () => '2026-10-11T08:00:00.000Z'

function scratch() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-self-improve-n4-'))
  return { home, bundle: join(home, 'bundle'), drafts: join(home, 'skills-drafts'), skills: join(home, 'skills') }
}

const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : [])
const decisionsFileOf = (s) => join(s.bundle, 'meta', 'improve-decisions.jsonl')
const actionsFileOf = (s) => join(s.bundle, 'meta', 'improve-actions.jsonl')

function ledgerOn(file) {
  return new ActionLedger(() => file)
}

/**
 * A jev gate whose judge() resolves canned probabilities — the four-gate
 * mock. Like the real client it WRITES decisions rows (the gates' throttles
 * read them back), and counts every judge call.
 */
function mockGate(probByRef, { outcome = 'ok', enabled = true, file = () => '/nonexistent/decisions.jsonl' } = {}) {
  const calls = []
  return {
    calls,
    enabled: () => enabled,
    decisionsFile: file,
    async judge(input) {
      calls.push(input)
      const out = new Map()
      for (const s of input.subjects) {
        const p = typeof probByRef === 'function' ? probByRef(s.ref, input) : probByRef[s.ref]
        const judgment = p === undefined ? { band: 'fallback', outcome } : { band: bandOf(p), probability: p, outcome: 'ok' }
        out.set(s.ref, judgment)
        appendDecisionRow(file(), {
          at: NOW(),
          gate: input.gate,
          ref: s.ref,
          digest: stateDigest(input.state),
          ...(judgment.probability !== undefined ? { probability: judgment.probability } : {}),
          band: judgment.band,
          outcome: judgment.outcome,
        })
      }
      return out
    },
  }
}

/** A fetchImpl that answers a jev classify call. */
function okFetch(prob = 0.86) {
  let bodies = []
  const fn = async (endpoint, init) => {
    bodies.push({ endpoint, body: JSON.parse(init.body) })
    const qs = Object.keys(JSON.parse(init.body).questions)
    return new Response(JSON.stringify({ model: 'jev-1.13-free', answers: Object.fromEntries(qs.map((q) => [q, { noul: prob }])) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  fn.bodies = () => bodies
  return fn
}

// ---------------------------------------------------------------------------
// client: backend/model normalization, key ladder, band thresholds
// ---------------------------------------------------------------------------

test('backend/model normalization: only exact zen enables; sentinel resolves', () => {
  assert.equal(normalizeJevBackend('zen'), 'zen')
  assert.equal(normalizeJevBackend(''), '')
  assert.equal(normalizeJevBackend('Zen'), '', 'case-sensitive — a typo degrades to off')
  assert.equal(normalizeJevBackend('laya'), '')
  assert.equal(resolveJevModel(''), ZEN_DEFAULT_MODEL)
  assert.equal(resolveJevModel('  '), ZEN_DEFAULT_MODEL)
  assert.equal(resolveJevModel('jev-1.13-free'), 'jev-1.13-free')
  assert.equal(resolveJevModel('jev-1.12.0'), 'jev-1.12.0', 'an explicit pin is honored')
})

test('band thresholds: 0.60 adopt / 0.10 record / below fallback', () => {
  assert.equal(ADOPT_THRESHOLD, 0.6)
  assert.equal(bandOf(1), 'adopt')
  assert.equal(bandOf(0.86), 'adopt')
  assert.equal(bandOf(0.6), 'adopt')
  assert.equal(bandOf(0.5999), 'record')
  assert.equal(bandOf(0.35), 'record')
  assert.equal(bandOf(0.1), 'record')
  assert.equal(bandOf(0.0999), 'fallback')
  assert.equal(bandOf(0), 'fallback')
})

test('key ladder: JEV_ZEN_API_KEY env first, keychain fallback, none → null', () => {
  const runnerCalls = []
  const runner = (args) => {
    runnerCalls.push(args)
    return 'keychain-secret-value'
  }
  assert.equal(resolveZenKey({ JEV_ZEN_API_KEY: ' env-key ' }, runner), 'env-key', 'env wins and is trimmed')
  assert.equal(runnerCalls.length, 0, 'env hit never touches the keychain')
  clearKeychainCache() // jev-core memoizes keychain lookups per spec — reset between runners
  assert.equal(resolveZenKey({ JEV_ZEN_API_KEY: '' }, runner), 'keychain-secret-value')
  assert.equal(resolveZenKey({}, runner), 'keychain-secret-value')
  assert.ok(runnerCalls[0].includes('opencode-zen-inference'), 'the keychain service is queried')
  clearKeychainCache()
  assert.equal(resolveZenKey({}, () => null), null, 'no env + no keychain entry → null (fail-open config state)')
  clearKeychainCache()
  // A stray host env key must NOT reroute zen traffic — only our ladder.
  assert.equal(resolveZenKey({ TYPESAFE_API_KEY: 'stray', JEV_API_KEY: 'stray2' }, () => null), null)
})

// ---------------------------------------------------------------------------
// the client: judge() over a fake transport
// ---------------------------------------------------------------------------

function gateDeps(s, extra = {}) {
  return {
    backend: () => extra.backend ?? 'zen',
    model: () => extra.model ?? '',
    decisionsFile: () => decisionsFileOf(s),
    now: NOW,
    keyResolver: () => (extra.key === undefined ? 'test-key' : extra.key),
    ...(extra.fetch !== undefined ? { fetchImpl: extra.fetch } : {}),
  }
}

const SUBJECT = [{ ref: 'bash/E1', instructions: '同一个问题吗', criteria: { true: '是', false: '否' } }]

test('judge: one call → band folded, rows whitelisted, no judged text on disk', async () => {
  const s = scratch()
  try {
    const fetch = okFetch(0.35) // exercises the record band over the wire
    const gate = createJevGate(gateDeps(s, { fetch, model: 'jev-1.12.0' }))
    const out = await gate.judge({ gate: 'trigger-cluster', state: 'cluster key=bash/E1 failures=3', subjects: SUBJECT })
    assert.equal(out.get('bash/E1').band, 'record')
    assert.equal(out.get('bash/E1').probability, 0.35)
    assert.equal(out.get('bash/E1').outcome, 'ok')
    // wire shape: zen endpoint/model, positional noul questions, state verbatim
    const body = fetch.bodies()[0].body
    assert.equal(fetch.bodies()[0].endpoint, ZEN_ENDPOINT)
    assert.equal(body.model, 'jev-1.12.0')
    assert.equal(body.state, 'cluster key=bash/E1 failures=3')
    assert.equal(body.questions.q0.type, 'noul')
    assert.ok(body.questions.q0.instructions.length > 0, 'zen requires per-question instructions')
    assert.deepEqual(body.questions.q0.criteria, { true: '是', false: '否' }, 'two-sided criteria on the wire')
    // the decisions row: whitelist fields only, digest not text
    const rows = readDecisionRows(decisionsFileOf(s))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].gate, 'trigger-cluster')
    assert.equal(rows[0].ref, 'bash/E1')
    assert.equal(rows[0].band, 'record')
    assert.equal(rows[0].probability, 0.35)
    assert.equal(rows[0].outcome, 'ok')
    assert.equal(rows[0].digest, stateDigest('cluster key=bash/E1 failures=3'))
    assert.ok(!readFileSync(decisionsFileOf(s), 'utf8').includes('cluster key=bash/E1'), 'the judged TEXT never lands (红线⑤)')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('judge: two subjects one call, mixed bands, one row each', async () => {
  const s = scratch()
  try {
    let call = 0
    const fetch = async (endpoint, init) => {
      call++
      const qs = Object.keys(JSON.parse(init.body).questions)
      return new Response(JSON.stringify({ answers: Object.fromEntries(qs.map((q, i) => [q, { noul: i === 0 ? 0.9 : 0.05 }])) }), { status: 200 })
    }
    const gate = createJevGate(gateDeps(s, { fetch }))
    const out = await gate.judge({
      gate: 'retire-review',
      state: '1. skill=a age_days=100\n2. skill=b age_days=120',
      subjects: [
        { ref: 'skill:a', instructions: '仍有价值吗', criteria: { true: '是', false: '否' } },
        { ref: 'skill:b', instructions: '仍有价值吗', criteria: { true: '是', false: '否' } },
      ],
    })
    assert.equal(call, 1, 'batched: one call for both subjects')
    assert.equal(out.get('skill:a').band, 'adopt')
    assert.equal(out.get('skill:b').band, 'fallback')
    const rows = readDecisionRows(decisionsFileOf(s))
    assert.deepEqual(
      rows.map((r) => [r.ref, r.band, r.outcome]),
      [
        ['skill:a', 'adopt', 'ok'],
        ['skill:b', 'fallback', 'ok'],
      ],
    )
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('judge fail-open: no-key / timeout / http / bad-json / wild throw all → fallback rows, never throw', async () => {
  const s = scratch()
  try {
    // no key: the transport is never reached
    let reached = 0
    const countingFetch = async () => {
      reached++
      return new Response('{}', { status: 200 })
    }
    const noKey = createJevGate(gateDeps(s, { key: null, fetch: countingFetch }))
    const r1 = await noKey.judge({ gate: 'draft-quality', state: 'x', subjects: SUBJECT })
    assert.equal(r1.get('bash/E1').band, 'fallback')
    assert.equal(r1.get('bash/E1').outcome, 'no-key')
    assert.equal(reached, 0, 'no outbound call without a key')

    // timeout: jev-core maps the TimeoutError name to its typed error
    const timeoutFetch = async () => {
      const e = new Error('The operation was aborted due to timeout')
      e.name = 'TimeoutError'
      throw e
    }
    const t = createJevGate(gateDeps(s, { fetch: timeoutFetch }))
    const r2 = await t.judge({ gate: 'draft-quality', state: 'x', subjects: SUBJECT })
    assert.equal(r2.get('bash/E1').outcome, 'timeout')

    // http 500
    const http = createJevGate(gateDeps(s, { fetch: async () => new Response('nope', { status: 500 }) }))
    const r3 = await http.judge({ gate: 'draft-quality', state: 'x', subjects: SUBJECT })
    assert.equal(r3.get('bash/E1').outcome, 'http')

    // 200 with garbage body
    const bad = createJevGate(gateDeps(s, { fetch: async () => new Response('not json at all', { status: 200 }) }))
    const r4 = await bad.judge({ gate: 'draft-quality', state: 'x', subjects: SUBJECT })
    assert.equal(r4.get('bash/E1').outcome, 'invalid-response')

    // a completely unexpected throw still lands as fallback 'error'
    const boom = createJevGate(
      gateDeps(s, {
        fetch: async () => {
          throw new Error('socket blew up')
        },
      }),
    )
    const r5 = await boom.judge({ gate: 'draft-quality', state: 'x', subjects: SUBJECT })
    assert.equal(r5.get('bash/E1').outcome, 'error')

    const rows = readDecisionRows(decisionsFileOf(s))
    assert.equal(rows.length, 5)
    assert.ok(rows.every((r) => r.band === 'fallback' && r.probability === undefined), 'failed calls carry no probability')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('judge: layer off resolves undefined, zero calls, zero rows', async () => {
  const s = scratch()
  try {
    let reached = 0
    const gate = createJevGate(
      gateDeps(s, {
        backend: '',
        fetch: async () => {
          reached++
          return new Response('{}')
        },
      }),
    )
    assert.equal(gate.enabled(), false)
    assert.equal(await gate.judge({ gate: 'trigger-cluster', state: 'x', subjects: SUBJECT }), undefined)
    assert.equal(reached, 0)
    assert.ok(!existsSync(decisionsFileOf(s)), 'an off layer never creates the decisions file')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// the decisions ledger: discipline
// ---------------------------------------------------------------------------

test('decisions ledger: compaction keeps the newest tail, silent on a broken path', () => {
  const home = scratch()
  try {
    const file = join(home.home, 'meta', 'improve-decisions.jsonl')
    appendDecisionRow(file, { at: NOW(), gate: 'trigger-cluster', ref: 'a/b', digest: 'd1', band: 'adopt', probability: 0.7, outcome: 'ok' })
    const filler = 'x'.repeat(1024)
    const big = [{ at: NOW(), gate: 'trigger-cluster', ref: 'old', digest: 'd0', band: 'adopt', outcome: 'ok' }]
    for (let i = 0; i < 600; i++) big.push({ at: NOW(), gate: 'trigger-cluster', ref: 'f', digest: filler, band: 'record', outcome: 'ok' })
    big.push({ at: NOW(), gate: 'trigger-cluster', ref: 'newest', digest: 'd2', band: 'fallback', outcome: 'timeout' })
    mkdirSync(join(home.home, 'meta'), { recursive: true })
    writeFileSync(file, big.map((e) => JSON.stringify(e)).join('\n') + '\n')
    appendDecisionRow(file, { at: NOW(), gate: 'draft-quality', ref: 'skill:x', digest: 'd3', band: 'record', outcome: 'ok' })
    assert.ok(readFileSync(file).byteLength <= DECISIONS_MAX_BYTES + 4096, 'compacted under the cap')
    const kept = readDecisionRows(file)
    assert.ok(!kept.some((e) => e.ref === 'old'), 'oldest quarter dropped')
    assert.ok(kept.some((e) => e.ref === 'newest'), 'newest survive')
    assert.equal(kept.at(-1).ref, 'skill:x')
    // silent on an unwritable path
    assert.doesNotThrow(() => appendDecisionRow(join(file, 'nested', 'bad.jsonl'), { at: NOW(), gate: 'draft-quality', ref: 'x', digest: 'd', band: 'fallback', outcome: 'no-key' }))
    // unreadable → empty read
    assert.equal(readDecisionRows(join(home.home, 'missing.jsonl')).length, 0)
  } finally {
    rmSync(home.home, { recursive: true, force: true })
  }
})

test('recentRowsFor + retireSuggestions read the ledger back', () => {
  const home = scratch()
  try {
    const file = join(home.home, 'meta', 'improve-decisions.jsonl')
    appendDecisionRow(file, { at: '2026-10-11T01:00:00.000Z', gate: 'trigger-cluster', ref: 'bash/E1', digest: 'd', band: 'fallback', outcome: 'timeout' })
    appendDecisionRow(file, { at: '2026-10-11T02:00:00.000Z', gate: 'retire-review', ref: 'skill:kept', digest: 'd', band: 'adopt', outcome: 'ok', probability: 0.8 })
    appendDecisionRow(file, { at: '2026-10-11T03:00:00.000Z', gate: 'retire-review', ref: 'skill:old', digest: 'd', band: 'fallback', outcome: 'ok', probability: 0.03 })
    assert.equal(recentRowsFor(file, 'trigger-cluster', 'bash/E1', NOW(), 24 * 3600 * 1000).length, 1)
    assert.equal(recentRowsFor(file, 'trigger-cluster', 'bash/E9', NOW(), 24 * 3600 * 1000).length, 0)
    assert.equal(recentRowsFor(file, 'trigger-cluster', 'bash/E1', '2027-10-11T00:00:00.000Z', 24 * 3600 * 1000).length, 0, 'outside the window')
    const sug = retireSuggestions(file)
    assert.deepEqual(sug.map((x) => x.ref), ['skill:old'], 'only answered <0.10 rows are suggestions')
    appendDecisionRow(file, { at: '2026-10-11T04:00:00.000Z', gate: 'retire-review', ref: 'skill:old', digest: 'd', band: 'adopt', outcome: 'ok', probability: 0.9 })
    assert.equal(retireSuggestions(file).length, 0, 'a newer adopt row per ref clears the suggestion')
    appendDecisionRow(file, { at: '2026-10-11T05:00:00.000Z', gate: 'retire-review', ref: 'skill:ghost', digest: 'd', band: 'fallback', outcome: 'no-key' })
    assert.ok(!retireSuggestions(file).some((x) => x.ref === 'skill:ghost'), 'call-failure fallback is never a suggestion')
  } finally {
    rmSync(home.home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 门① trigger-cluster: three bands + sticky window + off purity
// ---------------------------------------------------------------------------

function scanDeps(s, gate, extra = {}) {
  return {
    gate: () => gate,
    ledger: ledgerOn(actionsFileOf(s)),
    ledgerFile: () => actionsFileOf(s),
    openPeer: async () => undefined,
    now: NOW,
    generate: extra.generate ?? (() => Promise.resolve({ status: 'created', name: 'x', file: '/x', evidence: 'e' })),
    ...(extra.jev !== undefined ? { jev: extra.jev } : {}),
  }
}

function seedErrors(s, n) {
  const ledger = ledgerOn(actionsFileOf(s))
  for (let i = 0; i < n; i++) {
    ledger.append({ at: NOW(), kind: 'signal', gate: 'on', sessionId: 's', type: 'tool-error', detail: { toolName: 'bash', errorCode: 'E_ADDR' } })
  }
}

test('门①: adopt (≥0.60) lets the fire through, band on the row', async () => {
  const s = scratch()
  try {
    seedErrors(s, 3)
    const gate = mockGate({ 'bash/E_ADDR': 0.86 }, { file: () => decisionsFileOf(s) })
    const r = await scanTriggers(scanDeps(s, 'on', { jev: gate }))
    assert.equal(gate.calls.length, 1)
    assert.equal(gate.calls[0].gate, 'trigger-cluster')
    assert.match(gate.calls[0].state, /cluster key=bash\/E_ADDR failures=3 window_days=7/)
    assert.ok(r.fired !== undefined, 'adopt fires')
    const row = lines(actionsFileOf(s)).find((e) => e.kind === 'trigger')
    assert.equal(row.fired, true)
    assert.equal(row.jevBand, 'adopt')
    assert.equal(row.jevProbability, 0.86)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('门①: record (0.10–0.60) still fires but keeps the band', async () => {
  const s = scratch()
  try {
    seedErrors(s, 3)
    const gate = mockGate({ 'bash/E_ADDR': 0.35 }, { file: () => decisionsFileOf(s) })
    const r = await scanTriggers(scanDeps(s, 'on', { jev: gate }))
    assert.ok(r.fired !== undefined, 'record still fires')
    const row = lines(actionsFileOf(s)).find((e) => e.kind === 'trigger')
    assert.equal(row.jevBand, 'record')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('门①: fallback answered (<0.10) vetoes the fire', async () => {
  const s = scratch()
  try {
    seedErrors(s, 3)
    const gate = mockGate({ 'bash/E_ADDR': 0.05 }, { file: () => decisionsFileOf(s) })
    let lane = 0
    const r = await scanTriggers(
      scanDeps(s, 'on', {
        jev: gate,
        generate: () => {
          lane++
          return Promise.resolve({ status: 'created', name: 'x', file: '/x', evidence: 'e' })
        },
      }),
    )
    assert.equal(r.fired, undefined, 'fallback answered → no fire (防噪音优先)')
    assert.equal(lane, 0, 'the draft lane was never reached')
    const row = lines(actionsFileOf(s)).find((e) => e.kind === 'trigger')
    assert.equal(row.fired, false)
    assert.equal(row.wouldFire, true)
    assert.equal(row.jevBand, 'fallback')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('门①: fallback call-failure vetoes too, and the veto is sticky for the window', async () => {
  const s = scratch()
  try {
    seedErrors(s, 3)
    const gate = mockGate({ 'bash/E_ADDR': undefined }, { outcome: 'timeout', file: () => decisionsFileOf(s) })
    const r1 = await scanTriggers(scanDeps(s, 'on', { jev: gate }))
    assert.equal(r1.fired, undefined, 'call failure → no fire (防噪音优先)')
    const row1 = lines(actionsFileOf(s)).find((e) => e.kind === 'trigger')
    assert.equal(row1.jevBand, 'fallback')
    // second scan: no new jev call, veto honored from the decisions row
    gate.calls.length = 0
    const r2 = await scanTriggers(scanDeps(s, 'on', { jev: gate }))
    assert.equal(gate.calls.length, 0, 'the recheck window suppresses re-asking (no per-minute spam)')
    assert.equal(r2.fired, undefined, 'the sticky veto holds')
    const row2 = lines(actionsFileOf(s))
      .filter((e) => e.kind === 'trigger')
      .at(-1)
    assert.equal(row2.jevBand, 'fallback', 'the prior band is carried onto the new row')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('门①: a prior adopt row short-circuits the call', async () => {
  const s = scratch()
  try {
    seedErrors(s, 3)
    mkdirSync(join(s.bundle, 'meta'), { recursive: true })
    appendDecisionRow(decisionsFileOf(s), {
      at: NOW(),
      gate: 'trigger-cluster',
      ref: 'bash/E_ADDR',
      digest: stateDigest(clusterJudgeState({ key: 'bash/E_ADDR', count: 3, signals: [], lastAt: NOW() })),
      band: 'adopt',
      probability: 0.7,
      outcome: 'ok',
    })
    const gate = mockGate({}, { file: () => decisionsFileOf(s) })
    const r = await scanTriggers(scanDeps(s, 'on', { jev: gate }))
    assert.equal(gate.calls.length, 0, 'no re-ask inside the window')
    assert.ok(r.fired !== undefined, 'prior adopt → fire')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('门① OFF guard: disabled gate → byte-identical N2 rows, zero calls; no gate → same', async () => {
  const s = scratch()
  try {
    seedErrors(s, 3)
    const spy = mockGate({}, { enabled: false, file: () => decisionsFileOf(s) })
    const r = await scanTriggers(scanDeps(s, 'on', { jev: spy }))
    assert.equal(spy.calls.length, 0, 'disabled layer: judge never called')
    assert.ok(r.fired !== undefined, 'pure code fires')
    const row = lines(actionsFileOf(s)).find((e) => e.kind === 'trigger')
    assert.deepEqual(
      row,
      { at: NOW(), kind: 'trigger', gate: 'on', fired: true, wouldFire: true, key: 'bash/E_ADDR', count: 3, reason: 'bl3-no-lesson' },
      'byte-for-byte N2 row (no jevBand/jevProbability keys)',
    )
    assert.ok(!existsSync(decisionsFileOf(s)), 'no decisions rows at all')

    const s2 = scratch()
    try {
      seedErrors(s2, 3)
      await scanTriggers(scanDeps(s2, 'on'))
      const row2 = lines(actionsFileOf(s2)).find((e) => e.kind === 'trigger')
      assert.equal(row2.jevBand, undefined)
      assert.ok(!existsSync(decisionsFileOf(s2)))
    } finally {
      rmSync(s2.home, { recursive: true, force: true })
    }
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('门①: shadow never asks — the judgment exists to gate an action', async () => {
  const s = scratch()
  try {
    seedErrors(s, 3)
    const spy = mockGate({ 'bash/E_ADDR': 0.9 }, { file: () => decisionsFileOf(s) })
    const r = await scanTriggers(scanDeps(s, 'shadow', { jev: spy }))
    assert.equal(spy.calls.length, 0, 'shadow keeps its would-fire rows pure N2, call-free')
    assert.equal(r.fired, undefined)
    const row = lines(actionsFileOf(s)).find((e) => e.kind === 'trigger')
    assert.equal(row.gate, 'shadow')
    assert.equal(row.jevBand, undefined)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 门③ draft-quality: refuse+archive / proceed / fail-open
// ---------------------------------------------------------------------------

const GOOD_LLM = () =>
  Promise.resolve(
    JSON.stringify({
      name: 'quality-gated-skill',
      description: '处理某类反复失败的草稿',
      whenToUse: '当同类失败聚簇达到阈值时',
      body: '## 步骤\n\n1. 检查。\n2. 重试。\n\n失败三次升级人工。',
    }),
  )

function draftDeps(s, extra = {}) {
  return {
    gate: () => extra.gate ?? 'on',
    ledger: ledgerOn(actionsFileOf(s)),
    ledgerFile: () => actionsFileOf(s),
    draftsRoot: () => s.drafts,
    now: NOW,
    llm: GOOD_LLM,
    ...(extra.jev !== undefined ? { jev: extra.jev } : {}),
  }
}

const EVIDENCE_ONE = [{ type: 'tool-error', at: NOW(), detail: { toolName: 'bash' } }]

test('门③: answered <0.10 refuses the queue, archives the draft, ledgers the code', async () => {
  const s = scratch()
  try {
    const gate = mockGate({ 'skill:quality-gated-skill': 0.05 }, { file: () => decisionsFileOf(s) })
    const outcome = await generateSkillDraft({ kind: 'manual', evidence: EVIDENCE_ONE }, draftDeps(s, { jev: gate }))
    assert.equal(outcome.status, 'refused')
    assert.equal(outcome.reason, 'quality-gate')
    assert.match(outcome.detail, /jev:p=0\.05/)
    assert.equal(gate.calls.length, 1)
    assert.match(gate.calls[0].state, /skill_draft name=quality-gated-skill/, 'the state carries draft features')
    assert.ok(!existsSync(join(s.drafts, 'quality-gated-skill')), 'nothing entered the queue')
    assert.ok(existsSync(join(s.drafts, '.archived')), 'the draft is archived for forensics')
    const review = lines(actionsFileOf(s)).filter((e) => e.kind === 'review')
    assert.equal(review.at(-1).action, 'draft-quality-gate')
    const decisions = readDecisionRows(decisionsFileOf(s))
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0].gate, 'draft-quality')
    assert.equal(decisions[0].band, 'fallback')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('门③: adopt proceeds; cap precedes the gate; call-failure → 自验即终局; off → pure N3', async () => {
  const s = scratch()
  try {
    const adopt = mockGate({ 'skill:quality-gated-skill': 0.9 }, { file: () => decisionsFileOf(s) })
    const first = await generateSkillDraft({ kind: 'manual', evidence: EVIDENCE_ONE }, draftDeps(s, { jev: adopt }))
    assert.equal(first.status, 'created')
    assert.ok(existsSync(join(s.drafts, 'quality-gated-skill', 'SKILL.md')))

    // the daily cap (≤1) refuses before the gate is even asked
    const record = mockGate({ 'skill:quality-gated-skill': 0.35 }, { file: () => decisionsFileOf(s) })
    const second = await generateSkillDraft({ kind: 'manual', evidence: EVIDENCE_ONE }, draftDeps(s, { jev: record }))
    assert.equal(second.status, 'refused')
    assert.equal(second.reason, 'daily-cap')
    assert.equal(record.calls.length, 0, 'the cap fires before any jev call')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }

  const s3 = scratch()
  try {
    const failing = mockGate({ 'skill:quality-gated-skill': undefined }, { outcome: 'no-key', file: () => decisionsFileOf(s3) })
    const r3 = await generateSkillDraft({ kind: 'manual', evidence: EVIDENCE_ONE }, draftDeps(s3, { jev: failing }))
    assert.equal(r3.status, 'created', 'a failed jev call never blocks the lane')
    const rows = readDecisionRows(decisionsFileOf(s3))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].outcome, 'no-key')
  } finally {
    rmSync(s3.home, { recursive: true, force: true })
  }

  const s4 = scratch()
  try {
    const off = mockGate({}, { enabled: false, file: () => decisionsFileOf(s4) })
    const r4 = await generateSkillDraft({ kind: 'manual', evidence: EVIDENCE_ONE }, draftDeps(s4, { jev: off }))
    assert.equal(r4.status, 'created')
    assert.equal(off.calls.length, 0)
    assert.ok(!existsSync(decisionsFileOf(s4)))
    assert.equal(parseSkillMd(readFileSync(r4.file, 'utf8')).name, 'quality-gated-skill')
  } finally {
    rmSync(s4.home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 门② contradiction: warning lines per band, silent adopt, pure off
// ---------------------------------------------------------------------------

async function invoke(def, rawInput, agentId = 'agent-1') {
  return def.handler({ commandId: 'cmd-1', agent: { id: agentId }, rawInput, attachments: [], signal: new AbortController().signal })
}

function seedBundleLesson(s, slug) {
  mkdirSync(join(s.bundle, 'topics'), { recursive: true })
  writeFileSync(join(s.bundle, 'topics', `${slug}.md`), `---\ntitle: 端口耗尽教训\ntype: lesson\nconfidence: hint\nscope: workspace\nconclusion: 复用连接并退避重试\n---\nbody`)
}

function reviewDeps(s, extra = {}) {
  return {
    gate: () => extra.gate ?? 'on',
    ledger: ledgerOn(actionsFileOf(s)),
    openPeer: async () => extra.peer,
    bundleRoot: () => s.bundle,
    draftsRoot: () => s.drafts,
    skillsRoot: () => s.skills,
    now: NOW,
    ...(extra.jev !== undefined ? { jev: extra.jev } : {}),
  }
}

const ESTABLISHED_PEER = {
  setLessonStatus: async () => ({ ok: true }),
  lessons: () => [{ slug: 'port-exhaustion', title: '端口耗尽', triggers: ['bash', 'eaddrnotavail'] }],
}

test('门②: adopt → silent approve; record/fallback → warning + approve proceeds', async () => {
  const s = scratch()
  try {
    seedBundleLesson(s, 'port-hint')
    const adopt = mockGate({ 'lesson:port-hint': 0.86 }, { file: () => decisionsFileOf(s) })
    const cmdA = buildReviewCommand(reviewDeps(s, { jev: adopt, peer: ESTABLISHED_PEER }))
    const a = await invoke(cmdA, 'approve lesson:port-hint')
    assert.equal(a.kind, 'success')
    assert.ok(!a.text.includes('jev'), 'adopt is silent')
    assert.equal(adopt.calls.length, 1)
    assert.match(adopt.calls[0].state, /candidate_lesson:/)
    assert.match(adopt.calls[0].state, /port-exhaustion: 端口耗尽/, 'the established roster rides along')

    const s2 = scratch()
    try {
      seedBundleLesson(s2, 'port-hint')
      const record = mockGate({ 'lesson:port-hint': 0.35 }, { file: () => decisionsFileOf(s2) })
      const cmdR = buildReviewCommand(reviewDeps(s2, { jev: record, peer: ESTABLISHED_PEER }))
      const r = await invoke(cmdR, 'approve lesson:port-hint')
      assert.equal(r.kind, 'success', 'record still approves (人审优先)')
      assert.match(r.text, /jev 矛盾检测 record（p=0\.35）/)
      assert.match(r.text, /approve 完成：lesson:port-hint/)

      const s3 = scratch()
      try {
        seedBundleLesson(s3, 'port-hint')
        const contra = mockGate({ 'lesson:port-hint': 0.05 }, { file: () => decisionsFileOf(s3) })
        const cmdC = buildReviewCommand(reviewDeps(s3, { jev: contra, peer: ESTABLISHED_PEER }))
        const c = await invoke(cmdC, 'approve lesson:port-hint')
        assert.equal(c.kind, 'success', 'the human already decided — never blocked')
        assert.match(c.text, /判定为与现有 established lessons 矛盾/)

        const s4 = scratch()
        try {
          seedBundleLesson(s4, 'port-hint')
          const failing = mockGate({ 'lesson:port-hint': undefined }, { outcome: 'timeout', file: () => decisionsFileOf(s4) })
          const cmdF = buildReviewCommand(reviewDeps(s4, { jev: failing, peer: ESTABLISHED_PEER }))
          const f = await invoke(cmdF, 'approve lesson:port-hint')
          assert.equal(f.kind, 'success')
          assert.match(f.text, /jev 矛盾检测不可用（timeout）/)
        } finally {
          rmSync(s4.home, { recursive: true, force: true })
        }
      } finally {
        rmSync(s3.home, { recursive: true, force: true })
      }
    } finally {
      rmSync(s2.home, { recursive: true, force: true })
    }
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('门② OFF: no gate / disabled → N3 text byte-identical, zero calls, zero rows', async () => {
  const s = scratch()
  try {
    seedBundleLesson(s, 'port-hint')
    const spy = mockGate({}, { enabled: false, file: () => decisionsFileOf(s) })
    const cmd = buildReviewCommand(reviewDeps(s, { jev: spy, peer: ESTABLISHED_PEER }))
    const r = await invoke(cmd, 'approve lesson:port-hint')
    assert.equal(r.kind, 'success')
    assert.equal(r.text, 'approve 完成：lesson:port-hint（原仓已 git 提交，可 revert）。', 'exact N3 output')
    assert.equal(spy.calls.length, 0)
    assert.ok(!existsSync(decisionsFileOf(s)))
    const cmd2 = buildReviewCommand(reviewDeps(s, { peer: ESTABLISHED_PEER }))
    const r2 = await invoke(cmd2, 'approve lesson:port-hint')
    assert.equal(r2.text, 'approve 完成：lesson:port-hint（原仓已 git 提交，可 revert）。')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 门④ retire review: candidates, bands, throttle, off
// ---------------------------------------------------------------------------

function seedInstalled(s, name, created, { source = 'auto-generated' } = {}) {
  mkdirSync(join(s.skills, name), { recursive: true })
  writeFileSync(
    join(s.skills, name, 'SKILL.md'),
    renderSkillMd({ name, description: 'd', whenToUse: 'w', body: 'body text long enough' }, '7d: x1', created).replace('source: auto-generated', `source: ${source}`),
  )
}

test('门④ candidates: auto-generated only, ≥90d by frontmatter created, oldest first', () => {
  const s = scratch()
  try {
    seedInstalled(s, 'old-skill', '2026-06-01')
    seedInstalled(s, 'young-skill', '2026-10-01')
    seedInstalled(s, 'handmade', '2026-01-01', { source: 'hand' })
    const cands = listRetireCandidates(s.skills, NOW())
    assert.deepEqual(cands.map((c) => c.name), ['old-skill'], 'young excluded, hand-written invisible')
    assert.equal(cands[0].ageDays, 132)
    assert.equal(listRetireCandidates(join(s.home, 'nope'), NOW()).length, 0)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('门④: answered <0.10 → suggestion rows land; adopt → none; usage rides along', async () => {
  const s = scratch()
  try {
    seedInstalled(s, 'stale-skill', '2026-06-01')
    seedInstalled(s, 'busy-skill', '2026-05-01')
    const gate = mockGate((ref) => (ref === 'skill:stale-skill' ? 0.03 : 0.92), { file: () => decisionsFileOf(s) })
    const peer = { usageSignals: () => new Map([['busy-skill', { hits: 7, opens: 2 }]]) }
    const r = await scanRetireReview({ jev: gate, skillsRoot: () => s.skills, openPeer: async () => peer, now: NOW })
    assert.equal(r.status, 'judged')
    assert.equal(r.asked, 2)
    assert.deepEqual(r.suggested, ['stale-skill'])
    assert.equal(gate.calls.length, 1, 'one batched call for both skills')
    assert.match(gate.calls[0].state, /usage_30d hits=7 opens=2/, 'the injection aggregate is a feature')
    const rows = readDecisionRows(decisionsFileOf(s))
    assert.equal(rows.length, 2)
    assert.deepEqual(retireSuggestions(decisionsFileOf(s)).map((x) => x.ref), ['skill:stale-skill'])
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('门④: 24h recheck window — a judged skill is never re-asked', async () => {
  const s = scratch()
  try {
    seedInstalled(s, 'stale-skill', '2026-06-01')
    const gate = mockGate({ 'skill:stale-skill': 0.03 }, { file: () => decisionsFileOf(s) })
    await scanRetireReview({ jev: gate, skillsRoot: () => s.skills, openPeer: async () => undefined, now: NOW })
    assert.equal(gate.calls.length, 1)
    const r2 = await scanRetireReview({ jev: gate, skillsRoot: () => s.skills, openPeer: async () => undefined, now: NOW })
    assert.equal(gate.calls.length, 1, 'no second call inside the window')
    assert.equal(r2.asked, 0)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('门④ OFF: zero reads (skillsRoot untouched), zero calls, zero rows', async () => {
  const s = scratch()
  try {
    let read = 0
    const spy = mockGate({}, { enabled: false, file: () => decisionsFileOf(s) })
    const r = await scanRetireReview({
      jev: spy,
      skillsRoot: () => {
        read++
        return s.skills
      },
      openPeer: async () => undefined,
      now: NOW,
    })
    assert.equal(r.status, 'off')
    assert.equal(read, 0, 'the skills root is not even listed')
    assert.ok(!existsSync(decisionsFileOf(s)))
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 门④ adjudication: reject on an installed skill = retire-uninstall
// ---------------------------------------------------------------------------

test('retireInstalledSkill: archives the installed copy; hand-written refused', () => {
  const s = scratch()
  try {
    seedInstalled(s, 'stale-skill', '2026-06-01')
    const out = retireInstalledSkill('skill:stale-skill', { gate: 'on', skillsRoot: s.skills, draftsRoot: s.drafts })
    assert.equal(out.status, 'retired')
    assert.ok(!existsSync(join(s.skills, 'stale-skill')), 'uninstalled')
    assert.ok(existsSync(join(out.archiveDir, 'SKILL.md')), 'rollback copy archived')
    assert.equal(parseSkillMd(readFileSync(join(out.archiveDir, 'SKILL.md'), 'utf8')).name, 'stale-skill')
    seedInstalled(s, 'handmade', '2026-01-01', { source: 'hand' })
    assert.equal(retireInstalledSkill('skill:handmade', { gate: 'on', skillsRoot: s.skills, draftsRoot: s.drafts }).reason, 'not-ours')
    assert.ok(existsSync(join(s.skills, 'handmade', 'SKILL.md')), 'hand-written never touched')
    assert.equal(retireInstalledSkill('skill:x', { gate: 'shadow', skillsRoot: s.skills, draftsRoot: s.drafts }).reason, 'gate')
    assert.equal(retireInstalledSkill('skill:missing-thing', { gate: 'on', skillsRoot: s.skills, draftsRoot: s.drafts }).reason, 'missing-skill')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('queue: retire suggestions render, then self-clear after the human rejects', async () => {
  const s = scratch()
  try {
    seedInstalled(s, 'stale-skill', '2026-06-01')
    const gate = mockGate({ 'skill:stale-skill': 0.03 }, { file: () => decisionsFileOf(s) })
    await scanRetireReview({ jev: gate, skillsRoot: () => s.skills, openPeer: async () => undefined, now: NOW })
    const cmd = buildReviewCommand(reviewDeps(s, { jev: gate }))
    const list = await invoke(cmd, '')
    assert.match(list.text, /退役复审建议/)
    assert.match(list.text, /jev p=0\.03/)
    assert.match(list.text, /reject skill:stale-skill/)
    const rej = await invoke(cmd, 'reject skill:stale-skill')
    assert.equal(rej.kind, 'success')
    assert.match(rej.text, /已退役并卸装/)
    const list2 = await invoke(cmd, '')
    assert.ok(!list2.text.includes('skill:stale-skill  退役复审建议'), 'decided suggestions leave the queue')
    const rejected = lines(actionsFileOf(s)).find((e) => e.kind === 'review' && e.action === 'rejected' && e.object === 'skill:stale-skill')
    assert.match(rejected.rollback, /uninstalled=.*archived=/)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 审批证据摘要: LLM pro/con + cache + machine fallback
// ---------------------------------------------------------------------------

const PROCON_LLM = () => Promise.resolve('{"pro":"步骤具体，直接可执行","con":"缺少失败升级的人工阈值"}')

const DRAFT_MD = renderSkillMd({ name: 'my-skill', description: 'd', whenToUse: 'w', body: 'body text long enough' }, '7d: tool-error x3', '2026-10-10')

function showDeps(s, llm) {
  return {
    gate: () => 'on',
    ledger: ledgerOn(actionsFileOf(s)),
    openPeer: async () => undefined,
    bundleRoot: () => s.bundle,
    draftsRoot: () => s.drafts,
    skillsRoot: () => s.skills,
    now: NOW,
    ...(llm !== undefined ? { llm } : {}),
  }
}

test('evidence summary: LLM block on show, cache absorbs repeats, digest change re-calls', async () => {
  const s = scratch()
  try {
    const dir = join(s.drafts, 'my-skill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), DRAFT_MD)
    let calls = 0
    const llm = () => {
      calls++
      return PROCON_LLM()
    }
    const show1 = await invoke(buildReviewCommand(showDeps(s, llm)), 'show skill:my-skill')
    assert.equal(show1.kind, 'success')
    assert.match(show1.text, /机器拼，信号计数\+来源/, 'the machine summary stays')
    assert.match(show1.text, /LLM 正反方摘要（glm-5\.3-flash）/)
    assert.match(show1.text, /正方: 步骤具体，直接可执行/)
    assert.match(show1.text, /反方: 缺少失败升级的人工阈值/)
    assert.equal(calls, 1)
    const cacheFile = join(s.bundle, 'meta', 'improve-summaries.jsonl')
    assert.equal(lines(cacheFile).length, 1, 'one cache row')
    const row = lines(cacheFile)[0]
    assert.equal(row.id, 'skill:my-skill')
    assert.equal(row.digest, stateDigest(DRAFT_MD))
    await invoke(buildReviewCommand(showDeps(s, llm)), 'show skill:my-skill')
    assert.equal(calls, 1, 'the cache absorbed the second show')
    writeFileSync(join(dir, 'SKILL.md'), DRAFT_MD + '\n<!-- edited -->')
    await invoke(buildReviewCommand(showDeps(s, llm)), 'show skill:my-skill')
    assert.equal(calls, 2, 'an edited draft (new digest) re-calls')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('evidence summary: LLM failure / junk shape → N3 machine output byte-identical', async () => {
  const s = scratch()
  try {
    const dir = join(s.drafts, 'my-skill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), DRAFT_MD)
    const expected = `skill:my-skill 的证据摘要（机器拼，信号计数+来源）：\n  7d: tool-error x3\n\n——— SKILL.md 全文 ———\n${DRAFT_MD}`
    const failing = await invoke(buildReviewCommand(showDeps(s, () => Promise.reject(new Error('llm-http-500')))), 'show skill:my-skill')
    assert.equal(failing.text, expected, 'exact N3 output on LLM failure')
    const junk = await invoke(buildReviewCommand(showDeps(s, () => Promise.resolve('no json here'))), 'show skill:my-skill')
    assert.equal(junk.text, expected)
    const empty = await invoke(buildReviewCommand(showDeps(s, () => Promise.resolve('{"pro":"","con":"c"}'))), 'show skill:my-skill')
    assert.equal(empty.text, expected)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('draftProCon unit: cache-first, bounded lines', async () => {
  const s = scratch()
  try {
    const cacheFile = join(s.bundle, 'meta', 'improve-summaries.jsonl')
    let calls = 0
    const llm = () => {
      calls++
      return Promise.resolve('{"pro":"p","con":"c"}')
    }
    const input = { id: 'skill:x', evidence: '7d: x1', draftText: 'DRAFT', cacheFile, llm, now: NOW }
    assert.deepEqual(await draftProCon(input), { pro: 'p', con: 'c' })
    assert.deepEqual(await draftProCon(input), { pro: 'p', con: 'c' })
    assert.equal(calls, 1, 'cache hit')
    const long = await draftProCon({ ...input, draftText: 'DRAFT2', llm: () => Promise.resolve(JSON.stringify({ pro: 'p'.repeat(500), con: 'c'.repeat(500) })) })
    assert.equal(long.pro.length, 200)
    assert.equal(long.con.length, 200)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('summaryLlm: default route without the credential ref fails fast (no hang, no fetch)', async () => {
  const s = scratch()
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = s.home // no .credentials.yaml in the scratch home
    await assert.rejects(summaryLlm({ system: 's', user: 'u' }), /no-credential/)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    rmSync(s.home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// wiring: apply() with a mocked gate — rows land through the loop; default
// config (backend '') keeps the whole loop jev-silent
// ---------------------------------------------------------------------------

function firehoseHost() {
  const listeners = new Map()
  return {
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
    },
    inject() {},
    dispatch(event, subject, extra) {
      for (const l of listeners.get(event) ?? []) l(subject, extra)
    },
  }
}

test('apply wiring: backend=zen + mocked gate → the trigger-cluster judgment rides the scan', async () => {
  const s = scratch()
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = s.home // keep the draft lane's default LLM route credential-free
    const host = firehoseHost()
    const gate = mockGate({ 'bash/E_ADDR': 0.9 }, { file: () => decisionsFileOf(s) })
    ledgerOn(actionsFileOf(s)).append({ at: NOW(), kind: 'signal', gate: 'on', sessionId: 's-wire', type: 'tool-error', detail: { toolName: 'bash', errorCode: 'E_ADDR' } })
    ledgerOn(actionsFileOf(s)).append({ at: NOW(), kind: 'signal', gate: 'on', sessionId: 's-wire', type: 'tool-error', detail: { toolName: 'bash', errorCode: 'E_ADDR' } })
    await apply(host, { improveLoop: 'on', improveJevBackend: 'zen', improveJevModel: '' }, {
      openPeer: async () => undefined,
      bundleRoot: () => s.bundle,
      now: NOW,
      draftsRoot: () => s.drafts,
      skillsRoot: () => s.skills,
      jev: gate,
    })
    host.dispatch('session/event', { id: 's-wire' }, { type: 'tool/call', data: { callId: 'c1', name: 'bash' } })
    host.dispatch('session/event', { id: 's-wire' }, { type: 'tool/result', data: { turn: 1, message: { toolCallId: 'c1', isError: true }, error: { name: 'ToolError', code: 'E_ADDR' } } })
    host.dispatch('session/event', { id: 's-wire' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise((r) => setTimeout(r, 150))
    assert.ok(gate.calls.some((c) => c.gate === 'trigger-cluster'), 'the trigger-cluster judgment rode the scan')
    const rows = readDecisionRows(decisionsFileOf(s))
    assert.ok(rows.some((r2) => r2.gate === 'trigger-cluster' && r2.band === 'adopt'))
    const triggerRow = lines(actionsFileOf(s)).find((e) => e.kind === 'trigger')
    assert.equal(triggerRow.jevBand, 'adopt', 'the band rode the action-ledger trigger row too')
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('apply wiring: default config (backend "") → the loop is jev-silent, pure-code fire', async () => {
  const s = scratch()
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = s.home
    const host = firehoseHost()
    ledgerOn(actionsFileOf(s)).append({ at: NOW(), kind: 'signal', gate: 'on', sessionId: 's-off', type: 'tool-error', detail: { toolName: 'bash', errorCode: 'E_ADDR' } })
    ledgerOn(actionsFileOf(s)).append({ at: NOW(), kind: 'signal', gate: 'on', sessionId: 's-off', type: 'tool-error', detail: { toolName: 'bash', errorCode: 'E_ADDR' } })
    await apply(host, { improveLoop: 'on' }, {
      openPeer: async () => undefined,
      bundleRoot: () => s.bundle,
      now: NOW,
      draftsRoot: () => s.drafts,
      skillsRoot: () => s.skills,
    })
    host.dispatch('session/event', { id: 's-off' }, { type: 'tool/call', data: { callId: 'c1', name: 'bash' } })
    host.dispatch('session/event', { id: 's-off' }, { type: 'tool/result', data: { turn: 1, message: { toolCallId: 'c1', isError: true }, error: { name: 'ToolError', code: 'E_ADDR' } } })
    host.dispatch('session/event', { id: 's-off' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise((r) => setTimeout(r, 150))
    assert.ok(!existsSync(decisionsFileOf(s)), 'zero decision rows with the layer off')
    const triggerRow = lines(actionsFileOf(s)).find((e) => e.kind === 'trigger')
    assert.ok(triggerRow !== undefined, 'the pure-code scan still ran')
    assert.equal(triggerRow.jevBand, undefined, 'byte-identical N2 trigger row')
    assert.equal(triggerRow.fired, true, 'pure code fires')
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    rmSync(s.home, { recursive: true, force: true })
  }
})
