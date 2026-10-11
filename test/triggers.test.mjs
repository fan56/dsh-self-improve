// Wave-N2 tests: the trigger engine — clustering window/threshold edges, the
// BL-3 conjunction branches (lesson blind spot / established-still-recurring /
// established-holds suppression), the daily fire cap, the three-state gate
// (off = zero reads, shadow = would-fire band, on = fire), the throttle, the
// interruption fast lane (placeholder hint, pending-refine marker, per-session
// cap, real-peer saveTopic data plane), and the /improve-review triggers view.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { ActionLedger } from '../lib/ledger.js'
import {
  approvedAtOf,
  clusterToolErrors,
  createInterruptionHint,
  hasFiredToday,
  HINT_CAP_PER_SESSION,
  HINT_PENDING_REFINE,
  readLedger,
  relatedLessons,
  scanTriggers,
  tokensOf,
  TRIGGER_THRESHOLD,
  TRIGGER_WINDOW_DAYS,
  viewTriggers,
  windowedSignals,
} from '../lib/triggers.js'
import { evaluateSkillTrigger } from '../lib/skill-draft.js'
import { buildReviewCommand } from '../lib/review.js'

const NOW = () => '2026-10-11T12:00:00.000Z'
const DAY = 24 * 60 * 60 * 1000
const daysAgo = (n) => new Date(Date.parse(NOW()) - n * DAY).toISOString()

function scratch() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-self-improve-n2-'))
  return { home, bundle: join(home, 'bundle'), drafts: join(home, 'skills-drafts'), skills: join(home, 'skills') }
}

const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : [])

function ledgerOn(file) {
  return new ActionLedger(() => file)
}

const ledgerFileOf = (s) => join(s.bundle, 'meta', 'improve-actions.jsonl')

/** Seed n tool-error signals for tool/code, `ageDays` days before NOW. */
function seedErrors(s, tool, code, n, ageDays = 1) {
  const ledger = ledgerOn(ledgerFileOf(s))
  for (let i = 0; i < n; i++) {
    ledger.append({ at: daysAgo(ageDays), kind: 'signal', gate: 'on', sessionId: `s${i}`, type: 'tool-error', detail: { toolName: tool, errorCode: code, errorName: 'ToolError', turn: i } })
  }
}

const CREATED = () => ({ status: 'created', name: 'generated-skill', file: '/tmp/nowhere/SKILL.md', evidence: '7d: tool-error x3' })

function scanDeps(s, gate, extra = {}) {
  return {
    gate: () => gate,
    ledger: ledgerOn(ledgerFileOf(s)),
    ledgerFile: () => ledgerFileOf(s),
    openPeer: async () => extra.peer,
    now: extra.now ?? NOW,
    generate: extra.generate ?? (() => Promise.resolve(CREATED())),
  }
}

async function waitFor(fn, ms = 2000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return fn()
}

// ---------------------------------------------------------------------------
// clustering: window + threshold edges
// ---------------------------------------------------------------------------

test('clustering: groups by toolName+code, errorName fallback, unknown bucketed', () => {
  const signals = [
    { type: 'tool-error', at: NOW(), detail: { toolName: 'bash', errorCode: 'E_ADDR' } },
    { type: 'tool-error', at: NOW(), detail: { toolName: 'bash', errorCode: 'E_ADDR' } },
    { type: 'tool-error', at: NOW(), detail: { toolName: 'bash', errorName: 'TimeoutError' } },
    { type: 'tool-error', at: NOW(), detail: {} },
    { type: 'turn-end-negative', at: NOW(), detail: { reason: 'error' } },
  ]
  const clusters = clusterToolErrors(signals)
  assert.deepEqual(clusters.map((c) => `${c.key}:${c.count}`), ['bash/E_ADDR:2', 'bash/TimeoutError:1', 'unknown/-:1'])
})

test('clustering window: only signals inside the trailing 7 days count', () => {
  const s = scratch()
  try {
    seedErrors(s, 'bash', 'E_ADDR', 2, 1) // inside
    seedErrors(s, 'bash', 'E_ADDR', 3, 9) // outside the window
    const entries = readLedger(ledgerFileOf(s))
    const inWindow = windowedSignals(entries, NOW(), TRIGGER_WINDOW_DAYS)
    assert.equal(inWindow.length, 2, '8-day-old signals excluded')
    const clusters = clusterToolErrors(inWindow)
    assert.equal(clusters[0].count, 2)
    assert.ok(clusters[0].count < TRIGGER_THRESHOLD, 'old-only history never becomes a candidate')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('threshold edge: 2 in window = no candidate, 3 = candidate and fire', async () => {
  const s = scratch()
  try {
    seedErrors(s, 'bash', 'E_ADDR', 2)
    let scans = 0
    const gen = () => {
      scans++
      return Promise.resolve(CREATED())
    }
    const r2 = await scanTriggers({ ...scanDeps(s, 'on'), generate: gen })
    assert.equal(r2.status, 'no-candidates')
    assert.equal(scans, 0)
    assert.equal(lines(ledgerFileOf(s)).filter((e) => e.kind === 'trigger').length, 0, 'candidate-less scans never ledger')

    seedErrors(s, 'bash', 'E_ADDR', 1)
    const r3 = await scanTriggers({ ...scanDeps(s, 'on'), generate: gen })
    assert.equal(r3.status, 'scanned')
    assert.equal(r3.decisions[0].reason, 'bl3-no-lesson')
    assert.ok(r3.fired !== undefined, '3 in window fires')
    assert.equal(scans, 1, 'exactly one draft-lane call')
    const rows = lines(ledgerFileOf(s)).filter((e) => e.kind === 'trigger')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].fired, true)
    assert.equal(rows[0].wouldFire, true)
    assert.equal(rows[0].key, 'bash/E_ADDR')
    assert.equal(rows[0].count, 3)
    assert.equal(rows[0].gate, 'on')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// BL-3 branches
// ---------------------------------------------------------------------------

function peerWithLessons(lessons) {
  return { lessons: () => lessons, usageSignals: () => new Map(), feed: async () => ({}), setLessonStatus: async () => ({}) }
}

test('BL-3 word-face: related by title or triggers token, unrelated ignored', () => {
  const cluster = { key: 'bash/E_ADDR', toolName: 'bash', code: 'E_ADDR', count: 3, signals: [], lastAt: NOW() }
  const related = relatedLessons(cluster, [
    { slug: 'bash-retry', title: 'bash 失败退避重试', triggers: [] },
    { slug: 'by-trigger', title: '无关标题', triggers: ['e_addr', 'port'] },
    { slug: 'unrelated', title: '编辑器窗口管理', triggers: ['ui', 'layout'] },
  ])
  assert.deepEqual(related.map((l) => l.slug), ['bash-retry', 'by-trigger'])
  assert.ok(tokensOf('Bash-Error 7').has('bash'))
  assert.ok(tokensOf('打断纠正').has('打断纠正'), 'CJK runs are single word-face tokens')
})

test('BL-3 branch: no related lesson → blind-spot fire (also with peer absent)', async () => {
  const s = scratch()
  try {
    seedErrors(s, 'bash', 'E_ADDR', 3)
    for (const peer of [undefined, peerWithLessons([{ slug: 'other', title: '无关', triggers: [] }])]) {
      const r = await scanTriggers(scanDeps(s, 'shadow', { peer }))
      assert.equal(r.decisions[0].reason, 'bl3-no-lesson')
      assert.equal(r.decisions[0].wouldFire, true)
      assert.equal(r.fired, undefined, 'shadow never fires')
    }
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('BL-3 branch: established lesson with post-approval failures still recurs → fire', async () => {
  const s = scratch()
  try {
    seedErrors(s, 'bash', 'E_ADDR', 3, 5) // failures 5 days old…
    ledgerOn(ledgerFileOf(s)).append({ at: daysAgo(6), kind: 'review', gate: 'on', action: 'approved', object: 'lesson:bash-retry', rollback: 'seam' }) // …after a 6-day-old approval
    const peer = peerWithLessons([{ slug: 'bash-retry', title: 'bash E_ADDR 退避重试', triggers: [] }])
    const r = await scanTriggers(scanDeps(s, 'shadow', { peer }))
    assert.equal(r.decisions[0].reason, 'bl3-lesson-recurring')
    assert.equal(r.decisions[0].wouldFire, true)
    assert.deepEqual(r.decisions[0].related.map((l) => l.slug), ['bash-retry'])
    const rows = lines(ledgerFileOf(s)).filter((e) => e.kind === 'trigger')
    assert.ok(rows.every((e) => e.fired === false && e.wouldFire === true), 'shadow rows are the would-fire band')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('BL-3 branch: related established lesson with no post-approval recurrence suppresses', async () => {
  const s = scratch()
  try {
    seedErrors(s, 'bash', 'E_ADDR', 3, 6) // all failures 6 days old…
    ledgerOn(ledgerFileOf(s)).append({ at: daysAgo(3), kind: 'review', gate: 'on', action: 'approved', object: 'lesson:bash-retry' }) // …lesson 3 days ago: nothing recurred since
    const peer = peerWithLessons([{ slug: 'bash-retry', title: 'bash E_ADDR 退避重试', triggers: [] }])
    const r = await scanTriggers(scanDeps(s, 'shadow', { peer }))
    assert.equal(r.decisions[0].reason, 'bl3-lesson-holds')
    assert.equal(r.decisions[0].wouldFire, false)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('BL-3 branch: an established lesson with no approval row on record counts as recurring', async () => {
  const s = scratch()
  try {
    seedErrors(s, 'bash', 'E_ADDR', 3, 1)
    // Approved by another actor / before this ledger existed — the window's
    // failures are treated as post-approval (the lesson did not hold).
    const peer = peerWithLessons([{ slug: 'bash-retry', title: 'bash E_ADDR 退避重试', triggers: [] }])
    const r = await scanTriggers(scanDeps(s, 'shadow', { peer }))
    assert.equal(r.decisions[0].reason, 'bl3-lesson-recurring')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('approvedAtOf + hasFiredToday ledger helpers', () => {
  const s = scratch()
  try {
    seedErrors(s, 'bash', 'E_ADDR', 1)
    const ledger = ledgerOn(ledgerFileOf(s))
    ledger.append({ at: daysAgo(1), kind: 'review', gate: 'on', action: 'approved', object: 'lesson:x' })
    ledger.append({ at: daysAgo(9), kind: 'review', gate: 'on', action: 'approved', object: 'lesson:y' })
    const entries = readLedger(ledgerFileOf(s))
    assert.equal(approvedAtOf(entries, 'x'), daysAgo(1))
    assert.equal(approvedAtOf(entries, 'y'), daysAgo(9))
    assert.equal(approvedAtOf(entries, 'missing'), undefined)
    assert.equal(hasFiredToday(entries, NOW()), false, 'approvals are not fires')
    ledger.append({ at: NOW(), kind: 'trigger', gate: 'on', fired: true, wouldFire: true, key: 'bash/E', count: 3, reason: 'bl3-no-lesson' })
    assert.equal(hasFiredToday(readLedger(ledgerFileOf(s)), NOW()), true)
    assert.equal(hasFiredToday(readLedger(ledgerFileOf(s)), daysAgo(9)), false, 'a yesterday fire does not spend today')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('daily fire cap: the engine records already-fired-today instead of re-firing', async () => {
  const s = scratch()
  try {
    seedErrors(s, 'bash', 'E_ADDR', 3)
    const first = await scanTriggers(scanDeps(s, 'on'))
    assert.ok(first.fired !== undefined)
    const second = await scanTriggers(scanDeps(s, 'on', { generate: () => { throw new Error('lane must not be reached') } }))
    assert.equal(second.fired, undefined, 'the day is spent')
    const rows = lines(ledgerFileOf(s)).filter((e) => e.kind === 'trigger')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].fired, true)
    assert.equal(rows[1].reason, 'already-fired-today')
    assert.equal(rows[1].fired, false)
    assert.equal(rows[1].wouldFire, true, 'still a candidate — only the cap suppresses')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('fire path carries engine clearance; uncleared cluster requests stay declined', async () => {
  const s = scratch()
  try {
    seedErrors(s, 'bash', 'E_ADDR', 3)
    let seen
    await scanTriggers(scanDeps(s, 'on', { generate: async (input) => { seen = input; return CREATED() } }))
    assert.equal(seen.kind, 'cluster')
    assert.equal(seen.cluster.cleared, true)
    assert.equal(evaluateSkillTrigger(seen, { windowDays: 7, threshold: 3 }).triggered, true, 'cleared input passes the lane guard')
    const uncleared = { ...seen, cluster: { ...seen.cluster, cleared: false } }
    assert.equal(evaluateSkillTrigger(uncleared, { windowDays: 7, threshold: 3 }).triggered, false)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// three-state gate + throttle (apply() wiring)
// ---------------------------------------------------------------------------

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

let callSeq = 0
/** One paired tool failure through the firehose (callId → name resolution). */
function dispatchError(host, sessionId, code, tool = 'bash') {
  const callId = `c-${++callSeq}`
  host.dispatch('session/event', { id: sessionId }, { type: 'tool/call', data: { callId, name: tool } })
  host.dispatch('session/event', { id: sessionId }, { type: 'tool/result', data: { turn: 1, message: { toolCallId: callId, isError: true }, error: { name: 'ToolError', code } } })
}

const GOOD_LLM = (name) => async () =>
  JSON.stringify({ name, description: 'bash E_ADDR 处置', whenToUse: 'bash 反复 E_ADDR', body: '## 步骤\n\n1. 检查可用端口范围。\n2. 复用连接或退避重试。\n\n超过三次失败后升级为人工排查。' })

test('apply ON end-to-end: a real cluster fires a draft; the pair signal opens a hint row', async () => {
  const s = scratch()
  try {
    mkdirSync(s.bundle, { recursive: true })
    const host = fakeHost()
    let llmCalls = 0
    let mono = 0
    const tick = () => {
      mono += 61_000
    }
    await apply(
      host,
      { improveLoop: 'on' },
      {
        openPeer: async () => undefined,
        bundleRoot: () => s.bundle,
        now: NOW,
        monoNow: () => mono,
        draftsRoot: () => s.drafts,
        llm: async () => {
          llmCalls++
          return GOOD_LLM('fix-bash-e-addr')()
        },
      },
    )
    const id = 's-e2e'
    dispatchError(host, id, 'E_ADDR')
    host.dispatch('session/event', { id }, { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } })
    tick()
    dispatchError(host, id, 'E_ADDR')
    host.dispatch('session/event', { id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    tick()
    dispatchError(host, id, 'E_ADDR')
    host.dispatch('session/event', { id }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    assert.ok(await waitFor(() => existsSync(join(s.drafts, 'fix-bash-e-addr', 'SKILL.md'))), 'the fired draft landed in the drafts area')
    const md = readFileSync(join(s.drafts, 'fix-bash-e-addr', 'SKILL.md'), 'utf8')
    assert.match(md, /source: auto-generated/)
    assert.match(md, /tool=bash/, 'evidence carries the cluster features')
    const actionsFile = ledgerFileOf(s)
    const rows = () => lines(actionsFile).filter((e) => e.kind === 'trigger')
    await waitFor(() => rows().length >= 1)
    assert.equal(rows().length, 1, 'only the candidate-bearing scan ledgers')
    assert.equal(rows()[0].fired, true)
    assert.equal(rows()[0].key, 'bash/E_ADDR')
    assert.ok(lines(actionsFile).some((e) => e.kind === 'review' && e.action === 'draft-created'))
    assert.equal(llmCalls, 1, 'one LLM call total')

    // An interruption pair under ON: immediate fast lane (peer absent → the
    // seam-unavailable row proves the wiring; the signal row is dispatch's).
    host.dispatch('session/event', { id }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    host.dispatch('session/event', { id }, { type: 'user/message', data: { source: { kind: 'user' } } })
    host.dispatch('session/event', { id }, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
    assert.ok(await waitFor(() => lines(actionsFile).some((e) => e.kind === 'hint' && e.action === 'seam-unavailable')), 'the fast lane ran immediately')
    assert.ok(lines(actionsFile).some((e) => e.kind === 'signal' && e.type === 'interruption-pair'))
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('apply SHADOW: engine computes would-fire rows, no LLM, no drafts, no hints; throttle holds', async () => {
  const s = scratch()
  try {
    mkdirSync(s.bundle, { recursive: true })
    const host = fakeHost()
    let llmCalls = 0
    let mono = 0
    const tick = () => {
      mono += 61_000
    }
    await apply(
      host,
      { improveLoop: 'shadow' },
      {
        openPeer: async () => undefined,
        bundleRoot: () => s.bundle,
        now: NOW,
        monoNow: () => mono,
        draftsRoot: () => s.drafts,
        llm: async () => {
          llmCalls++
          return '{}'
        },
      },
    )
    const id = 's-shadow-n2'
    dispatchError(host, id, 'E_X')
    host.dispatch('session/event', { id }, { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } })
    tick()
    dispatchError(host, id, 'E_X')
    host.dispatch('session/event', { id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    tick()
    dispatchError(host, id, 'E_X')
    host.dispatch('session/event', { id }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    const actionsFile = ledgerFileOf(s)
    const rows = () => lines(actionsFile).filter((e) => e.kind === 'trigger')
    await waitFor(() => rows().length >= 1)
    assert.equal(rows().length, 1)
    assert.equal(rows()[0].gate, 'shadow')
    assert.equal(rows()[0].fired, false)
    assert.equal(rows()[0].wouldFire, true, 'the would-fire band')
    assert.equal(llmCalls, 0, 'shadow never calls the LLM')
    assert.equal(existsSync(s.drafts), false, 'no drafts under shadow')

    // An interruption pair under shadow: signal row only — no hint lane.
    host.dispatch('session/event', { id }, { type: 'turn/end', data: { turn: 9, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    host.dispatch('session/event', { id }, { type: 'user/message', data: { source: { kind: 'user' } } })
    host.dispatch('session/event', { id }, { type: 'turn/end', data: { turn: 10, reason: { kind: 'completed' } } })
    assert.ok(lines(actionsFile).some((e) => e.kind === 'signal' && e.type === 'interruption-pair'), 'the pair signal is ledgered')
    assert.equal(lines(actionsFile).filter((e) => e.kind === 'hint').length, 0, 'shadow produces no hint rows')
    // Same-minute scan: throttled — still exactly one trigger row.
    host.dispatch('session/event', { id }, { type: 'turn/end', data: { turn: 11, reason: { kind: 'completed' } } })
    assert.equal(lines(actionsFile).filter((e) => e.kind === 'trigger').length, 1, 'one scan per session per minute')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('apply OFF: the engine never runs — zero reads, no files, no listeners', async () => {
  const s = scratch()
  try {
    mkdirSync(s.bundle, { recursive: true })
    const host = fakeHost()
    let peerProbed = false
    await apply(host, { improveLoop: 'off' }, { openPeer: async () => { peerProbed = true; return undefined }, bundleRoot: () => s.bundle, now: NOW })
    assert.equal(host.listenerCount('session/event'), 0, 'no listeners under off')
    for (let i = 0; i < 3; i++) {
      dispatchError(host, 's-off', 'E_Y')
      host.dispatch('session/event', { id: 's-off' }, { type: 'turn/end', data: { turn: i, reason: { kind: 'completed' } } })
    }
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(peerProbed, false)
    assert.equal(existsSync(ledgerFileOf(s)), false, 'the ledger file is never even created')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// interruption fast lane
// ---------------------------------------------------------------------------

function hintDeps(s, gate, peer, now = NOW) {
  return { gate: () => gate, ledger: ledgerOn(ledgerFileOf(s)), ledgerFile: () => ledgerFileOf(s), openPeer: async () => peer, now }
}

test('fast lane: placeholder hint through the peer lesson data plane, pending-refine marked', async () => {
  const s = scratch()
  try {
    mkdirSync(s.bundle, { recursive: true })
    const saves = []
    const peer = { saveLesson: async (input) => { saves.push(input); return { ok: true, slug: 'interrupt' } } }
    const r = await createInterruptionHint('sess-1', 7, 'aborted', hintDeps(s, 'on', peer))
    assert.equal(r.status, 'created')
    assert.deepEqual(saves, [
      {
        title: '打断纠正占位 turn-7',
        description: '用户在 turn 7 打断了助手（trigger=aborted；session=sess-1）——打断对快速通道占位 hint',
        conclusion: `待蒸馏批次补全（${HINT_PENDING_REFINE}）：condition=「用户在 turn 7 打断了助手」；action 待 LLM 冷读提炼补全（B2/MJ-1 升格路径，后续集成波落地）。本条仅为占位，未经审批前不参与注入。`,
        triggers: ['interruption-correction', HINT_PENDING_REFINE],
      },
    ])
    const rows = lines(ledgerFileOf(s)).filter((e) => e.kind === 'hint')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].action, 'created')
    assert.equal(rows[0].slug, 'interrupt')
    assert.equal(rows[0].turn, 7)
    assert.equal(rows[0].sessionId, 'sess-1')
    assert.equal(rows[0].gate, 'on')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('fast lane: cap ≤3 per session counts from the ledger; other sessions unaffected', async () => {
  const s = scratch()
  try {
    mkdirSync(s.bundle, { recursive: true })
    const peer = { saveLesson: async () => ({ ok: true, slug: 'x' }) }
    for (let i = 0; i < HINT_CAP_PER_SESSION; i++) {
      const r = await createInterruptionHint('sess-cap', i, 'interrupted', hintDeps(s, 'on', peer))
      assert.equal(r.status, 'created')
    }
    const fourth = await createInterruptionHint('sess-cap', 4, 'interrupted', hintDeps(s, 'on', peer))
    assert.equal(fourth.status, 'cap-refused')
    const other = await createInterruptionHint('sess-other', 1, 'aborted', hintDeps(s, 'on', peer))
    assert.equal(other.status, 'created', 'the cap is per session')
    const rows = lines(ledgerFileOf(s)).filter((e) => e.kind === 'hint')
    assert.equal(rows.filter((e) => e.action === 'created').length, HINT_CAP_PER_SESSION + 1)
    assert.equal(rows.filter((e) => e.action === 'cap-refused').length, 1)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('fast lane: gate semantics + seam degradation ledgered', async () => {
  const s = scratch()
  try {
    mkdirSync(s.bundle, { recursive: true })
    // shadow: nothing happens at all (the signal row is dispatch's business).
    assert.equal((await createInterruptionHint('s', 1, 'aborted', hintDeps(s, 'shadow', { saveLesson: async () => ({ ok: true }) }))).status, 'gate-blocked')
    assert.equal(lines(ledgerFileOf(s)).length, 0, 'shadow adds no hint rows')
    // peer absent → seam-unavailable, ledgered.
    const r = await createInterruptionHint('s', 1, 'aborted', hintDeps(s, 'on', undefined))
    assert.equal(r.status, 'seam-unavailable')
    // saveLesson refusing → seam-failed, ledgered.
    const r2 = await createInterruptionHint('s', 2, 'aborted', hintDeps(s, 'on', { saveLesson: async () => ({ ok: false }) }))
    assert.equal(r2.status, 'seam-failed')
    // saveLesson throwing → seam-failed, still no throw out of the lane.
    const r3 = await createInterruptionHint('s', 3, 'aborted', hintDeps(s, 'on', { saveLesson: async () => { throw new Error('boom') } }))
    assert.equal(r3.status, 'seam-failed')
    const rows = lines(ledgerFileOf(s)).filter((e) => e.kind === 'hint')
    assert.deepEqual(rows.map((e) => e.action), ['seam-unavailable', 'seam-failed', 'seam-failed'])
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('fast lane: the REAL peer data plane writes a hint lesson with correction provenance', async () => {
  const s = scratch()
  try {
    process.env.DSH_TOPICS_HOME = s.bundle
    const { openPeerHandle } = await import('../lib/feed.js')
    const peer = await openPeerHandle()
    assert.ok(peer !== undefined, 'the 0.25.0 peer loads')
    const r = await createInterruptionHint('sess-real', 12, 'aborted', hintDeps(s, 'on', peer))
    assert.equal(r.status, 'created')
    assert.ok(r.slug !== undefined && r.slug !== '')
    const file = join(s.bundle, 'topics', `${r.slug}.md`)
    assert.ok(existsSync(file), 'the hint lesson landed in the peer bundle')
    const md = readFileSync(file, 'utf8')
    assert.match(md, /type: Lesson/i)
    assert.match(md, /confidence: hint/)
    assert.match(md, /source: correction/)
    assert.match(md, /scope: workspace/)
    assert.match(md, /workspaceId:/, 'MJ-2 workspace stamp present')
    assert.match(md, new RegExp(HINT_PENDING_REFINE))
    assert.match(md, /turn 12/, 'the position feature is the placeholder condition')
    // The established roster never sees a hint (MJ-3) — the BL-3 read channel.
    assert.equal(peer.lessons().length, 0)
  } finally {
    delete process.env.DSH_TOPICS_HOME
    rmSync(s.home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// /improve-review triggers — the observation surface
// ---------------------------------------------------------------------------

async function invoke(def, rawInput) {
  return def.handler({ commandId: 'cmd-1', agent: { id: 'agent-1' }, rawInput, attachments: [], signal: new AbortController().signal })
}

function commandDeps(s, gate, peer) {
  return {
    gate: () => gate,
    ledger: ledgerOn(ledgerFileOf(s)),
    openPeer: async () => peer,
    bundleRoot: () => s.bundle,
    draftsRoot: () => s.drafts,
    skillsRoot: () => s.skills,
    now: NOW,
  }
}

test('triggers command: lists candidates with judgment basis; off refuses; no ledger writes', async () => {
  const s = scratch()
  try {
    mkdirSync(s.bundle, { recursive: true })
    seedErrors(s, 'bash', 'E_ADDR', 3)
    const peer = peerWithLessons([{ slug: 'unrelated-lesson', title: '编辑器窗口管理', triggers: [] }])
    const cmd = buildReviewCommand(commandDeps(s, 'shadow', peer))
    const r = await invoke(cmd, 'triggers')
    assert.equal(r.kind, 'success')
    assert.match(r.text, /bash\/E_ADDR ×3/)
    assert.match(r.text, /盲区直通/)
    assert.match(r.text, /shadow：只记 would-fire 账/)
    assert.match((await invoke(buildReviewCommand(commandDeps(s, 'off', peer)), 'triggers')).text, /off/)
    assert.equal(lines(ledgerFileOf(s)).filter((e) => e.kind === 'trigger' || e.kind === 'review').length, 0, 'a dry run never writes')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('triggers command: recurring-lesson basis shows the related lesson with usage stats', async () => {
  const s = scratch()
  try {
    mkdirSync(s.bundle, { recursive: true })
    seedErrors(s, 'bash', 'E_ADDR', 3, 5) // failures 5 days old…
    ledgerOn(ledgerFileOf(s)).append({ at: daysAgo(6), kind: 'review', gate: 'on', action: 'approved', object: 'lesson:bash-retry' }) // …after a 6-day-old approval → still recurring
    const peer = peerWithLessons([{ slug: 'bash-retry', title: 'bash E_ADDR 退避', triggers: [], hits: 9, opens: 2 }])
    const r = await invoke(buildReviewCommand(commandDeps(s, 'on', peer)), 'triggers')
    assert.match(r.text, /仍复发/)
    assert.match(r.text, /bash-retry/)
    assert.match(r.text, /hits=9\/opens=2/)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})
