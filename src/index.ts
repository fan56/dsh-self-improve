/**
 * dsh-self-improve — the self-improvement loop for dsh (spec 卷二 is the
 * contract; wave N1 the foundation, N3 the approval CLI + skills asset
 * loop, N2 the trigger engine + interruption fast lane, N4 the jev decision
 * layer + the approval evidence summary).
 *
 * Wave-N4 additions:
 *   jev 增强层 (src/jev-gate.ts, improveJevBackend='' | zen):
 *     门① trigger-cluster — the engine asks 「同一个问题吗」 before firing
 *                          (adopt/record fire, fallback vetoes, 24h sticky);
 *     门② lesson-contradiction — approve-lesson warning lines (人审优先,
 *                          never blocks);
 *     门③ draft-quality — below-0.10 drafts never queue (archived + ledgered),
 *                          call failures leave the self-check final;
 *     门④ retire-review — installed auto skills ≥90d asked on the periodic
 *                          slot; answered <0.10 surfaces as a queue
 *                          suggestion, the human decides (reject retires).
 *   Off ('' backend) = zero calls, zero decision rows, byte-identical pure
 *   paths (guard-pinned). Every judgment lands one whitelisted row in
 *   meta/improve-decisions.jsonl — never the judged text (红线⑤).
 *   Evidence summary (蒸馏路由, not jev): /improve-review show gains LLM
 *   pro/con one-liners with an id+digest cache; failures fall back to the
 *   machine summary verbatim.
 *
 * Wave-N2 shape:
 *   settings (`dsh-self-improve` namespace, three volatile keys)
 *     └─ improveLoop: off | shadow | on   ← the loop master gate
 *   /improve-review (human-initiated, registered under EVERY gate):
 *     queue list / show / approve / reject / manual draft / triggers
 *   session firehose ──▶ SignalCollector ──▶ per-turn-end batch
 *     ├─ shadow: meta/improve-actions.jsonl only (never fed)
 *     └─ on:     action ledger AND feedObservations into topics-memory
 *                 + interruption-pair → immediate placeholder hint lesson
 *                   (peer lesson data plane, ≤3 per session, B2 决议 3②)
 *   turn/end ──▶ trigger-engine scan (≤1 per session per minute):
 *     cluster tool-errors (toolName+code, 7d ≥3) ∧ BL-3 lesson check →
 *     shadow: would-fire ledger rows only; on: fire the N3 draft lane
 *     (daily ≤1). off: the engine never runs, zero reads.
 *   periodic (once per session, dsh-cron-friendly):
 *     unused-injection snapshot from the peer's usage aggregate
 *     + 门④ retire review (jev layer on only)
 *
 * Gate semantics (spec §7 MJ-A + the wave-N3 refinement for the human
 * surface):
 *   off    — zero firehose listeners (byte-for-byte host behavior, pinned by
 *            the off-guard test); arming from a boot-time off needs a reload.
 *            /improve-review stays available (it acts only when a human
 *            invokes it) but its queue is suppressed, draft generation is
 *            refused + ledgered, and mutations are refused.
 *   shadow — collectors subscribe; observations land in the ledger only.
 *            Draft generation + self-check run; the engine computes and
 *            records would-fire rows but nothing fires; no hint drafts.
 *            Effecting mutations (skill install / lesson status flips) are
 *            refused.
 *   on     — everything.
 *   Skill install is ALWAYS human-review (no automatic path); shadow↔on
 *   flips are hot; a flip INTO off mid-session makes the listeners inert.
 *
 * Failure posture (red line ②, hard-coded, no key): every lane here is
 * async, fire-and-forget, and swallows its own errors; a broken feed, a
 * broken ledger or a broken command at most costs telemetry, never session
 * function.
 *
 * @module index
 */

import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { StructuredObservation } from '@aiwayds/dsh-topics-memory'

import { normalizeImproveLoop, readConfigValue, snapshotConfig, SelfImproveConfig, type SelfImproveConfigValue, type SelfImproveRuntimeConfig } from './config.ts'
import { openPeerHandle, resolveImproveBundleRoot, unusedInjectionObservations, type PeerHandle } from './feed.ts'
import { ActionLedger } from './ledger.ts'
import { createJevGate, type JevGate } from './jev-gate.ts'
import { registerReviewCommand, type ReviewCommandDeps } from './review.ts'
import { defaultDraftsRoot, defaultSkillsRoot, generateSkillDraft } from './skill-draft.ts'
import { SignalCollector } from './signals.ts'
import { createInterruptionHint, SCAN_THROTTLE_MS, scanRetireReview, scanTriggers } from './triggers.ts'

export const name = 'dsh-self-improve'

/** Settings-page schema — projected into the `dsh-self-improve` namespace. */
export const Config = SelfImproveConfig

/** Injectable host seams (tests stub these; production uses the defaults). */
export interface LoopDeps {
  openPeer(): Promise<PeerHandle | undefined>
  bundleRoot(): string
  now(): string
  /** Skill-drafts area (defaults to ~/.dsh/skills-drafts). */
  draftsRoot?(): string
  /** Install target (defaults to ~/.dsh/skills). */
  skillsRoot?(): string
  /** LLM override for draft generation (tests mock it; default is the
   *  verified bigmodel route — skill-draft.bigmodelLlm). */
  llm?: ReviewCommandDeps['llm']
  /** Monotonic-ish clock for the per-session scan throttle (tests inject a
   *  stepping counter; default wall clock). */
  monoNow?(): number
  /** Jev gate override (tests mock it; default = the real zen client over
   *  the live improveJevBackend/improveJevModel keys). */
  jev?: JevGate
}

const defaultDeps: LoopDeps = {
  openPeer: openPeerHandle,
  bundleRoot: resolveImproveBundleRoot,
  now: () => new Date().toISOString(),
}

/** Minimal shape of the cordis host surface this plugin touches. */
interface HostLike {
  on(event: string, listener: (this: unknown, subject: unknown, extra?: unknown) => void): void
}

export async function apply(ctx: Context | HostLike, config: SelfImproveRuntimeConfig = {}, deps: LoopDeps = defaultDeps): Promise<void> {
  const host = ctx as unknown as HostLike
  // Volatile hot path: every event/invocation re-snapshots the live refs, so
  // a settings-page flip lands on the next turn end or command call.
  const cfgNow = (): SelfImproveConfigValue => snapshotConfig(config)
  // Lazy ledger path: resolved at first append, so an off boot (or any boot
  // without a review action) never touches the bundle root (off-guard probe).
  const ledgerFile = (): string => join(deps.bundleRoot(), 'meta', 'improve-actions.jsonl')
  const ledger = new ActionLedger(ledgerFile)
  const nowIso = (): string => deps.now()

  // Peer handle: created lazily on first use, at most once per process.
  // undefined (peer absent / unloadable) is a STICKY outcome — spec §6.3:
  // the loop degrades to ledger-only, no retry storm, no补投. Declared
  // BEFORE the off-guard return: /improve-review survives an off boot, so a
  // settings-page flip to on must find the seam (the guard test still pins
  // zero peer probes during apply — laziness is the point).
  let peerPromise: Promise<PeerHandle | undefined> | undefined
  const peerOf = (): Promise<PeerHandle | undefined> => (peerPromise ??= deps.openPeer())

  // ---- /improve-review (all gates; human-initiated surface) ----
  // Registration must not probe the peer or the filesystem — everything
  // inside the handler resolves lazily per invocation.
  // The jev decision layer (N4): constructed unconditionally but INERT until
  // improveJevBackend=zen — enabled() re-reads the live key per call (hot
  // flip), and a disabled layer makes zero remote calls and writes zero
  // decision rows (the pure-code paths stay byte-identical, guard-pinned).
  const jevGate = deps.jev ?? createJevGate({
    backend: () => cfgNow().improveJevBackend,
    model: () => cfgNow().improveJevModel,
    decisionsFile: () => join(deps.bundleRoot(), 'meta', 'improve-decisions.jsonl'),
    now: nowIso,
  })
  const reviewDeps: ReviewCommandDeps = {
    gate: () => normalizeImproveLoop(cfgNow().improveLoop),
    ledger,
    openPeer: () => peerOf(),
    bundleRoot: () => deps.bundleRoot(),
    draftsRoot: () => (deps.draftsRoot !== undefined ? deps.draftsRoot() : defaultDraftsRoot()),
    skillsRoot: () => (deps.skillsRoot !== undefined ? deps.skillsRoot() : defaultSkillsRoot()),
    now: nowIso,
    jev: jevGate,
    ...(deps.llm !== undefined ? { llm: deps.llm } : {}),
  }
  registerReviewCommand(host, reviewDeps)

  // The off-guard: return before ANY firehose listener, any peer probe, any
  // filesystem touch — the guard test pins "zero listeners after apply".
  const initialGate = normalizeImproveLoop(readConfigValue(config.improveLoop))
  if (initialGate === 'off') return

  /** Degradation ledger throttle: once per key (per session / per periodic lane). */
  const degradedKeys = new Set<string>()
  /** unused-injection snapshot throttle: at most once per session. */
  const checkedSessions = new Set<string>()

  const ledgerSignal = (gate: 'shadow' | 'on', sessionId: string | undefined, o: StructuredObservation): void => {
    ledger.append({
      at: nowIso(),
      kind: 'signal',
      gate,
      ...(sessionId !== undefined ? { sessionId } : {}),
      type: o.type,
      ...(o.detail !== undefined ? { detail: o.detail } : {}),
    })
  }

  const ledgerDegraded = (gate: 'shadow' | 'on', key: string, reason: string): void => {
    if (degradedKeys.has(key)) return
    degradedKeys.add(key)
    ledger.append({ at: nowIso(), kind: 'feed-degraded', gate, reason })
  }

  /** One feed cycle: ledger the accepted/duplicates/rejected outcome. */
  const feedBatch = async (gate: 'shadow' | 'on', throttleKey: string, observations: readonly StructuredObservation[]): Promise<void> => {
    const peer = await peerOf()
    if (peer === undefined) {
      ledgerDegraded(gate, throttleKey, 'topics-memory-unavailable')
      return
    }
    try {
      const result = await peer.feed(observations)
      ledger.append({
        at: nowIso(),
        kind: 'feed',
        gate: 'on',
        count: observations.length,
        accepted: result.accepted,
        duplicates: result.duplicates,
        rejected: result.rejected,
      })
    } catch {
      // A throwing feed is the same degradation as an absent peer (红线②).
      ledgerDegraded(gate, throttleKey, 'topics-memory-feed-failed')
    }
  }

  /** One dispatched batch under the CURRENT gate (hot-flip aware). */
  const dispatch = (sessionId: string | undefined, observations: readonly StructuredObservation[]): void => {
    const gate = normalizeImproveLoop(cfgNow().improveLoop)
    if (gate === 'off') return // flipped off mid-session: listeners go inert
    for (const o of observations) ledgerSignal(gate, sessionId, o)
    if (gate === 'on') {
      void feedBatch(gate, sessionId ?? 'periodic', observations).catch(() => {
        // Contained: the ledger inside feedBatch already recorded what it could.
      })
      // The interruption fast lane (B2 决议 3②): immediate, gate=on only —
      // shadow stops here (the signal line above IS its ledger band).
      if (sessionId !== undefined) {
        for (const o of observations) {
          if (o.type !== 'interruption-pair') continue
          const turn = typeof o.detail?.turn === 'number' ? o.detail.turn : undefined
          const trigger = typeof o.detail?.trigger === 'string' ? o.detail.trigger : 'aborted'
          void createInterruptionHint(sessionId, turn, trigger, {
            gate: () => normalizeImproveLoop(cfgNow().improveLoop),
            ledger,
            ledgerFile,
            openPeer: () => peerOf(),
            now: nowIso,
          }).catch(() => {
            // Contained: refusals ledger themselves; a crash here costs one hint.
          })
        }
      }
    }
  }

  // ---- N2 trigger engine: per-turn-end scans, ≤1 per session per minute ----
  const scanThrottle = new Map<string, number>()
  const monoNow = (): number => (deps.monoNow !== undefined ? deps.monoNow() : Date.now())
  // The cluster lane's fire step is the N3 draft generator with THIS plugin's
  // own draft deps — the engine only clears inputs, the lane keeps its gates.
  const draftDeps = {
    gate: () => normalizeImproveLoop(cfgNow().improveLoop),
    ledger,
    ledgerFile,
    draftsRoot: () => (deps.draftsRoot !== undefined ? deps.draftsRoot() : defaultDraftsRoot()),
    now: nowIso,
    jev: jevGate,
    ...(deps.llm !== undefined ? { llm: deps.llm } : {}),
  }
  const maybeScanTriggers = (sessionId: string): void => {
    // off = the engine never runs, not even a ledger read (zero-read guard).
    if (normalizeImproveLoop(cfgNow().improveLoop) === 'off') return
    const t = monoNow()
    const last = scanThrottle.get(sessionId)
    if (last !== undefined && t - last < SCAN_THROTTLE_MS) return
    scanThrottle.set(sessionId, t)
    void scanTriggers({
      gate: () => normalizeImproveLoop(cfgNow().improveLoop),
      ledger,
      ledgerFile,
      openPeer: () => peerOf(),
      now: nowIso,
      generate: (input) => generateSkillDraft(input, draftDeps),
      jev: jevGate,
    }).catch(() => {
      // Contained: a broken scan costs one engine tick, never the session.
    })
  }

  /** The periodic (non-firehose) signal: unused-injection snapshot. */
  const periodicCheck = async (throttleKey: string): Promise<void> => {
    const gate = normalizeImproveLoop(cfgNow().improveLoop)
    if (gate === 'off') return
    const peer = await peerOf()
    if (peer === undefined) {
      ledgerDegraded(gate, throttleKey, 'topics-memory-unavailable')
      return
    }
    let observations: StructuredObservation[]
    try {
      observations = unusedInjectionObservations(peer.usageSignals(), nowIso)
    } catch {
      // Aggregate read failure degrades the SIGNAL, not the session (红线②).
      return
    }
    if (observations.length === 0) return
    dispatch(undefined, observations)
  }

  const collector = new SignalCollector({
    flush(sessionId, observations) {
      // Per-turn-end batch cadence (spec: one feed per turn, never per event).
      dispatch(sessionId, observations)
    },
    turnEnd(sessionId) {
      // The dsh-cron-friendly periodic check rides the first turn end of a
      // session (throttled: at most once per session), signal-bearing or
      // not; a later wave can also drive periodicCheck from a cron rule
      // without touching the firehose path.
      if (!checkedSessions.has(sessionId)) {
        checkedSessions.add(sessionId)
        void periodicCheck(`unused-injection:${sessionId}`).catch(() => {
          // Contained.
        })
        // 门④ 90-day retire review rides the same periodic slot (N4, spec
        // 增补节): layer off → zero reads/calls inside; per-skill 24h
        // recheck window bounds the remote cost; suggestions are ledger
        // rows only — nothing is ever uninstalled here.
        void scanRetireReview({
          jev: jevGate,
          skillsRoot: () => (deps.skillsRoot !== undefined ? deps.skillsRoot() : defaultSkillsRoot()),
          openPeer: () => peerOf(),
          now: nowIso,
        }).catch(() => {
          // Contained: a broken retire scan costs one periodic tick.
        })
      }
      // The N2 trigger engine scan: every turn end, throttled to one scan
      // per session per minute; off = zero reads.
      maybeScanTriggers(sessionId)
    },
  })

  // ---- Session firehose (the ONLY listener family this plugin arms) ----
  host.on('session/event', (subject, extra) => {
    try {
      const sessionId = String((subject as { id?: unknown } | null | undefined)?.id ?? '')
      if (sessionId === '') return
      const event = extra as { type?: unknown; data?: unknown } | undefined
      if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return
      collector.onSessionEvent(sessionId, event.type, event.data)
    } catch {
      // Contained: the eavesdropper never breaks the dispatch.
    }
  })

  // ---- Teardown: drop per-session structures (no leak past a session) ----
  for (const [event, subjectId] of [
    ['agent/disposed', (subject: unknown) => (subject as { agent?: { id?: unknown } } | null | undefined)?.agent?.id],
    ['session/disposed', (subject: unknown) => (subject as { id?: unknown } | null | undefined)?.id],
  ] as const) {
    host.on(event, (subject) => {
      try {
        const sessionId = String(subjectId(subject) ?? '')
        if (sessionId === '') return
        collector.disposeSession(sessionId)
        checkedSessions.delete(sessionId)
        degradedKeys.delete(sessionId)
        scanThrottle.delete(sessionId)
      } catch {
        // Contained.
      }
    })
  }
}

// defaultDraftsRoot/defaultSkillsRoot re-exports for tests/diagnostics.
export { defaultDraftsRoot, defaultSkillsRoot } from './skill-draft.ts'
