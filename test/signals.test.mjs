// Signal-collector mapping tests (wave N1): the five firehose signals, the
// field whitelist (红线⑤ — planted original text must never survive), the
// per-turn-end flush cadence, and the unused-injection aggregate function.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SignalCollector } from '../lib/signals.js'
import { unusedInjectionObservations, USAGE_WINDOW_DAYS, UNUSED_INJECTION_SLUG_CAP } from '../lib/feed.js'

const NOW = () => '2026-10-11T00:00:00.000Z'

/** Drive one collector through a session event list; return flushed batches. */
function run(events, sessionId = 's1') {
  const batches = []
  const collector = new SignalCollector({ flush: (sid, obs) => batches.push({ sid, obs }) }, NOW)
  for (const [type, data] of events) collector.onSessionEvent(sessionId, type, data)
  return { batches, collector }
}

test('signal 1 tool-error: isError + error.name/code with toolName joined from tool/call', () => {
  const { batches } = run([
    ['turn/start', { turn: 1 }],
    ['tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"echo hi"}' }],
    ['tool/result', { turn: 1, step: 1, message: { toolCallId: 'c1', isError: true }, error: { name: 'ToolError', code: 'E_TIMEOUT', reason: 'planted-reason-text' } }],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
  ])
  assert.equal(batches.length, 1)
  const obs = batches[0].obs
  const toolError = obs.find((o) => o.type === 'tool-error')
  assert.ok(toolError, 'tool-error observation emitted')
  assert.deepEqual(toolError.detail, { toolName: 'bash', turn: 1, errorName: 'ToolError', errorCode: 'E_TIMEOUT' })
  assert.equal(toolError.sessionId, 's1')
  assert.equal(toolError.at, NOW())
})

test('signal 1: error.reason (text body) never enters the observation', () => {
  const { batches } = run([
    ['tool/call', { callId: 'c1', name: 'write' }],
    ['tool/result', { turn: 3, message: { toolCallId: 'c1', isError: true }, error: { name: 'FsError', code: 'ENOENT', reason: '/Users/x/secret-plan.md: no such file' } }],
    ['turn/end', { turn: 3, reason: { kind: 'completed' } }],
  ])
  const line = JSON.stringify(batches[0].obs)
  assert.ok(!line.includes('secret-plan'), 'planted reason path must not survive')
  assert.ok(!line.includes('no such file'), 'planted reason text must not survive')
})

test('signal 1: non-error results and unknown callIds degrade cleanly', () => {
  const { batches } = run([
    ['tool/result', { turn: 1, message: { toolCallId: 'cx', isError: false } }],
    ['tool/result', { turn: 1, message: { toolCallId: 'cy', isError: true } }],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
  ])
  const obs = batches[0].obs
  assert.equal(obs.length, 1)
  assert.equal(obs[0].type, 'tool-error')
  assert.equal(obs[0].detail.toolName, 'unknown')
})

test('signal 2 turn-end-negative: error/max-tokens/aborted with feature fields only', () => {
  const { batches } = run([
    ['turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'planted-llm-message', code: 'RATE_LIMIT', status: 429 } } }],
    ['turn/end', { turn: 2, reason: { kind: 'max-tokens' } }],
    ['turn/end', { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } }],
    ['turn/end', { turn: 4, reason: { kind: 'completed' } }],
    ['turn/end', { turn: 5, reason: { kind: 'forked' } }],
  ])
  assert.equal(batches.length, 3, 'negative turns drain; empty buffers do not call flush')
  assert.deepEqual(batches[0].obs.map((o) => o.detail), [{ reason: 'error', turn: 1, errorCode: 'RATE_LIMIT' }])
  assert.deepEqual(batches[1].obs.map((o) => o.detail), [{ reason: 'max-tokens', turn: 2 }])
  assert.deepEqual(batches[2].obs.map((o) => o.detail), [{ reason: 'aborted', turn: 3, cancelKind: 'user' }])
  const line = JSON.stringify(batches)
  assert.ok(!line.includes('planted-llm-message'), 'LlmFailure.message must not survive')
})

test('signal 3 repeat-call: eavesdrops the host reminder source, summary parsed to features', () => {
  const { batches } = run([
    ['user/message', { content: [{ type: 'text', text: 'planted-reminder-arguments' }], source: { kind: 'repeat-tool-reminder', form: 'notice', summary: 'bash × 3' } }],
    ['user/message', { content: [{ type: 'text', text: 'planted-again' }], source: { kind: 'repeat-tool-reminder', form: 'notice', summary: 'unparseable summary' } }],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
  ])
  const repeats = batches[0].obs.filter((o) => o.type === 'repeat-call')
  assert.equal(repeats.length, 2, 'one struggle event per reminder')
  assert.deepEqual(repeats[0].detail, { toolName: 'bash', count: 3 })
  assert.deepEqual(repeats[1].detail, { detected: 1 }, 'unparseable summary still counts, guesses nothing')
  const line = JSON.stringify(batches)
  assert.ok(!line.includes('planned') && !line.includes('planted-reminder-arguments') && !line.includes('planted-again'), 'reminder content never survives')
})

test('signal 4 interruption-pair: aborted/interrupted armed, next human message pairs once', () => {
  const { batches } = run([
    ['turn/end', { turn: 7, reason: { kind: 'aborted', reason: { kind: 'user' } } }],
    ['user/message', { content: [{ type: 'text', text: 'planted-steer' }], source: { kind: 'user' } }],
    ['user/message', { content: [{ type: 'text', text: 'planted-more' }], source: { kind: 'user' } }],
    ['turn/end', { turn: 8, reason: { kind: 'completed' } }],
  ])
  const pairs = batches.flatMap((b) => b.obs).filter((o) => o.type === 'interruption-pair')
  assert.equal(pairs.length, 1, 'exactly one pair per interruption')
  assert.deepEqual(pairs[0].detail, { trigger: 'aborted', turn: 7 })
})

test('signal 4: interrupted assistant prefix arms the pair too', () => {
  const { batches } = run([
    ['assistant/message', { turn: 4, step: 1, message: { role: 'assistant' }, stream: [], interrupted: true }],
    ['user/message', { source: { kind: 'user' } }],
    ['turn/end', { turn: 5, reason: { kind: 'completed' } }],
  ])
  const pairs = batches.flatMap((b) => b.obs).filter((o) => o.type === 'interruption-pair')
  assert.deepEqual(pairs[0].detail, { trigger: 'interrupted', turn: 4 })
})

test('signal 4: a plain user message without a pending interruption pairs nothing', () => {
  const { batches } = run([
    ['user/message', { source: { kind: 'user' } }],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
  ])
  assert.equal(batches.length, 0, 'no observations at all — not even an empty batch')
})

test('cadence: observations buffer per turn and drain exactly at turn/end', () => {
  const { batches } = run([
    ['tool/result', { turn: 1, message: { toolCallId: 'a', isError: true } }],
    ['tool/result', { turn: 1, message: { toolCallId: 'b', isError: true } }],
    // No turn end yet — nothing flushed.
  ])
  assert.equal(batches.length, 0)
  const { batches: flushed } = run([
    ['tool/result', { turn: 1, message: { toolCallId: 'a', isError: true } }],
    ['tool/result', { turn: 1, message: { toolCallId: 'b', isError: true } }],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
  ])
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].obs.length, 2, 'one batch per turn, never per event')
})

test('malformed events never throw and produce nothing', () => {
  const { batches } = run([
    ['tool/result', null],
    ['tool/result', undefined],
    ['tool/result', 'a string'],
    ['turn/end', { turn: 'x', reason: null }],
    ['user/message', {}],
    ['assistant/message', { interrupted: 'yes' }],
    ['unknown/event', { whatever: true }],
  ])
  assert.equal(batches.length, 0)
})

test('disposeSession drops per-session state without throwing', () => {
  const collector = new SignalCollector({ flush: () => {} }, NOW)
  collector.onSessionEvent('sx', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  collector.disposeSession('sx')
  collector.disposeSession('sx')
  const batches = []
  const c2 = new SignalCollector({ flush: (sid, obs) => batches.push(obs) }, NOW)
  c2.onSessionEvent('sy', 'tool/result', { turn: 1, message: { toolCallId: 'q', isError: true } })
  c2.disposeSession('sy')
  // The buffered observation went down with the session — no leak, no flush.
  assert.equal(batches.length, 0)
})

test('unused-injection aggregate: hits>=1 && opens===0, sorted by hits desc, capped', () => {
  const signals = new Map([
    ['unused-a', { hits: 2, opens: 0 }],
    ['opened', { hits: 5, opens: 3 }],
    ['never-injected', { hits: 0, opens: 0 }],
    ['unused-b', { hits: 9, opens: 0 }],
  ])
  const obs = unusedInjectionObservations(signals, NOW)
  assert.deepEqual(
    obs.map((o) => o.detail.slug),
    ['unused-b', 'unused-a'],
    'only zero-open injected slugs, newest sort by hits',
  )
  assert.ok(obs.every((o) => o.type === 'unused-injection'))
  assert.ok(obs.every((o) => o.sessionId === undefined), 'aggregate snapshot carries no session dimension')
  assert.deepEqual(obs[0].detail, { slug: 'unused-b', hits: 9, opens: 0, windowDays: USAGE_WINDOW_DAYS })
})

test('unused-injection aggregate: empty map → empty snapshot', () => {
  assert.deepEqual(unusedInjectionObservations(new Map(), NOW), [])
})

test('unused-injection aggregate: cap holds', () => {
  const signals = new Map()
  for (let i = 0; i < UNUSED_INJECTION_SLUG_CAP + 10; i++) signals.set(`slug-${String(i).padStart(3, '0')}`, { hits: 1, opens: 0 })
  const obs = unusedInjectionObservations(signals, NOW)
  assert.equal(obs.length, UNUSED_INJECTION_SLUG_CAP)
})
