// Wave-N3 tests: the skills draft generator (mock LLM), the shadow
// self-check gate, hand-written-skill install protection, the -auto suffix
// rule, reject semantics, the /improve-review command surface under the
// improveLoop three states, the off-guard with the command registered, the
// action-ledger discipline for review entries, the daily cap, and the
// lesson seam (setLessonStatus actor).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { ActionLedger } from '../lib/ledger.js'
import {
  buildDraftPrompt,
  checkDraft,
  DAILY_DRAFT_CAP,
  evaluateSkillTrigger,
  generateSkillDraft,
  parseSkillMd,
  recentSignals,
  renderSkillMd,
  scanSecrets,
  summarizeEvidence,
} from '../lib/skill-draft.js'
import { archiveDraft, buildReviewCommand, installSkill, listHintLessons, listSkillDrafts, parseReviewId } from '../lib/review.js'

const NOW = () => '2026-10-11T08:00:00.000Z'

function scratch() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-self-improve-n3-'))
  return {
    home,
    bundle: join(home, 'bundle'),
    drafts: join(home, 'skills-drafts'),
    skills: join(home, 'skills'),
  }
}

const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : [])

function ledgerOn(file) {
  return new ActionLedger(() => file)
}

const GOOD_LLM = () =>
  Promise.resolve(
    JSON.stringify({
      name: 'retry-ephemeral-port-errors',
      description: '处理临时端口耗尽的 bash 工具失败',
      whenToUse: '当 bash 调用反复报 EADDRNOTAVAIL 时',
      body: '## 步骤\n\n1. 检查可用端口范围。\n2. 复用连接或退避重试。\n\n超过三次失败后升级为人工排查。',
    }),
  )

function draftDeps(s, gate, llm = GOOD_LLM, now = NOW) {
  const ledgerFile = join(s.bundle, 'meta', 'improve-actions.jsonl')
  return {
    gate: () => gate,
    ledger: ledgerOn(ledgerFile),
    ledgerFile: () => ledgerFile,
    draftsRoot: () => s.drafts,
    now,
    llm,
  }
}

// ---------------------------------------------------------------------------
// evidence + self-check gate (pure)
// ---------------------------------------------------------------------------

test('evidence summary: counts and whitelist features only', () => {
  const summary = summarizeEvidence([
    { type: 'tool-error', at: NOW(), detail: { toolName: 'bash', errorCode: 'E_ADDR', errorName: 'ToolError' } },
    { type: 'tool-error', at: NOW(), detail: { toolName: 'bash', errorCode: 'E_ADDR' } },
    { type: 'repeat-call', at: NOW(), detail: { toolName: 'bash', count: 3 } },
    { type: 'interruption-pair', at: NOW(), detail: { trigger: 'aborted' } },
  ])
  assert.match(summary, /^7d: /)
  assert.match(summary, /tool-error \(tool=bash,err=ToolError,code=E_ADDR\) x1/)
  assert.match(summary, /tool-error \(tool=bash,code=E_ADDR\) x1/)
  assert.match(summary, /repeat-call \(tool=bash,n=3\) x1/)
  assert.match(summary, /interruption-pair \(trig=aborted\) x1/)
  // No field outside the whitelist can leak through.
  const sneaky = summarizeEvidence([{ type: 'x', at: NOW(), detail: { reason: 'boom', sessionTitle: 'TOP-SECRET' } }])
  assert.ok(!sneaky.includes('TOP-SECRET'), 'unknown detail keys dropped')
  assert.match(sneaky, /x \(why=boom\) x1/)
})

test('self-check gate: good JSON passes, structure failures carry machine codes', async () => {
  const good = checkDraft(await GOOD_LLM())
  assert.equal(good.ok, true)
  if (good.ok) assert.equal(good.parts.name, 'retry-ephemeral-port-errors')

  const bad = checkDraft('{"name":"Bad Name","description":"","whenToUse":"x","body":"short"}')
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.deepEqual(bad.reasons.sort(), ['body-too-short', 'invalid-name', 'missing-description'])

  assert.deepEqual(checkDraft('total nonsense'), { ok: false, reasons: ['unparseable-response'] })
  assert.ok(checkDraft('```json\n' + (await GOOD_LLM()) + '\n```').ok, 'fenced JSON tolerated')

  const kebabOk = ['a', 'skill-1', 'fix-bash-eaddrnotavail']
  for (const n of kebabOk) {
    const r = checkDraft(JSON.stringify({ name: n, description: 'd', whenToUse: 'w', body: 'b'.repeat(40) }))
    assert.equal(r.ok, true, n)
  }
})

test('renderSkillMd: machine-stamped frontmatter, source never from the model', () => {
  const parts = { name: 'my-skill', description: 'd: with colon', whenToUse: 'w "quoted"', body: '# Body\n\ntext' }
  const md = renderSkillMd(parts, '7d: tool-error x3', '2026-10-11')
  const fm = parseSkillMd(md)
  assert.equal(fm.source, 'auto-generated')
  assert.equal(fm.created, '2026-10-11')
  assert.equal(fm.name, 'my-skill')
  assert.equal(fm.description, 'd: with colon')
  assert.equal(fm.whenToUse, 'w "quoted"')
  assert.equal(fm.evidence, '7d: tool-error x3')
  assert.match(md, /# Body/)
})

test('parseReviewId: strict grammar, no traversal', () => {
  assert.equal(parseReviewId('skill:foo-bar'), 'skill:foo-bar')
  assert.equal(parseReviewId('lesson:a1_b2.c'), 'lesson:a1_b2.c')
  assert.equal(parseReviewId('skill:..'), undefined)
  assert.equal(parseReviewId('skill:.hidden'), undefined)
  assert.equal(parseReviewId('skill:a/b'), undefined)
  assert.equal(parseReviewId('other:foo'), undefined)
  assert.equal(parseReviewId('skill:'), undefined)
})

test('scanSecrets: generic shapes and credentials-ref values block', () => {
  const s = scratch()
  try {
    const cred = join(s.home, 'creds.yaml')
    writeFileSync(cred, 'version: 1\nrefs:\n  ZAI_CODING_CN_API_KEY: cb09f1c7e0e545b7b18907a28f84593d.fC4SSoSxJJogjnPR\n')
    assert.equal(scanSecrets('a clean prompt about bash errors', cred), undefined)
    assert.equal(scanSecrets('leak: cb09f1c7e0e545b7b18907a28f84593d.fC4SSoSxJJogjnPR', cred), 'credentials-ref:ZAI_CODING_CN_API_KEY')
    assert.equal(scanSecrets('token ghp_0123456789abcdefghijklmnopqrstuvwxyz here', cred), 'github-token')
    assert.equal(scanSecrets('key sk-or-v1-0123456789abcdef0123456789abcdef here', cred), 'openrouter-key')
    assert.equal(scanSecrets('-----BEGIN RSA PRIVATE KEY-----', cred), 'pem-block')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('trigger decision: cluster needs engine clearance, manual passes (N2)', () => {
  const evidence = [{ type: 'tool-error', at: NOW(), detail: { toolName: 'bash', errorCode: 'E1' } }]
  // Uncleared cluster requests decline — the lane alone cannot auto-draft.
  assert.deepEqual(evaluateSkillTrigger({ kind: 'cluster', evidence }, { windowDays: 7, threshold: 3 }), {
    triggered: false,
    reason: 'cluster-not-cleared',
  })
  assert.deepEqual(
    evaluateSkillTrigger({ kind: 'cluster', evidence, cluster: { key: 'bash/E1', count: 2, cleared: true } }, { windowDays: 7, threshold: 3 }),
    { triggered: false, reason: 'cluster-below-threshold' },
  )
  assert.deepEqual(
    evaluateSkillTrigger({ kind: 'cluster', evidence, cluster: { key: 'bash/E1', count: 4, cleared: true } }, { windowDays: 7, threshold: 3 }),
    { triggered: true, reason: 'cluster-bl3-passed' },
  )
  assert.deepEqual(evaluateSkillTrigger({ kind: 'manual', evidence }, { windowDays: 7, threshold: 3 }), { triggered: true, reason: 'manual' })
})

test('recentSignals: only signal lines inside the window', () => {
  const s = scratch()
  try {
    const file = join(s.bundle, 'meta', 'improve-actions.jsonl')
    const ledger = ledgerOn(file)
    ledger.append({ at: '2026-10-11T00:00:00.000Z', kind: 'signal', gate: 'on', sessionId: 's', type: 'tool-error', detail: { toolName: 'bash' } })
    ledger.append({ at: '2026-09-01T00:00:00.000Z', kind: 'signal', gate: 'on', sessionId: 's', type: 'tool-error', detail: { toolName: 'old' } })
    ledger.append({ at: '2026-10-10T00:00:00.000Z', kind: 'review', gate: 'on', action: 'approved', object: 'skill:x' })
    ledger.append('not json')
    const now = '2026-10-11T00:00:00.000Z'
    const signals = recentSignals(file, now)
    assert.equal(signals.length, 1)
    assert.equal(signals[0].detail.toolName, 'bash')
    assert.equal(recentSignals(join(s.home, 'missing.jsonl'), now).length, 0)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// draft lane
// ---------------------------------------------------------------------------

test('draft: happy path writes an isolated, source-stamped SKILL.md and ledgers', async () => {
  const s = scratch()
  try {
    const file = join(s.bundle, 'meta', 'improve-actions.jsonl')
    new ActionLedger(file).append({ at: NOW(), kind: 'signal', gate: 'on', sessionId: 's1', type: 'tool-error', detail: { toolName: 'bash', errorCode: 'E_ADDR' } })
    const deps = draftDeps(s, 'on')
    const outcome = await generateSkillDraft({ kind: 'manual', evidence: [] }, deps)
    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    const md = readFileSync(outcome.file, 'utf8')
    const fm = parseSkillMd(md)
    assert.equal(fm.source, 'auto-generated')
    assert.equal(fm.name, 'retry-ephemeral-port-errors')
    assert.equal(fm.created, '2026-10-11')
    assert.match(fm.evidence, /tool-error/)
    // Drafts live under the isolated drafts root, never the skills root.
    assert.ok(outcome.file.startsWith(s.drafts))
    assert.ok(!existsSync(join(s.skills, fm.name)))
    const review = lines(file).filter((e) => e.kind === 'review')
    assert.equal(review.length, 1)
    assert.equal(review[0].action, 'draft-created')
    assert.equal(review[0].object, 'skill:retry-ephemeral-port-errors')
    assert.equal(review[0].gate, 'on')
    // Red line ⑤: the prompt carried the counts line, and nothing else.
    const prompt = buildDraftPrompt(summarizeEvidence([{ type: 'tool-error', at: NOW(), detail: { toolName: 'bash', errorCode: 'E_X' } }]))
    assert.match(prompt.user, /tool-error \(tool=bash,code=E_X\) x1/)
    assert.ok(!prompt.user.includes('arguments'), 'no raw-field promises')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('draft: self-check interception refuses the queue', async () => {
  const s = scratch()
  try {
    const outcome = await generateSkillDraft({ kind: 'manual', evidence: [{ type: 'tool-error', at: NOW(), detail: {} }] }, draftDeps(s, 'on', () => Promise.resolve('{"name":"Bad Name","description":"","whenToUse":"","body":""}')))
    assert.equal(outcome.status, 'refused')
    if (outcome.status === 'refused') {
      assert.equal(outcome.reason, 'check-failed')
      assert.match(outcome.detail, /invalid-name/)
    }
    assert.equal(listSkillDrafts(s.drafts).length, 0, 'nothing entered the queue')
    const review = lines(join(s.bundle, 'meta', 'improve-actions.jsonl')).filter((e) => e.kind === 'review')
    assert.equal(review[0].action, 'draft-check-failed')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('draft: LLM failure and secret hits fail open with ledger codes', async () => {
  const s = scratch()
  try {
    const failed = await generateSkillDraft({ kind: 'manual', evidence: [{ type: 'tool-error', at: NOW(), detail: {} }] }, draftDeps(s, 'on', () => Promise.reject(new Error('llm-http-500'))))
    assert.equal(failed.status, 'refused')
    assert.equal(failed.status === 'refused' ? failed.reason : '', 'llm-failed')

    // A secret planted in the EVIDENCE blocks the outbound call entirely.
    const secret = 'sk-or-v1-0123456789abcdef0123456789abcdef'
    let called = 0
    const blocked = await generateSkillDraft(
      { kind: 'manual', evidence: [{ type: 'tool-error', at: NOW(), detail: { toolName: secret } }] },
      draftDeps(s, 'on', () => {
        called++
        return GOOD_LLM()
      }),
    )
    assert.equal(blocked.status, 'refused')
    assert.equal(blocked.status === 'refused' ? blocked.reason : '', 'secret-gate')
    assert.equal(called, 0, 'the LLM was never reached')
    assert.equal(listSkillDrafts(s.drafts).length, 0)

    // A secret in the RESPONSE is blocked before any write.
    const responded = await generateSkillDraft(
      { kind: 'manual', evidence: [{ type: 'tool-error', at: NOW(), detail: {} }] },
      draftDeps(s, 'on', () => Promise.resolve(JSON.stringify({ name: 'leaky', description: `key sk-or-v1-0123456789abcdef0123456789abcdef`, whenToUse: 'w', body: 'b'.repeat(40) }))),
    )
    assert.equal(responded.status, 'refused')
    assert.equal(responded.status === 'refused' ? responded.reason : '', 'secret-gate')
    assert.equal(listSkillDrafts(s.drafts).length, 0, 'nothing leaked to disk')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('draft: daily cap refuses the second generation and ledgers it', async () => {
  const s = scratch()
  try {
    const deps = draftDeps(s, 'on')
    const first = await generateSkillDraft({ kind: 'manual', evidence: [{ type: 'tool-error', at: NOW(), detail: {} }] }, deps)
    assert.equal(first.status, 'created')
    const second = await generateSkillDraft({ kind: 'manual', evidence: [{ type: 'tool-error', at: NOW(), detail: {} }] }, deps)
    assert.equal(second.status, 'refused')
    assert.equal(second.status === 'refused' ? second.reason : '', 'daily-cap')
    assert.ok(DAILY_DRAFT_CAP === 1)
    const actions = lines(join(s.bundle, 'meta', 'improve-actions.jsonl')).filter((e) => e.kind === 'review')
    assert.equal(actions.filter((e) => e.action === 'draft-created').length, 1)
    assert.equal(actions.filter((e) => e.action === 'draft-daily-cap').length, 1)
    // The cap survives even if the live draft disappears (ledger account).
    rmSync(s.drafts, { recursive: true, force: true })
    const third = await generateSkillDraft({ kind: 'manual', evidence: [{ type: 'tool-error', at: NOW(), detail: {} }] }, deps)
    assert.equal(third.status, 'refused')
    assert.equal(third.status === 'refused' ? third.reason : '', 'daily-cap')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('draft: cluster trigger declines through the lane; no evidence refuses', async () => {
  const s = scratch()
  try {
    const declined = await generateSkillDraft({ kind: 'cluster', evidence: [] }, draftDeps(s, 'on'))
    assert.equal(declined.status, 'refused')
    assert.equal(declined.status === 'refused' ? declined.reason : '', 'trigger-declined')
    const empty = await generateSkillDraft({ kind: 'manual', evidence: [] }, draftDeps(s, 'on'))
    assert.equal(empty.status, 'refused')
    assert.equal(empty.status === 'refused' ? empty.reason : '', 'no-evidence')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// install protection + archive
// ---------------------------------------------------------------------------

function seedDraft(s, name) {
  const dir = join(s.drafts, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), renderSkillMd({ name, description: 'd', whenToUse: 'w', body: 'body text long enough' }, '7d: x1', '2026-10-10'))
  return dir
}

test('install: clean install moves the draft, keeps a backup, keeps the marker', () => {
  const s = scratch()
  try {
    seedDraft(s, 'my-skill')
    const outcome = installSkill('skill:my-skill', { gate: 'on', draftsRoot: s.drafts, skillsRoot: s.skills })
    assert.equal(outcome.status, 'installed')
    if (outcome.status !== 'installed') return
    assert.equal(outcome.adjusted, false)
    const installed = parseSkillMd(readFileSync(join(s.skills, 'my-skill', 'SKILL.md'), 'utf8'))
    assert.equal(installed.source, 'auto-generated', 'frontmatter marker fidelity')
    assert.equal(installed.name, 'my-skill')
    assert.ok(!existsSync(join(s.drafts, 'my-skill')), 'queue empties naturally')
    assert.ok(outcome.backupDir.startsWith(join(s.drafts, '.installed')), 'write-time backup in the drafts area')
    assert.equal(parseSkillMd(readFileSync(join(outcome.backupDir, 'SKILL.md'), 'utf8')).name, 'my-skill')
    assert.equal(listSkillDrafts(s.drafts).length, 0)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('install: never overwrites a hand-written skill — forced -auto suffix', () => {
  const s = scratch()
  try {
    const handwritten = ['# hand-written', '', 'my own steps', ''].join('\n')
    mkdirSync(join(s.skills, 'my-skill'), { recursive: true })
    writeFileSync(join(s.skills, 'my-skill', 'SKILL.md'), handwritten)
    seedDraft(s, 'my-skill')
    const outcome = installSkill('skill:my-skill', { gate: 'on', draftsRoot: s.drafts, skillsRoot: s.skills })
    assert.equal(outcome.status, 'installed')
    if (outcome.status !== 'installed') return
    assert.equal(outcome.adjusted, true)
    // Hand-written bytes untouched.
    assert.equal(readFileSync(join(s.skills, 'my-skill', 'SKILL.md'), 'utf8'), handwritten)
    // The auto copy got the -auto suffix in dir AND frontmatter name.
    const adjusted = parseSkillMd(readFileSync(join(s.skills, 'my-skill-auto', 'SKILL.md'), 'utf8'))
    assert.equal(adjusted.name, 'my-skill-auto')
    assert.equal(adjusted.source, 'auto-generated')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('install: -auto collision refuses with a merge hint; gate must be on; non-ours refused', () => {
  const s = scratch()
  try {
    mkdirSync(join(s.skills, 'my-skill'), { recursive: true })
    mkdirSync(join(s.skills, 'my-skill-auto'), { recursive: true })
    writeFileSync(join(s.skills, 'my-skill-auto', 'SKILL.md'), 'existing auto')
    seedDraft(s, 'my-skill')
    const collision = installSkill('skill:my-skill', { gate: 'on', draftsRoot: s.drafts, skillsRoot: s.skills })
    assert.equal(collision.status, 'refused')
    assert.equal(collision.status === 'refused' ? collision.reason : '', 'collision')
    assert.match(collision.status === 'refused' ? (collision.detail ?? '') : '', /合并/)

    const gated = installSkill('skill:my-skill', { gate: 'shadow', draftsRoot: s.drafts, skillsRoot: s.skills })
    assert.equal(gated.status, 'refused')
    assert.equal(gated.status === 'refused' ? gated.reason : '', 'gate')

    // A draft without our marker is never installable (hand-placed file).
    mkdirSync(join(s.drafts, 'foreign'), { recursive: true })
    writeFileSync(join(s.drafts, 'foreign', 'SKILL.md'), '---\nname: foreign\ndescription: x\n---\nbody')
    const foreign = installSkill('skill:foreign', { gate: 'on', draftsRoot: s.drafts, skillsRoot: s.skills })
    assert.equal(foreign.status, 'refused')
    assert.equal(foreign.status === 'refused' ? foreign.reason : '', 'not-ours')
    assert.ok(!existsSync(join(s.skills, 'foreign')), 'nothing installed')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('archive: reject moves the draft under .archived and out of the queue', () => {
  const s = scratch()
  try {
    seedDraft(s, 'my-skill')
    assert.equal(archiveDraft('skill:my-skill', { gate: 'shadow', draftsRoot: s.drafts }).status, 'refused')
    const outcome = archiveDraft('skill:my-skill', { gate: 'on', draftsRoot: s.drafts })
    assert.equal(outcome.status, 'archived')
    if (outcome.status !== 'archived') return
    assert.ok(outcome.dir.startsWith(join(s.drafts, '.archived')))
    assert.equal(parseSkillMd(readFileSync(join(outcome.dir, 'SKILL.md'), 'utf8')).name, 'my-skill')
    assert.equal(listSkillDrafts(s.drafts).length, 0)
    assert.equal(archiveDraft('skill:my-skill', { gate: 'on', draftsRoot: s.drafts }).status, 'refused')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// hint lessons (file-level direct bundle read)
// ---------------------------------------------------------------------------

test('hint lessons: file-level read lists only hint lessons', () => {
  const s = scratch()
  try {
    mkdirSync(join(s.bundle, 'topics'), { recursive: true })
    writeFileSync(join(s.bundle, 'topics', 'hint-one.md'), '---\ntitle: Hint One\ntype: lesson\nconfidence: hint\nscope: workspace\n---\n# Lesson\n\nbody')
    writeFileSync(join(s.bundle, 'topics', 'established-one.md'), '---\ntitle: Est\ntype: lesson\nconfidence: established\n---\nbody')
    writeFileSync(join(s.bundle, 'topics', 'plain-topic.md'), '---\ntitle: Plain\n---\nbody')
    writeFileSync(join(s.bundle, 'topics', 'deprecated-one.md'), '---\ntitle: Old\ntype: lesson\nconfidence: hint\nstatus: deprecated\n---\nbody')
    const hints = listHintLessons(s.bundle)
    assert.deepEqual(hints.map((h) => h.slug), ['hint-one'])
    assert.equal(hints[0].scope, 'workspace')
    assert.equal(listHintLessons(join(s.home, 'nope')).length, 0)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// command surface: gate three states + ledger discipline
// ---------------------------------------------------------------------------

function fakeCtx() {
  let registered
  const ctx = {
    on() {},
    inject(services, fn) {
      if (services.includes('commands')) fn({ commands: { register: (d) => (registered = d) }, effect: (f) => f() })
    },
  }
  return { ctx, def: () => registered }
}

async function invoke(def, rawInput, agentId = 'agent-1') {
  return def.handler({ commandId: 'cmd-1', agent: { id: agentId }, rawInput, attachments: [], signal: new AbortController().signal })
}

function reviewDeps(s, gate, extra = {}) {
  const ledgerFile = join(s.bundle, 'meta', 'improve-actions.jsonl')
  return {
    gate: () => gate,
    ledger: ledgerOn(ledgerFile),
    openPeer: async () => extra.peer,
    bundleRoot: () => s.bundle,
    draftsRoot: () => s.drafts,
    skillsRoot: () => s.skills,
    now: NOW,
    ...(extra.llm !== undefined ? { llm: extra.llm } : {}),
  }
}

test('command: OFF registers but the queue is suppressed, generation refused + ledgered', async () => {
  const s = scratch()
  try {
    const { ctx, def } = fakeCtx()
    await apply(ctx, { improveLoop: 'off' }, { openPeer: async () => undefined, bundleRoot: () => s.bundle, now: NOW })
    assert.ok(def(), 'the command IS registered under off')

    const deps = reviewDeps(s, 'off')
    const cmd = buildReviewCommand(deps)
    const list = await invoke(cmd, '')
    assert.match(list.text, /improveLoop=off/)
    assert.ok(!list.text.includes('skill:'), 'queue suppressed')

    const seed = seedDraft(s, 'my-skill')
    const show = await invoke(cmd, 'show skill:my-skill')
    assert.equal(show.kind, 'error')

    const approve = await invoke(cmd, 'approve skill:my-skill')
    assert.equal(approve.kind, 'error')
    assert.ok(!existsSync(join(s.skills, 'my-skill')), 'off never installs')

    const draft = await invoke(cmd, 'draft')
    assert.equal(draft.kind, 'error')
    assert.match(draft.text, /off/)

    const actions = lines(join(s.bundle, 'meta', 'improve-actions.jsonl')).filter((e) => e.kind === 'review')
    assert.ok(actions.some((e) => e.action === 'draft-gate-off' && e.gate === 'off'), 'generation refusal ledgered')
    assert.ok(actions.some((e) => e.action === 'mutation-gate-refused' && e.object === 'skill:my-skill'), 'mutation refusal ledgered')
    // Read-only suppressions (list/show) stay unledgered — no read spam.
    assert.ok(!actions.some((e) => e.action === 'queue-suppressed' || e.object === 'queue-read'))
    assert.ok(existsSync(seed), 'draft untouched')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('command: SHADOW drafts allowed, effecting mutations refused', async () => {
  const s = scratch()
  try {
    const deps = reviewDeps(s, 'shadow', { llm: GOOD_LLM })
    const cmd = buildReviewCommand(deps)
    new ActionLedger(join(s.bundle, 'meta', 'improve-actions.jsonl')).append({ at: NOW(), kind: 'signal', gate: 'shadow', sessionId: 's', type: 'tool-error', detail: { toolName: 'bash' } })

    const draft = await invoke(cmd, 'draft')
    assert.equal(draft.kind, 'success', 'shadow generates + self-checks')
    const queued = listSkillDrafts(s.drafts)
    assert.equal(queued.length, 1)

    const show = await invoke(cmd, `show ${queued[0].id}`)
    assert.equal(show.kind, 'success')
    assert.match(show.text, /证据摘要/)

    const approve = await invoke(cmd, `approve ${queued[0].id}`)
    assert.equal(approve.kind, 'error')
    assert.match(approve.text, /shadow/)
    assert.ok(!existsSync(join(s.skills, queued[0].name)), 'shadow never installs')

    const reject = await invoke(cmd, `reject ${queued[0].id}`)
    assert.equal(reject.kind, 'error')
    assert.equal(listSkillDrafts(s.drafts).length, 1, 'reject is an effecting mutation too')

    const actions = lines(join(s.bundle, 'meta', 'improve-actions.jsonl')).filter((e) => e.kind === 'review')
    assert.ok(actions.some((e) => e.action === 'draft-created' && e.gate === 'shadow'))
    assert.equal(actions.filter((e) => e.action === 'mutation-gate-refused').length, 2)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('command: ON approve installs with ledger rollback pointer; reject archives', async () => {
  const s = scratch()
  try {
    seedDraft(s, 'my-skill')
    const cmd = buildReviewCommand(reviewDeps(s, 'on'))
    const list = await invoke(cmd, '')
    assert.match(list.text, /skill:my-skill/)

    const approve = await invoke(cmd, 'approve skill:my-skill')
    assert.equal(approve.kind, 'success')
    assert.ok(existsSync(join(s.skills, 'my-skill', 'SKILL.md')))
    const actions = lines(join(s.bundle, 'meta', 'improve-actions.jsonl')).filter((e) => e.kind === 'review')
    const approved = actions.find((e) => e.action === 'approved')
    assert.equal(approved.object, 'skill:my-skill')
    assert.match(approved.rollback, /installed=/)
    assert.match(approved.rollback, /backup=/)

    seedDraft(s, 'second-skill')
    const reject = await invoke(cmd, 'reject skill:second-skill')
    assert.equal(reject.kind, 'success')
    const rejected = lines(join(s.bundle, 'meta', 'improve-actions.jsonl')).filter((e) => e.kind === 'review').find((e) => e.action === 'rejected')
    assert.match(rejected.rollback, /archived=/)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('command: skill approve collision lands as mutation-collision with merge hint', async () => {
  const s = scratch()
  try {
    mkdirSync(join(s.skills, 'my-skill'), { recursive: true })
    writeFileSync(join(s.skills, 'my-skill', 'SKILL.md'), 'hand-written')
    mkdirSync(join(s.skills, 'my-skill-auto'), { recursive: true })
    writeFileSync(join(s.skills, 'my-skill-auto', 'SKILL.md'), 'auto one')
    seedDraft(s, 'my-skill')
    const cmd = buildReviewCommand(reviewDeps(s, 'on'))
    const r = await invoke(cmd, 'approve skill:my-skill')
    assert.equal(r.kind, 'error')
    assert.match(r.text, /合并/)
    assert.equal(readFileSync(join(s.skills, 'my-skill', 'SKILL.md'), 'utf8'), 'hand-written')
    const actions = lines(join(s.bundle, 'meta', 'improve-actions.jsonl')).filter((e) => e.kind === 'review')
    assert.ok(actions.some((e) => e.action === 'mutation-collision'))
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('command: lesson approve walks the peer seam with the actor contract', async () => {
  const s = scratch()
  try {
    const calls = []
    const peer = {
      setLessonStatus: async (slug, to, opts) => {
        calls.push({ slug, to, actor: opts.actor })
        return { ok: true }
      },
    }
    const cmd = buildReviewCommand(reviewDeps(s, 'on', { peer }))
    const approve = await invoke(cmd, 'approve lesson:foo-bar', 'agent-77')
    assert.equal(approve.kind, 'success')
    assert.deepEqual(calls, [{ slug: 'foo-bar', to: 'established', actor: 'dsh-self-improve:agent-77' }])
    const approved = lines(join(s.bundle, 'meta', 'improve-actions.jsonl')).filter((e) => e.kind === 'review').find((e) => e.action === 'approved')
    assert.equal(approved.object, 'lesson:foo-bar')
    assert.match(approved.rollback, /seam=setLessonStatus/)

    const reject = await invoke(cmd, 'reject lesson:foo-bar', 'agent-77')
    assert.equal(reject.kind, 'success')
    assert.deepEqual(calls[1], { slug: 'foo-bar', to: 'removed', actor: 'dsh-self-improve:agent-77' })
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('command: lesson approve with a seam refusal maps to an error result', async () => {
  const s = scratch()
  try {
    const peer = { setLessonStatus: async () => ({ ok: false, reason: 'not-a-lesson' }) }
    const cmd = buildReviewCommand(reviewDeps(s, 'on', { peer }))
    const r = await invoke(cmd, 'approve lesson:plain-topic')
    assert.equal(r.kind, 'error')
    assert.match(r.text, /不是 lesson/)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('command: lesson approve without the peer degrades and ledgers', async () => {
  const s = scratch()
  try {
    const cmd = buildReviewCommand(reviewDeps(s, 'on', { peer: undefined }))
    const r = await invoke(cmd, 'approve lesson:foo')
    assert.equal(r.kind, 'error')
    assert.match(r.text, /topics-memory 不可用/)
    const actions = lines(join(s.bundle, 'meta', 'improve-actions.jsonl')).filter((e) => e.kind === 'review')
    assert.ok(actions.some((e) => e.action === 'mutation-degraded' && e.detail === 'topics-memory-unavailable'))
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('command: unknown subcommand and bad ids settle as errors, never throw', async () => {
  const s = scratch()
  try {
    const cmd = buildReviewCommand(reviewDeps(s, 'on'))
    assert.equal((await invoke(cmd, 'frobnicate')).kind, 'error')
    assert.equal((await invoke(cmd, 'show ../etc')).kind, 'error')
    assert.equal((await invoke(cmd, 'show')).kind, 'error')
    assert.equal((await invoke(cmd, 'show skill:missing-thing')).kind, 'error')
    const help = await invoke(cmd, 'help')
    assert.match(help.text, /improve-review/)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('command: red line ⑤ — planted conversation text never reaches draft, prompt or ledger', async () => {
  const s = scratch()
  try {
    const secret = 'TOP-SECRET-USER-CONFESSION'
    const file = join(s.bundle, 'meta', 'improve-actions.jsonl')
    new ActionLedger(file).append({ at: NOW(), kind: 'signal', gate: 'on', sessionId: 's', type: 'tool-error', detail: { toolName: 'bash', errorCode: 'E_X' } })
    let promptSeen = ''
    const deps = draftDeps(s, 'on', async (p) => {
      promptSeen = `${p.system}\n${p.user}`
      return GOOD_LLM()
    })
    const outcome = await generateSkillDraft({ kind: 'manual', evidence: [] }, deps)
    assert.equal(outcome.status, 'created')
    const onDisk = [file, outcome.status === 'created' ? outcome.file : ''].map((f) => (f !== '' && existsSync(f) ? readFileSync(f, 'utf8') : '')).join('\n')
    assert.ok(!onDisk.includes(secret), 'ledger and draft are clean')
    assert.ok(!promptSeen.includes(secret), 'the prompt carried counts only')
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})

test('command: the real host path — apply with inject registers exactly one command', async () => {
  const s = scratch()
  try {
    const registrations = []
    const ctx = {
      on() {},
      inject(services, fn) {
        if (services.includes('commands')) fn({ commands: { register: (d) => registrations.push(d) }, effect: (f) => f() })
      },
    }
    await apply(ctx, { improveLoop: 'shadow' }, { openPeer: async () => undefined, bundleRoot: () => s.bundle, now: NOW })
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].name, 'improve-review')
    assert.match(registrations[0].description, /审批队列/)
    assert.ok(typeof registrations[0].handler === 'function')
    assert.equal(registrations[0].input.hint.includes('draft'), true)
  } finally {
    rmSync(s.home, { recursive: true, force: true })
  }
})
