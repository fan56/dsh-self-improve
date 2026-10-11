/**
 * The skills draft generator (wave N3, spec 卷二 §4.2 + B3 决议 2): signals →
 * structured脱敏 evidence → LLM-drafted SKILL.md → shadow self-check gate →
 * `~/.dsh/skills-drafts/<name>/SKILL.md` (isolated from hand-written skills).
 *
 * Triggers (spec §4.1, BL-3 revised):
 *   - `cluster` — the N2 trigger engine's input shape: only requests the
 *     engine (triggers.ts) CLEARED — full BL-3 conjunction passed — reach the
 *     generation path; uncleared cluster requests decline with
 *     `cluster-not-cleared` so the lane alone stays incapable of auto drafts.
 *   - `manual`  — `/improve-review draft`: the LAST 7 DAYS of `signal` lines
 *     from the action ledger become the evidence, so the whole loop is
 *     verifiable on a real machine without waiting for a cluster.
 *
 * Red lines enforced in this module:
 *   ③ secret gate — the FULL outbound LLM body is scanned against the local
 *      credentials refs and generic token shapes; a hit blocks the call (and
 *      the generated text is re-scanned before anything is written).
 *   ⑤ conversation text never leaves the process — the evidence is a
 *      counts-only summary of whitelisted feature fields (toolName/errorCode/
 *      reason/trigger/…), never any message/argument/error body.
 *   ④ every draft carries `source: auto-generated` — machine-stamped here,
 *      never taken from model output, so installed copies stay identifiable
 *      and uninstall-recyclable.
 *
 * Failure posture: every refusal is ledgered (`draft-*` review actions) and
 * the lane never throws into its caller (red line ②).
 *
 * @module skill-draft
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ActionLedger, ReviewAction } from './ledger.ts'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `$DSH_HOME` → `~/.dsh` (same base ladder as feed.resolveImproveBundleRoot). */
export function resolveDshHome(): string {
  const dshHome = process.env.DSH_HOME?.trim()
  return dshHome !== undefined && dshHome !== '' ? dshHome : join(homedir(), '.dsh')
}

/** Draft area — isolated from hand-written skills (B3 决议 2). */
export function defaultDraftsRoot(): string {
  return join(resolveDshHome(), 'skills-drafts')
}

/** Install target the host filesystem provider watches (B3 决议 4). */
export function defaultSkillsRoot(): string {
  return join(resolveDshHome(), 'skills')
}

// ---------------------------------------------------------------------------
// Skill-name grammar (host dsh-skill SKILL_NAME, copied verbatim)
// ---------------------------------------------------------------------------

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const SKILL_NAME_MAX = 64

// ---------------------------------------------------------------------------
// Secret gate (red line ③) — credential refs + generic token shapes
// ---------------------------------------------------------------------------

/** Generic outbound secret shapes (the jev decide scanner's family). */
const SECRET_PATTERNS: [string, RegExp][] = [
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ['openai-key', /\bsk-proj-[A-Za-z0-9_-]{20,}\b/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['openrouter-key', /\bsk-or-v1-[A-Za-z0-9]{20,}\b/],
  ['generic-sk', /\bsk-[A-Za-z0-9]{28,}\b/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{30,}\b/],
  ['gitlab-pat', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['aws-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['google-key', /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ['pem-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]

/**
 * Scan text for the local credentials values and generic token shapes.
 * Returns the first matched label, or undefined when clean. The credentials
 * file is read best-effort on every call (no cache) — it is tiny and this
 * lane is cold.
 */
export function scanSecrets(text: string, credentialsFile: string = join(resolveDshHome(), '.credentials.yaml')): string | undefined {
  for (const [label, re] of SECRET_PATTERNS) {
    if (re.test(text)) return label
  }
  // Local credential ref VALUES: any occurrence of a configured secret in an
  // outbound body is a block, regardless of shape.
  try {
    const raw = readFileSync(credentialsFile, 'utf8')
    for (const m of raw.matchAll(/^  ([A-Z0-9_]+): (\S{8,})$/gm)) {
      const name = m[1] ?? ''
      const value = m[2] ?? ''
      if (value.length >= 12 && text.includes(value)) return `credentials-ref:${name}`
    }
  } catch {
    // No credentials file — only the generic shapes apply.
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Evidence: counts-only summary of whitelisted ledger signal lines (红线⑤)
// ---------------------------------------------------------------------------

/** The evidence window of the manual trigger, in days. */
export const MANUAL_WINDOW_DAYS = 7
/** Cap on the evidence summary length (feature tokens stay bounded). */
export const EVIDENCE_MAX_CHARS = 600
/** Detail fields eligible for the summary, with unambiguous short prefixes. */
const EVIDENCE_DETAIL_KEYS: [key: string, prefix: string][] = [
  ['toolName', 'tool'],
  ['errorName', 'err'],
  ['errorCode', 'code'],
  ['reason', 'why'],
  ['trigger', 'trig'],
  ['count', 'n'],
  ['slug', 'id'],
]

export interface EvidenceSignal {
  type: string
  at: string
  detail?: Record<string, unknown>
}

/**
 * Distill signal lines into one counts-only line:
 * `7d: tool-error x4 [tool=bash/code=EACCES x2, tool=bash/code=EPERM x1]; repeat-call x2 [tool=bash x2]`.
 * Only the whitelisted detail keys may appear (unambiguous short prefixes);
 * values are truncated; the whole summary is capped. No message text, no
 * arguments, no error bodies.
 */
export function summarizeEvidence(signals: readonly EvidenceSignal[], windowDays: number = MANUAL_WINDOW_DAYS): string {
  const groups = new Map<string, number>()
  for (const s of signals) {
    const feats: string[] = []
    const detail = s.detail
    if (detail !== undefined && typeof detail === 'object') {
      for (const [key, prefix] of EVIDENCE_DETAIL_KEYS) {
        const v = detail[key]
        if (typeof v === 'string' && v !== '') feats.push(`${prefix}=${v.slice(0, 40)}`)
        else if (typeof v === 'number' && Number.isFinite(v)) feats.push(`${prefix}=${String(Math.trunc(v))}`)
      }
    }
    const key = feats.length > 0 ? `${s.type} (${feats.join(',')})` : s.type
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  const parts = [...groups.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([key, n]) => `${key} x${n}`)
  let line = `${windowDays}d: ${parts.join('; ')}`
  if (line.length > EVIDENCE_MAX_CHARS) line = line.slice(0, EVIDENCE_MAX_CHARS - 1) + '…'
  return line
}

/**
 * The manual trigger's evidence source: `signal` lines from the action ledger
 * inside the trailing window. Unreadable/missing ledger → empty evidence
 * (the draft lane then refuses with `no-evidence` — an empty draft is noise).
 */
export function recentSignals(ledgerFile: string, nowIso: string, windowDays: number = MANUAL_WINDOW_DAYS): EvidenceSignal[] {
  let raw: string
  try {
    raw = readFileSync(ledgerFile, 'utf8')
  } catch {
    return []
  }
  let cutoff: number
  try {
    cutoff = Date.parse(nowIso) - windowDays * 24 * 60 * 60 * 1000
  } catch {
    return []
  }
  const out: EvidenceSignal[] = []
  for (const line of raw.split('\n')) {
    if (line === '') continue
    try {
      const entry = JSON.parse(line) as { kind?: unknown; at?: unknown; type?: unknown; detail?: unknown }
      if (entry.kind !== 'signal' || typeof entry.at !== 'string' || typeof entry.type !== 'string') continue
      const at = Date.parse(entry.at)
      if (!Number.isFinite(at) || at < cutoff) continue
      out.push({
        type: entry.type,
        at: entry.at,
        ...(entry.detail !== undefined && typeof entry.detail === 'object' && entry.detail !== null
          ? { detail: entry.detail as Record<string, unknown> }
          : {}),
      })
    } catch {
      // One malformed line never sinks the evidence (红线②).
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Trigger interface (N2 fills the engine; the shape is pinned here)
// ---------------------------------------------------------------------------

export interface SkillTriggerInput {
  /** `cluster` = N2's automatic lane; `manual` = the human `/improve-review draft` path. */
  kind: 'cluster' | 'manual'
  /** Feature-only observations backing the request (never conversation text). */
  evidence: readonly EvidenceSignal[]
  /** N2 union extension: cluster context. Only the trigger engine (triggers.ts)
   *  stamps `cleared: true` — after the full BL-3 conjunction passed. A cluster
   *  request without engine clearance is declined, so the draft lane alone can
   *  never be talked into an automatic draft (the N1 stub's safety property,
   *  preserved). */
  cluster?: { key: string; count: number; cleared: boolean }
}

export interface TriggerDecision {
  triggered: boolean
  reason: string
}

/**
 * The cluster-lane decision, N2 edition: manual passes (a human asked);
 * a cluster request needs engine clearance AND the threshold count. The
 * BL-3 conjunction itself (clustering + lesson word-face + recurrence) lives
 * in triggers.ts — this guard only re-verifies what the engine stamped.
 */
export function evaluateSkillTrigger(input: SkillTriggerInput, opts: { windowDays: number; threshold: number }): TriggerDecision {
  if (input.kind === 'manual') return { triggered: true, reason: 'manual' }
  const c = input.cluster
  if (c === undefined || c.cleared !== true) return { triggered: false, reason: 'cluster-not-cleared' }
  if (c.count < opts.threshold) return { triggered: false, reason: 'cluster-below-threshold' }
  return { triggered: true, reason: 'cluster-bl3-passed' }
}

// ---------------------------------------------------------------------------
// LLM route (a6 backfill precedent, verified 2026-10-11: HTTP 200)
// ---------------------------------------------------------------------------

export const DRAFT_LLM_ENDPOINT = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'
export const DRAFT_LLM_MODEL = 'glm-5.3-flash'
export const DRAFT_LLM_CREDENTIAL_REF = 'ZAI_CODING_CN_API_KEY'
export const DRAFT_LLM_TIMEOUT_MS = 30_000

export type LlmFn = (req: { system: string; user: string }) => Promise<string>

/**
 * Read one ref value out of `~/.dsh/.credentials.yaml` — a minimal top-level
 * `refs:` block parser (two-space indented `KEY: value` lines), the same
 *取证 path the A6 backfill used. The value never enters any ledger or draft.
 */
export function readCredentialRef(name: string, credentialsFile: string = join(resolveDshHome(), '.credentials.yaml')): string | undefined {
  try {
    const raw = readFileSync(credentialsFile, 'utf8')
    const m = new RegExp(`^  ${name}: (\\S+)\\s*$`, 'm').exec(raw)
    return m?.[1]
  } catch {
    return undefined
  }
}

/** The default route: zai-coding-cn glm-5.3-flash, thinking off (a6 precedent). */
export const bigmodelLlm: LlmFn = async ({ system, user }) => {
  const key = readCredentialRef(DRAFT_LLM_CREDENTIAL_REF)
  if (key === undefined) throw new Error('no-credential')
  const res = await fetch(DRAFT_LLM_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: DRAFT_LLM_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      thinking: { type: 'disabled' },
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(DRAFT_LLM_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`llm-http-${res.status}`)
  const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] }
  const content = body.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim() === '') throw new Error('llm-empty-response')
  return content
}

// ---------------------------------------------------------------------------
// Draft assembly + shadow self-check gate (B3 决议 2: 不过不进队列)
// ---------------------------------------------------------------------------

export interface DraftParts {
  name: string
  description: string
  whenToUse: string
  body: string
}

const DRAFT_SYSTEM_PROMPT = [
  'You draft a SKILL.md for the dsh agent-skills system from anonymized failure statistics.',
  'Reply with ONE JSON object and nothing else:',
  '{"name":"kebab-case-name","description":"one line (<=120 chars)","whenToUse":"when the agent should load this (<=120 chars)","body":"full markdown body of the skill"}',
  'Rules: name matches /^[a-z0-9]+(-[a-z0-9]+)*$/; description and whenToUse are concrete, not generic;',
  'body is a practical playbook (steps, checks, pitfalls) of 15-60 lines derived from the evidence pattern;',
  'never invent session content, user quotes or file paths not present in the evidence.',
].join('\n')

export function buildDraftPrompt(evidenceSummary: string): { system: string; user: string } {
  return {
    system: DRAFT_SYSTEM_PROMPT,
    user: `Failure-signal statistics for the last days (counts and machine features ONLY — no conversation text exists upstream):\n${evidenceSummary}\n\nDraft the SKILL.md JSON now.`,
  }
}

/** Tolerant JSON extraction: bare object, or the first fenced ```json block. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text)
  const candidate = fenced !== null ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('no-json-object')
  return JSON.parse(candidate.slice(start, end + 1))
}

function str(v: unknown, cap: number): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, cap) : undefined
}

export const DRAFT_BODY_MIN_CHARS = 30
export const DRAFT_BODY_MAX_CHARS = 20_000
export const DRAFT_FIELD_MAX_CHARS = 200

/**
 * The shadow self-check gate (Voyager 思想): structure complete + references
 * exist. Reasons are machine codes for the ledger, never model text.
 */
export function checkDraft(text: string): { ok: true; parts: DraftParts } | { ok: false; reasons: string[] } {
  const reasons: string[] = []
  let parsed: unknown
  try {
    parsed = extractJson(text)
  } catch {
    return { ok: false, reasons: ['unparseable-response'] }
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, reasons: ['not-an-object'] }
  const obj = parsed as Record<string, unknown>
  const name = str(obj.name, SKILL_NAME_MAX)
  const description = str(obj.description, DRAFT_FIELD_MAX_CHARS)
  const whenToUse = str(obj.whenToUse, DRAFT_FIELD_MAX_CHARS)
  const body = str(obj.body, DRAFT_BODY_MAX_CHARS)
  if (name === undefined) reasons.push('missing-name')
  else if (!SKILL_NAME_RE.test(name)) reasons.push('invalid-name')
  if (description === undefined) reasons.push('missing-description')
  if (whenToUse === undefined) reasons.push('missing-when-to-use')
  if (body === undefined) reasons.push('missing-body')
  else if (body.length < DRAFT_BODY_MIN_CHARS) reasons.push('body-too-short')
  if (reasons.length > 0) return { ok: false, reasons }
  return { ok: true, parts: { name: name as string, description: description as string, whenToUse: whenToUse as string, body: body as string } }
}

/** YAML-safe double-quoted scalar (valid YAML double-quoted flow scalar). */
function yq(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`
}

/** Machine-stamped frontmatter — `source` is OURS, never model output (红线④). */
export function renderSkillMd(parts: DraftParts, evidenceSummary: string, createdDate: string): string {
  return [
    '---',
    `name: ${yq(parts.name)}`,
    `description: ${yq(parts.description)}`,
    `whenToUse: ${yq(parts.whenToUse)}`,
    'source: auto-generated',
    `created: ${yq(createdDate)}`,
    `evidence: ${yq(evidenceSummary)}`,
    '---',
    '',
    parts.body.replace(/\s+$/u, ''),
    '',
  ].join('\n')
}

export interface ParsedSkillMd {
  name?: string
  description?: string
  whenToUse?: string
  source?: string
  created?: string
  evidence?: string
}

/** Minimal frontmatter reader for our own drafts and collision checks. */
export function parseSkillMd(text: string): ParsedSkillMd | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(text)
  if (m === null) return undefined
  const out: ParsedSkillMd = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9]*): (.*)$/u.exec(line)
    if (kv === null) continue
    let v = kv[2] ?? ''
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    const key = kv[1]
    if (key === 'name' || key === 'description' || key === 'whenToUse' || key === 'source' || key === 'created' || key === 'evidence') {
      out[key] = v
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Daily cap (B4 决议 2: 每日 skill 草稿 ≤1)
// ---------------------------------------------------------------------------

export const DAILY_DRAFT_CAP = 1

function todayOf(iso: string): string {
  return iso.slice(0, 10)
}

/** Live drafts dated today (dir scan — the queue's own source of truth). */
function draftsToday(draftsRoot: string, today: string): number {
  let n = 0
  let names: string[]
  try {
    names = readdirSync(draftsRoot)
  } catch {
    return 0
  }
  for (const dir of names) {
    if (dir.startsWith('.')) continue
    try {
      const text = readFileSync(join(draftsRoot, dir, 'SKILL.md'), 'utf8')
      if (parseSkillMd(text)?.created === today) n++
    } catch {
      // Unreadable entry is not a draft.
    }
  }
  return n
}

/** Draft-generation review actions counted today (the ledger account). */
function ledgerDraftsToday(ledger: ActionLedger, today: string): number {
  let raw: string
  try {
    raw = readFileSync(ledger.path, 'utf8')
  } catch {
    return 0
  }
  let n = 0
  for (const line of raw.split('\n')) {
    if (line === '') continue
    try {
      const e = JSON.parse(line) as { kind?: unknown; action?: unknown; at?: unknown }
      if (e.kind === 'review' && e.action === 'draft-created' && typeof e.at === 'string' && todayOf(e.at) === today) n++
    } catch {
      // Contained.
    }
  }
  return n
}

// ---------------------------------------------------------------------------
// The draft lane
// ---------------------------------------------------------------------------

export type DraftOutcome =
  | { status: 'created'; name: string; file: string; evidence: string }
  | {
      status: 'refused'
      reason: 'gate-off' | 'daily-cap' | 'secret-gate' | 'check-failed' | 'no-evidence' | 'trigger-declined' | 'write-failed' | 'collision' | 'llm-failed'
      detail?: string
    }

/** Refusal reason → the closed ledger action code. */
const REFUSAL_ACTION: Record<Exclude<DraftOutcome & { status: 'refused' }, never>['reason'], ReviewAction> = {
  'gate-off': 'draft-gate-off',
  'daily-cap': 'draft-daily-cap',
  'secret-gate': 'draft-secret-blocked',
  'check-failed': 'draft-check-failed',
  'no-evidence': 'draft-no-evidence',
  'trigger-declined': 'draft-trigger-declined',
  'write-failed': 'draft-write-failed',
  collision: 'draft-collision',
  'llm-failed': 'draft-llm-failed',
}

export interface SkillDraftDeps {
  /** Loop gate as of NOW (volatile hot-flip aware). */
  gate(): 'off' | 'shadow' | 'on'
  ledger: ActionLedger
  ledgerFile(): string
  draftsRoot(): string
  now(): string
  llm?: LlmFn
}

/**
 * One draft-generation attempt for `input`. Refusals are ledgered review
 * actions; the lane never throws (红线②). Generation is allowed in shadow
 * AND on (risk-free per B4 决议 1 — a draft affects nothing), refused in off.
 */
export async function generateSkillDraft(input: SkillTriggerInput, deps: SkillDraftDeps): Promise<DraftOutcome> {
  const at = deps.now()
  const refuse = (reason: keyof typeof REFUSAL_ACTION, detail?: string): DraftOutcome => {
    deps.ledger.append({ at, kind: 'review', gate: deps.gate(), action: REFUSAL_ACTION[reason], object: 'queue', ...(detail !== undefined ? { detail: detail.slice(0, 128) } : {}) })
    return { status: 'refused', reason, ...(detail !== undefined ? { detail } : {}) }
  }

  if (deps.gate() === 'off') return refuse('gate-off')
  if (input.kind === 'cluster') {
    const decision = evaluateSkillTrigger(input, { windowDays: MANUAL_WINDOW_DAYS, threshold: 3 })
    if (!decision.triggered) return refuse('trigger-declined', decision.reason)
  }

  const today = todayOf(at)
  const createdToday = Math.max(draftsToday(deps.draftsRoot(), today), ledgerDraftsToday(deps.ledger, today))
  if (createdToday >= DAILY_DRAFT_CAP) return refuse('daily-cap', `count=${createdToday}`)

  const signals = input.evidence.length > 0 ? [...input.evidence] : recentSignals(deps.ledgerFile(), at)
  if (signals.length === 0) return refuse('no-evidence')
  const evidence = summarizeEvidence(signals)

  const llm = deps.llm ?? bigmodelLlm
  const prompt = buildDraftPrompt(evidence)
  const outbound = `${prompt.system}\n${prompt.user}`
  const secretHit = scanSecrets(outbound)
  if (secretHit !== undefined) return refuse('secret-gate', `outbound:${secretHit}`)

  let response: string
  try {
    response = await llm(prompt)
  } catch (e) {
    return refuse('llm-failed', e instanceof Error ? e.message.slice(0, 64) : 'unknown')
  }
  const responseHit = scanSecrets(response)
  if (responseHit !== undefined) return refuse('secret-gate', `response:${responseHit}`)

  const check = checkDraft(response)
  if (!check.ok) return refuse('check-failed', check.reasons.join(','))

  const md = renderSkillMd(check.parts, evidence, today)
  const dir = join(deps.draftsRoot(), check.parts.name)
  if (existsSync(dir)) {
    const existing = (() => {
      try {
        return parseSkillMd(readFileSync(join(dir, 'SKILL.md'), 'utf8'))?.source
      } catch {
        return undefined
      }
    })()
    // Only OUR OWN regenerable drafts may be re-drafted over; anything else
    // (a hand-placed file, or source we cannot confirm) is never touched.
    if (existing !== 'auto-generated') return refuse('collision', check.parts.name)
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), md)
  } catch {
    return refuse('write-failed', check.parts.name)
  }
  deps.ledger.append({ at, kind: 'review', gate: deps.gate(), action: 'draft-created', object: `skill:${check.parts.name}` })
  return { status: 'created', name: check.parts.name, file: join(dir, 'SKILL.md'), evidence }
}
