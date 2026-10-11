/**
 * The jev decision layer (wave N4, spec 增补节 2026-10-11): a typed fail-open
 * client over @aiwayds/dsh-jev-core plus the judgment ledger
 * `meta/improve-decisions.jsonl`.
 *
 *   four gates ──▶ jev.judge({gate, ref, state, subjects}) ──▶ per-subject
 *     band adopt|record|fallback ──▶ the GATE decides (per-gate mapping)
 *     and ONE whitelisted row lands in the decisions ledger — never the
 *     judged text itself (红线⑤: ref is a bounded grammar id, the state
 *     survives only as a sha256 digest prefix).
 *
 * Backend & credentials (spec 增补节, user-pinned): `improveJevBackend=zen`
 * enables the layer (default '' = layer off — pure-code paths, zero calls,
 * zero rows, byte-for-byte N2/N3). zen = opencode-zen free tier, model
 * `jev-1.13-free` (the '' sentinel of improveJevModel resolves there at call
 * time). The key NEVER enters config files or logs: `JEV_ZEN_API_KEY` env →
 * macOS keychain service `opencode-zen-inference` (jev-core's keychain-first
 * lookup; failures are a configuration state, never a throw, and the value
 * is only ever placed into the Authorization header inside jev-core).
 *
 * Failure posture (红线②, hard-coded): judge() NEVER throws and NEVER
 * blocks the loop. Any failure (no key / timeout / http / bad response) is a
 * `fallback` band per subject with a machine outcome code — the caller's
 * per-gate mapping then takes over (spec: 绝不阻塞回路). Timeout 15s per
 * judgment call (zen cold start measured ~16s once, warm ~3.4s; the gates
 * ride async cron-ish lanes, never the fast path).
 *
 * Ledger discipline (jev-log, same as the action ledger): typed literal
 * entries only, 512KB compaction to the newest three quarters, silent on
 * write failure.
 *
 * @module jev-gate
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { classify, readKey, type JevQuestion } from '@aiwayds/dsh-jev-core'

// ---------------------------------------------------------------------------
// Constants (spec 增补节 — user-pinned backend, never env-overridable)
// ---------------------------------------------------------------------------

/** opencode-zen System One endpoint. */
export const ZEN_ENDPOINT = 'https://opencode.ai/zen/v1/systemone'
/** The zen decision model — the improveJevModel '' sentinel resolves here. */
export const ZEN_DEFAULT_MODEL = 'jev-1.13-free'
/** The only backend value that enables the layer; anything else is off. */
export const ZEN_BACKEND = 'zen'
/** Keychain service holding the zen inference key (user-configured). */
export const ZEN_KEYCHAIN_SERVICE = 'opencode-zen-inference'
/** Env var checked before the keychain. */
export const ZEN_KEY_ENV = 'JEV_ZEN_API_KEY'
/** Total deadline for one batched judgment call (spec: 批 lane 判定 15s). */
export const JUDGMENT_TIMEOUT_MS = 15_000
/** noul ≥ this → adopt (the gate's confident branch). */
export const ADOPT_THRESHOLD = 0.6
/** noul ≥ this (and < adopt) → record (the gate proceeds, judgment kept). */
export const RECORD_THRESHOLD = 0.1
/** Decisions ledger cap — same compaction policy as the action ledger. */
export const DECISIONS_MAX_BYTES = 512 * 1024
/** Per-subject re-judgment throttle (and the sticky-veto window). */
export const JUDGMENT_RECHECK_MS = 24 * 60 * 60 * 1000

/** The four judgment gates (closed set — the decisions ledger's schema). */
export type JevGateName = 'trigger-cluster' | 'lesson-contradiction' | 'draft-quality' | 'retire-review'

export type JevBand = 'adopt' | 'record' | 'fallback'

/**
 * Machine outcome codes: `ok` = the backend answered (probability present);
 * otherwise the jev-core typed error code family plus `error` for anything
 * unexpected. The code is the ONLY thing that distinguishes an answered
 * fallback (noul < 0.10) from a failed call — gate ③ reads exactly that.
 */
export type JevOutcomeCode = 'ok' | 'no-key' | 'timeout' | 'http' | 'invalid-response' | 'error'

export interface JevJudgment {
  band: JevBand
  /** The noul probability when outcome==='ok'; absent on call failure. */
  probability?: number
  outcome: JevOutcomeCode
  latencyMs?: number
}

// ---------------------------------------------------------------------------
// Key resolution — JEV_ZEN_API_KEY env → keychain; the value is never logged,
// never ledgered, never returned anywhere but into the client's header.
// ---------------------------------------------------------------------------

export type KeyResolver = (env: NodeJS.ProcessEnv) => string | null

/**
 * Resolve the zen inference key. The keychain leg runs through jev-core's
 * non-throwing lookup (missing binary / missing entry / non-macOS → null),
 * with the env legs suppressed so ONLY our ladder answers (a stray
 * TYPESAFE_API_KEY in the host env must not silently reroute zen traffic).
 * `keychainRunner` is injectable for tests.
 */
export const resolveZenKey = (env: NodeJS.ProcessEnv, keychainRunner?: (args: readonly string[]) => string | null): string | null => {
  const direct = env[ZEN_KEY_ENV]?.trim()
  if (direct !== undefined && direct !== '') return direct
  return readKey({ keychainSpec: ZEN_KEYCHAIN_SERVICE, env: {}, ...(keychainRunner !== undefined ? { keychainRunner } : {}) })
}

// ---------------------------------------------------------------------------
// The judgment ledger — meta/improve-decisions.jsonl (jev-log discipline)
// ---------------------------------------------------------------------------

/** One whitelisted judgment row. The judged TEXT never appears anywhere. */
export interface DecisionLedgerEntry {
  at: string
  gate: JevGateName
  /** Bounded grammar id: `toolName/code` | `skill:<name>` | `lesson:<slug>`. */
  ref: string
  /** sha256(state) prefix — content identity without content (红线⑤). */
  digest: string
  /** noul probability; present iff the backend answered (outcome=ok). */
  probability?: number
  band: JevBand
  outcome: JevOutcomeCode
  latencyMs?: number
}

/** The decisions file's line grammar is exactly DecisionLedgerEntry. */
export function readDecisionRows(file: string): DecisionLedgerEntry[] {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: DecisionLedgerEntry[] = []
  for (const line of raw.split('\n')) {
    if (line === '') continue
    try {
      const e = JSON.parse(line) as Record<string, unknown>
      if (typeof e.at !== 'string' || typeof e.gate !== 'string' || typeof e.ref !== 'string' || typeof e.band !== 'string') continue
      out.push(e as unknown as DecisionLedgerEntry)
    } catch {
      // One malformed line never sinks a read (红线②).
    }
  }
  return out
}

/** sha256 of the judged state, hex, truncated — the row's content identity. */
export function stateDigest(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Prior judgment rows for one (gate, ref) inside the trailing window — the
 * per-subject throttle AND the sticky veto: a fallback row re-read today
 * means "already asked, answer was no / the call failed", so the gate must
 * not re-ask every scan (and a veto must outlive the scan that issued it).
 * Newest last.
 */
export function recentRowsFor(file: string, gate: JevGateName, ref: string, nowIso: string, windowMs: number): DecisionLedgerEntry[] {
  const now = Date.parse(nowIso)
  if (!Number.isFinite(now)) return []
  const cutoff = now - windowMs
  return readDecisionRows(file).filter((e) => {
    if (e.gate !== gate || e.ref !== ref) return false
    const at = Date.parse(e.at)
    return Number.isFinite(at) && at >= cutoff
  })
}

/** Append one row; compact past the cap; silent on any failure (红线②). */
export function appendDecisionRow(file: string, entry: DecisionLedgerEntry): void {
  try {
    let lines: string[] = []
    try {
      lines = readFileSync(file, 'utf8').split('\n').filter((l) => l !== '')
      if (lines.length > 0 && statSync(file).size > DECISIONS_MAX_BYTES) {
        lines = lines.slice(Math.floor(lines.length / 4))
      }
    } catch {
      // First write, or the file vanished between calls — start fresh.
    }
    lines.push(JSON.stringify(entry))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, lines.join('\n') + '\n')
  } catch {
    // The decisions ledger must never break the lane (红线②).
  }
}

// ---------------------------------------------------------------------------
// The gate client
// ---------------------------------------------------------------------------

export interface JevSubject {
  /** The ledger row's ref for THIS subject — bounded grammar id
   *  (`toolName/code` | `skill:<name>` | `lesson:<slug>`). Also the key the
   *  judgment maps back to. */
  ref: string
  /** Required on the native/zen backends — the question being asked. */
  instructions: string
  /** Two-sided noul criteria (single-sided instructions measurably degrade
   *  calibration — jev-core docs). */
  criteria: { true: string; false: string }
}

export interface JudgeInput {
  gate: JevGateName
  /** The state text under evaluation — FEATURES ONLY, never conversation
   *  text (红线⑤ is the caller's obligation; only the digest is kept). */
  state: string
  subjects: readonly JevSubject[]
}

export interface JevGateDeps {
  /** Live backend key ('' | 'zen'), re-read per call (volatile hot-flip). */
  backend(): string
  /** Live pinned model; '' = sentinel → the zen default at call time. */
  model(): string
  /** Lazy decisions-ledger path (resolved at first row — an off layer never
   *  touches the bundle root). */
  decisionsFile(): string
  now(): string
  /** Injectable env (tests); default process.env. */
  env?: NodeJS.ProcessEnv
  /** Injectable key source (tests); default resolveZenKey. */
  keyResolver?: KeyResolver
  /** Injectable transport (tests); default global fetch. */
  fetchImpl?: typeof fetch
}

export interface JevGate {
  /** Whether the enhancement layer is ON right now (hot-flip aware). When
   *  false, callers MUST skip the gate entirely — zero calls, zero rows. */
  enabled(): boolean
  /** The decisions-ledger path (gates read prior rows for their throttles;
   *  the queue surface reads retire suggestions from the same file). */
  decisionsFile(): string
  /**
   * One batched judgment. Resolves undefined when the layer is OFF (no rows
   * written — proceed pure-code); otherwise resolves a judgment per subject
   * id, every failure mode already folded into band=fallback. NEVER throws
   * (红线②).
   */
  judge(input: JudgeInput): Promise<Map<string, JevJudgment> | undefined>
}

/** Band mapping: two-sided thresholds on the noul probability. */
export function bandOf(p: number): JevBand {
  if (p >= ADOPT_THRESHOLD) return 'adopt'
  if (p >= RECORD_THRESHOLD) return 'record'
  return 'fallback'
}

/** The backend gate: exactly 'zen' enables; everything else is off. */
export function normalizeJevBackend(raw: string): 'zen' | '' {
  return raw === ZEN_BACKEND ? ZEN_BACKEND : ''
}

/** The model sentinel: '' → the zen default; anything non-empty passes. */
export function resolveJevModel(raw: string): string {
  const trimmed = raw.trim()
  return trimmed === '' ? ZEN_DEFAULT_MODEL : trimmed
}

/**
 * Build the process jev gate. One instance per apply() — it holds no mutable
 * state beyond the jev-core keychain memo, so config flips are observed on
 * the next call via the live backend()/model() providers.
 */
export function createJevGate(deps: JevGateDeps): JevGate {
  const env = (): NodeJS.ProcessEnv => deps.env ?? process.env
  const keyOf = (): string | null => (deps.keyResolver !== undefined ? deps.keyResolver(env()) : resolveZenKey(env()))
  const enabled = (): boolean => normalizeJevBackend(deps.backend()) === ZEN_BACKEND
  const gate: JevGate = {
    enabled,
    decisionsFile: () => deps.decisionsFile(),
    async judge(input) {
      if (!enabled()) return undefined
      const at = deps.now()
      const digest = stateDigest(input.state)
      const row = (ref: string, entry: Omit<DecisionLedgerEntry, 'at' | 'gate' | 'ref' | 'digest'>): void => {
        appendDecisionRow(deps.decisionsFile(), { at, gate: input.gate, ref, digest, ...entry })
      }
      const fallbackAll = (outcome: JevOutcomeCode, latencyMs?: number): Map<string, JevJudgment> => {
        const out = new Map<string, JevJudgment>()
        for (const s of input.subjects) {
          out.set(s.ref, { band: 'fallback', outcome, ...(latencyMs !== undefined ? { latencyMs } : {}) })
          row(s.ref, { band: 'fallback', outcome, ...(latencyMs !== undefined ? { latencyMs } : {}) })
        }
        return out
      }
      const key = keyOf()
      if (key === null) return fallbackAll('no-key')
      // Wire shape: positional q0..qN — subject ids never leave the process.
      const questions: Record<string, JevQuestion> = {}
      input.subjects.forEach((s, i) => {
        questions[`q${i}`] = { type: 'noul', instructions: s.instructions, criteria: { ...s.criteria } }
      })
      try {
        const result = await classify({
          questions,
          state: input.state,
          endpoint: ZEN_ENDPOINT,
          model: resolveJevModel(deps.model()),
          timeoutMs: JUDGMENT_TIMEOUT_MS,
          apiKey: key,
          ...(deps.env !== undefined ? { env: deps.env } : {}),
          ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        })
        const out = new Map<string, JevJudgment>()
        input.subjects.forEach((s, i) => {
          const a = result.answers[`q${i}`]
          const latencyMs = result.latencyMs
          if (a === undefined || a.kind !== 'noul' || !Number.isFinite(a.value)) {
            out.set(s.ref, { band: 'fallback', outcome: 'invalid-response', latencyMs })
            row(s.ref, { band: 'fallback', outcome: 'invalid-response', latencyMs })
            return
          }
          const band = bandOf(a.value)
          out.set(s.ref, { band, probability: a.value, outcome: 'ok', latencyMs })
          row(s.ref, { band, probability: a.value, outcome: 'ok', latencyMs })
        })
        return out
      } catch (e) {
        const code = (e as { code?: unknown }).code
        const outcome: JevOutcomeCode =
          code === 'no-key' || code === 'timeout' || code === 'http' || code === 'invalid-response' ? code : 'error'
        return fallbackAll(outcome)
      }
    },
  }
  return gate
}

// ---------------------------------------------------------------------------
// Shared state builders — features only, bounded (the callers' 红线⑤ duty)
// ---------------------------------------------------------------------------

/** Cap any feature text that flows into a state line. */
export function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/**
 * 门④ queue feed: the latest retire-review row per ref decides — a fallback
 * band with outcome `ok` (the backend ANSWERED 「已无存在价值」, <0.10) is a
 * suggestion; a newer adopt/record row (or a human decision clearing the
 * install) supersedes it. Call-failure fallbacks never surface as
 * suggestions. Chronological read, last row per ref wins.
 */
export function retireSuggestions(file: string): { ref: string; at: string; probability?: number }[] {
  const latest = new Map<string, DecisionLedgerEntry>()
  for (const e of readDecisionRows(file)) {
    if (e.gate === 'retire-review') latest.set(e.ref, e)
  }
  return [...latest.values()]
    .filter((e) => e.band === 'fallback' && e.outcome === 'ok')
    .map((e) => ({
      ref: e.ref,
      at: e.at,
      ...(e.probability !== undefined ? { probability: e.probability } : {}),
    }))
}
