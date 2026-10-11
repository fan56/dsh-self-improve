/**
 * The skill-upgrade trigger engine (wave N2, spec 卷二 §4.1 + BL-3 revision)
 * — the loop's "WHEN to learn" decision center.
 *
 *   ledger signals ──▶ cluster tool-errors by (toolName, code) over the
 *                      7-day sliding window ──▶ ≥3 = same-class candidate
 *                        ──▶ BL-3 conjunction:
 *                              candidate ∧ ( NO related established lesson
 *                                            ∨ related lesson STILL RECURRING )
 *                                ├─ pass → fire (N3 draft lane, daily ≤1)
 *                                └─ fail → no-fire, both ledgered
 *
 * Data sources (file-level reads, the N1 direct-construction style):
 *   - the action ledger `meta/improve-actions.jsonl` (N1's own signal lines
 *     + the review rows that timestamp lesson approvals);
 *   - the peer bundle's established-lesson roster (lessonsSync — established
 *     only, MJ-3) + its 30-day ilog hits/opens (annotation only). Peer absent
 *     → empty roster → the BL-3 blind-spot branch applies (§6.3: the skills
 *     loop is fully usable without the peer).
 *
 * The interruption fast lane (B2 决议 3② + MJ-1) lives here too: an
 * interruption-pair signal immediately produces a PLACEHOLDER hint lesson
 * (condition=「用户在 turn N 打断了助手」, action 待蒸馏批次补全, marked
 * `pending-refine`) through the peer's lesson data plane. v1 boundary
 * (recorded): the interruption pair carries a POSITION, not content —
 * conversation text never enters any ledger (红线⑤), and the LLM cold-read
 * refinement of the placeholder is a later integration wave (N4+). Every
 * session ≤3 hint drafts (B4 决议 2 + MJ-3).
 *
 * Gate semantics (spec §7 MJ-A): off = the engine never runs (zero reads);
 * shadow = full computation, would-fire ledger rows only, nothing fires and
 * no hint draft is produced; on = everything.
 *
 * @module triggers
 */

import { readFileSync } from 'node:fs'

import type { ActionLedger, TriggerReason } from './ledger.ts'
import type { PeerHandle, PeerLessonEntry } from './feed.ts'
import type { DraftOutcome, EvidenceSignal, SkillTriggerInput } from './skill-draft.ts'

/** B3 决议 1: the same-class failure window, in days. */
export const TRIGGER_WINDOW_DAYS = 7
/** B3 决议 1: same-class failures inside the window to become a candidate. */
export const TRIGGER_THRESHOLD = 3
/** Task-N2 cadence: at most one engine scan per session per minute. */
export const SCAN_THROTTLE_MS = 60_000
/** B4 决议 2 + MJ-3: automatic hint drafts per session. */
export const HINT_CAP_PER_SESSION = 3
/** The pending-refinement marker carried in a placeholder hint's triggers. */
export const HINT_PENDING_REFINE = 'pending-refine'

// ---------------------------------------------------------------------------
// Ledger reading (bounded, tolerant — one malformed line never sinks a scan)
// ---------------------------------------------------------------------------

export interface LedgerEntryView {
  kind: string
  at: string
  gate?: string
  type?: string
  detail?: Record<string, unknown>
  sessionId?: string
  action?: string
  object?: string
  fired?: boolean
  key?: string
  count?: number
  reason?: string
}

/** Read every ledger entry best-effort; unreadable file → empty (红线②). */
export function readLedger(file: string): LedgerEntryView[] {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: LedgerEntryView[] = []
  for (const line of raw.split('\n')) {
    if (line === '') continue
    try {
      const e = JSON.parse(line) as Record<string, unknown>
      if (e.kind !== 'signal' && e.kind !== 'review' && e.kind !== 'trigger' && e.kind !== 'hint') continue
      if (typeof e.at !== 'string') continue
      out.push(e as unknown as LedgerEntryView)
    } catch {
      // Contained.
    }
  }
  return out
}

/** The windowed whitelist signal lines (the engine's evidence pool). */
export function windowedSignals(entries: readonly LedgerEntryView[], nowIso: string, windowDays: number = TRIGGER_WINDOW_DAYS): EvidenceSignal[] {
  const cutoff = Date.parse(nowIso) - windowDays * 24 * 60 * 60 * 1000
  if (!Number.isFinite(cutoff)) return []
  const out: EvidenceSignal[] = []
  for (const e of entries) {
    if (e.kind !== 'signal' || typeof e.type !== 'string') continue
    const at = Date.parse(e.at)
    if (!Number.isFinite(at) || at < cutoff) continue
    out.push({
      type: e.type,
      at: e.at,
      ...(e.detail !== undefined && typeof e.detail === 'object' ? { detail: e.detail } : {}),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Clustering: tool-error × (toolName, code) over the sliding window
// ---------------------------------------------------------------------------

export interface FailureCluster {
  /** `toolName/code` — code = errorCode, errorName fallback, `-` if neither. */
  key: string
  toolName: string
  code: string
  count: number
  /** The cluster's own signals — the fired draft's evidence (feature-only). */
  signals: EvidenceSignal[]
  lastAt: string
}

/**
 * Group tool-error signals by (toolName, code), count-desc (deterministic
 * fire order). The code identity is the errorCode with the errorName as
 * fallback (`-` when neither exists) — both whitelist features already
 * capped by the collector; raw error text does not exist upstream (红线⑤).
 */
export function clusterToolErrors(signals: readonly EvidenceSignal[]): FailureCluster[] {
  const groups = new Map<string, FailureCluster>()
  for (const s of signals) {
    if (s.type !== 'tool-error') continue
    const d = s.detail ?? {}
    const toolName = typeof d.toolName === 'string' && d.toolName !== '' ? d.toolName : 'unknown'
    const code =
      typeof d.errorCode === 'string' && d.errorCode !== ''
        ? d.errorCode
        : typeof d.errorName === 'string' && d.errorName !== ''
          ? d.errorName
          : '-'
    const key = `${toolName}/${code}`
    const g = groups.get(key) ?? { key, toolName, code, count: 0, signals: [], lastAt: '' }
    g.count++
    g.signals.push(s)
    if (s.at > g.lastAt) g.lastAt = s.at
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1))
}

// ---------------------------------------------------------------------------
// BL-3: related established lessons + the conjunction
// ---------------------------------------------------------------------------

/**
 * Word-face tokens: ASCII alphanumeric runs (≥2 chars) plus CJK runs — the
 * literal-overlap vocabulary for 「无相关 lesson」. Feature values only,
 * taken from the roster's own frontmatter fields.
 */
export function tokensOf(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+|[\u4e00-\u9fff]+/gu)) {
    const t = m[0]
    if (t.length >= 2) out.add(t)
  }
  return out
}

/** Lesson side of the word-face check: triggers + title (roster fields). */
function lessonTokens(lesson: PeerLessonEntry): Set<string> {
  const out = new Set<string>()
  for (const p of [lesson.title ?? '', ...(lesson.triggers ?? [])]) for (const t of tokensOf(p)) out.add(t)
  return out
}

/**
 * The 「相关 established lesson」 test: any word-face token of the cluster
 * key (toolName / code) appears in the lesson's triggers or title.
 */
export function relatedLessons(cluster: FailureCluster, lessons: readonly PeerLessonEntry[]): PeerLessonEntry[] {
  const keyTokens = new Set<string>([...tokensOf(cluster.toolName), ...tokensOf(cluster.code)])
  return lessons.filter((l) => {
    const lt = lessonTokens(l)
    for (const t of keyTokens) if (lt.has(t)) return true
    return false
  })
}

export interface ClusterDecision {
  cluster: FailureCluster
  related: PeerLessonEntry[]
  /** The BL-3 branch taken (closed vocabulary, mirrors the ledger reason). */
  reason: TriggerReason
  wouldFire: boolean
}

/**
 * One candidate's BL-3 verdict. 仍复发 (still recurring) = at least one
 * clustered failure is NEWER than the lesson's approval, where the approval
 * time comes from the ledger's own `review.approved object=lesson:<slug>`
 * rows. A lesson with no approval row on record (approved by another actor,
 * or before this ledger existed) predates the trailing window for decision
 * purposes — the window's failures are then already post-approval, so the
 * recurrence holds.
 */
export function decideCluster(cluster: FailureCluster, related: readonly PeerLessonEntry[], approvedAtOf: (slug: string) => string | undefined): ClusterDecision {
  if (related.length === 0) {
    return { cluster, related: [], reason: 'bl3-no-lesson', wouldFire: true }
  }
  const recurring = related.some((l) => {
    const approvedAt = approvedAtOf(l.slug)
    if (approvedAt === undefined) return true
    const t = Date.parse(approvedAt)
    if (!Number.isFinite(t)) return true
    return cluster.signals.some((s) => Date.parse(s.at) > t)
  })
  return recurring
    ? { cluster, related: [...related], reason: 'bl3-lesson-recurring', wouldFire: true }
    : { cluster, related: [...related], reason: 'bl3-lesson-holds', wouldFire: false }
}

/** Latest `approved` review row for `lesson:<slug>` in the ledger. */
export function approvedAtOf(entries: readonly LedgerEntryView[], slug: string): string | undefined {
  let found: string | undefined
  for (const e of entries) {
    if (e.kind === 'review' && e.action === 'approved' && e.object === `lesson:${slug}` && typeof e.at === 'string') found = e.at
  }
  return found
}

// ---------------------------------------------------------------------------
// The daily fire cap (B4 决议 2: 每日 ≤1 — the engine pre-checks so a spent
// day records `already-fired-today` instead of spamming draft-lane refusals)
// ---------------------------------------------------------------------------

export function hasFiredToday(entries: readonly LedgerEntryView[], nowIso: string): boolean {
  const today = nowIso.slice(0, 10)
  return entries.some((e) => {
    const firedRow = (e.kind === 'trigger' && e.fired === true) || (e.kind === 'review' && e.action === 'draft-created')
    return firedRow && typeof e.at === 'string' && e.at.slice(0, 10) === today
  })
}

// ---------------------------------------------------------------------------
// The engine scan
// ---------------------------------------------------------------------------

export interface TriggerScanDeps {
  /** Loop gate as of NOW — re-read at fire time (hot-flip aware: a
   *  shadow→off flip mid-scan must not fire). */
  gate(): 'off' | 'shadow' | 'on'
  ledger: ActionLedger
  ledgerFile(): string
  openPeer(): Promise<PeerHandle | undefined>
  now(): string
  /** The N3 draft lane, pre-wired with its deps (injected for tests). */
  generate(input: SkillTriggerInput): Promise<DraftOutcome>
  windowDays?: number
  threshold?: number
}

export interface TriggerScanResult {
  status: 'no-candidates' | 'scanned'
  decisions: ClusterDecision[]
  /** The draft-lane outcome when a fire happened (gate=on, cap unspent). */
  fired?: { key: string; outcome: DraftOutcome }
}

/**
 * One engine scan. Every CANDIDATE (threshold-passing cluster) lands a
 * `trigger` ledger row — fire and no-fire alike; scans with no candidates
 * are read-only (a per-minute scan must not churn the ledger with noise).
 * shadow rows are the would-fire band: `wouldFire: true, fired: false`.
 */
export async function scanTriggers(deps: TriggerScanDeps): Promise<TriggerScanResult> {
  const now = deps.now()
  const windowDays = deps.windowDays ?? TRIGGER_WINDOW_DAYS
  const threshold = deps.threshold ?? TRIGGER_THRESHOLD

  const entries = readLedger(deps.ledgerFile())
  const signals = windowedSignals(entries, now, windowDays)
  const candidates = clusterToolErrors(signals).filter((c) => c.count >= threshold)
  if (candidates.length === 0) return { status: 'no-candidates', decisions: [] }

  const peer = await deps.openPeer().catch(() => undefined)
  const roster = peer?.lessons() ?? []
  const decisions = candidates.map((c) => decideCluster(c, relatedLessons(c, roster), (slug) => approvedAtOf(entries, slug)))

  const spent = hasFiredToday(entries, now)
  const wouldTarget = decisions.find((d) => d.wouldFire)
  const fireTarget = spent ? undefined : wouldTarget
  const gateAtFire = deps.gate()
  const fire = gateAtFire === 'on' && fireTarget !== undefined

  for (const d of decisions) {
    const isTarget = fireTarget !== undefined && d.cluster.key === fireTarget.cluster.key
    // Reason vocabulary: the branch decision, except a would-be fire target
    // on an already-spent day records the cap as the operative cause.
    const isWouldTarget = wouldTarget !== undefined && d.cluster.key === wouldTarget.cluster.key
    const reason: TriggerReason = isWouldTarget && spent ? 'already-fired-today' : d.reason
    const relatedSlugs = d.related.map((l) => l.slug).slice(0, 8)
    deps.ledger.append({
      at: now,
      kind: 'trigger',
      gate: gateAtFire === 'off' ? 'shadow' : gateAtFire,
      fired: isTarget && fire,
      wouldFire: d.wouldFire,
      key: d.cluster.key,
      count: d.cluster.count,
      reason,
      ...(relatedSlugs.length > 0 ? { relatedLessons: relatedSlugs } : {}),
    })
  }

  if (!fire || fireTarget === undefined) return { status: 'scanned', decisions }

  const outcome = await deps
    .generate({
      kind: 'cluster',
      evidence: fireTarget.cluster.signals,
      cluster: { key: fireTarget.cluster.key, count: fireTarget.cluster.count, cleared: true },
    })
    .catch((e): DraftOutcome => ({ status: 'refused', reason: 'llm-failed', detail: e instanceof Error ? e.name : 'unknown' }))
  return { status: 'scanned', decisions, fired: { key: fireTarget.cluster.key, outcome } }
}

// ---------------------------------------------------------------------------
// Dry-run view (the `/improve-review triggers` observation surface) — pure
// reads, no ledger writes, no fire.
// ---------------------------------------------------------------------------

export interface TriggerViewDeps {
  ledgerFile(): string
  openPeer(): Promise<PeerHandle | undefined>
  now(): string
  windowDays?: number
  threshold?: number
}

export interface TriggerView {
  key: string
  count: number
  reason: TriggerReason
  wouldFire: boolean
  related: { slug: string; hits?: number; opens?: number }[]
  lastAt: string
}

/** The current candidates and their judgment basis, recomputed on demand. */
export async function viewTriggers(deps: TriggerViewDeps): Promise<{ windowDays: number; threshold: number; spentToday: boolean; candidates: TriggerView[] }> {
  const now = deps.now()
  const windowDays = deps.windowDays ?? TRIGGER_WINDOW_DAYS
  const threshold = deps.threshold ?? TRIGGER_THRESHOLD
  const entries = readLedger(deps.ledgerFile())
  const signals = windowedSignals(entries, now, windowDays)
  const clusters = clusterToolErrors(signals).filter((c) => c.count >= threshold)
  const spentToday = hasFiredToday(entries, now)
  if (clusters.length === 0) return { windowDays, threshold, spentToday, candidates: [] }
  const peer = await deps.openPeer().catch(() => undefined)
  const roster = peer?.lessons() ?? []
  const candidates = clusters.map((c) => {
    const d = decideCluster(c, relatedLessons(c, roster), (slug) => approvedAtOf(entries, slug))
    return {
      key: d.cluster.key,
      count: d.cluster.count,
      reason: d.reason,
      wouldFire: d.wouldFire,
      related: d.related.map((l) => ({ slug: l.slug, ...(l.hits !== undefined ? { hits: l.hits } : {}), ...(l.opens !== undefined ? { opens: l.opens } : {}) })),
      lastAt: d.cluster.lastAt,
    }
  })
  return { windowDays, threshold, spentToday, candidates }
}

// ---------------------------------------------------------------------------
// The interruption fast lane (B2 决议 3② + MJ-1): interruption-pair →
// placeholder hint lesson, immediately, ≤3 per session
// ---------------------------------------------------------------------------

export interface HintDeps {
  gate(): 'off' | 'shadow' | 'on'
  ledger: ActionLedger
  ledgerFile(): string
  openPeer(): Promise<PeerHandle | undefined>
  now(): string
}

export type HintOutcome =
  | { status: 'created'; slug?: string }
  | { status: 'gate-blocked' }
  | { status: 'cap-refused' }
  | { status: 'seam-unavailable' }
  | { status: 'seam-failed' }

/**
 * Placeholder hint content — features only. The interruption pair carries a
 * turn POSITION (B1 #5); the lesson's condition restates that position and
 * the action is explicitly deferred to the distill batch (marked
 * pending-refine). No conversation text exists upstream to leak (红线⑤).
 */
export function placeholderHintParts(sessionId: string, turn: number | undefined, trigger: string): { title: string; description: string; conclusion: string; triggers: string[] } {
  const turnText = typeof turn === 'number' && Number.isFinite(turn) ? String(Math.trunc(turn)) : '?'
  return {
    title: `打断纠正占位 turn-${turnText}`,
    description: `用户在 turn ${turnText} 打断了助手（trigger=${trigger === 'interrupted' ? 'interrupted' : 'aborted'}；session=${sessionId.slice(0, 24)}）——打断对快速通道占位 hint`,
    conclusion: `待蒸馏批次补全（${HINT_PENDING_REFINE}）：condition=「用户在 turn ${turnText} 打断了助手」；action 待 LLM 冷读提炼补全（B2/MJ-1 升格路径，后续集成波落地）。本条仅为占位，未经审批前不参与注入。`,
    triggers: ['interruption-correction', HINT_PENDING_REFINE],
  }
}

/** Hint drafts already created for this session (the ledger account). */
function hintsCreatedFor(entries: readonly LedgerEntryView[], sessionId: string): number {
  return entries.filter((e) => e.kind === 'hint' && e.action === 'created' && e.sessionId === sessionId).length
}

/**
 * One fast-lane attempt. Gate must be `on` (shadow only ledgers the signal —
 * the signal row is dispatch's business, this lane adds nothing there); the
 * cap is the ledger's own per-session `hint.created` count; the write goes
 * through the peer's lesson data plane with kind/confidence/scope/source
 * pinned by the handle. Every refusal ledgered; the lane never throws (红线②).
 */
export async function createInterruptionHint(sessionId: string, turn: number | undefined, trigger: string, deps: HintDeps): Promise<HintOutcome> {
  const at = deps.now()
  if (deps.gate() !== 'on') return { status: 'gate-blocked' }

  if (hintsCreatedFor(readLedger(deps.ledgerFile()), sessionId) >= HINT_CAP_PER_SESSION) {
    deps.ledger.append({ at, kind: 'hint', gate: 'on', sessionId, action: 'cap-refused', ...(turn !== undefined ? { turn } : {}) })
    return { status: 'cap-refused' }
  }

  const peer = await deps.openPeer().catch(() => undefined)
  if (peer === undefined || typeof peer.saveLesson !== 'function') {
    deps.ledger.append({ at, kind: 'hint', gate: 'on', sessionId, action: 'seam-unavailable', ...(turn !== undefined ? { turn } : {}) })
    return { status: 'seam-unavailable' }
  }

  const parts = placeholderHintParts(sessionId, turn, trigger)
  try {
    const r = await peer.saveLesson(parts)
    if (!r.ok) {
      deps.ledger.append({ at, kind: 'hint', gate: 'on', sessionId, action: 'seam-failed', ...(turn !== undefined ? { turn } : {}) })
      return { status: 'seam-failed' }
    }
    deps.ledger.append({
      at,
      kind: 'hint',
      gate: 'on',
      sessionId,
      action: 'created',
      ...(r.slug !== undefined ? { slug: r.slug.slice(0, 128) } : {}),
      ...(turn !== undefined ? { turn } : {}),
    })
    return { status: 'created', ...(r.slug !== undefined ? { slug: r.slug } : {}) }
  } catch {
    deps.ledger.append({ at, kind: 'hint', gate: 'on', sessionId, action: 'seam-failed', ...(turn !== undefined ? { turn } : {}) })
    return { status: 'seam-failed' }
  }
}
