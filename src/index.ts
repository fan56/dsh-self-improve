/**
 * dsh-self-improve — the self-improvement loop for dsh (spec 卷二 is the
 * contract; wave N1 lays the foundation: config keys + signal collectors +
 * observation feed + the action ledger).
 *
 * Wave-N1 shape:
 *   settings (`dsh-self-improve` namespace, three volatile keys)
 *     └─ improveLoop: off | shadow | on   ← the loop master gate
 *   session firehose ──▶ SignalCollector ──▶ per-turn-end batch
 *     ├─ shadow: meta/improve-actions.jsonl only (never fed)
 *     └─ on:     action ledger AND feedObservations into topics-memory
 *   periodic (once per session, dsh-cron-friendly):
 *     unused-injection snapshot from the peer's usage aggregate
 *
 * Gate semantics (spec §7 MJ-A, enforced here):
 *   off    — apply() returns before ANY listener registration: the host's
 *            behavior is byte-for-byte stock (pinned by the off-guard test).
 *            Arming from a boot-time off needs a reload.
 *   shadow — collectors subscribe; observations land in the ledger only.
 *   on     — collectors subscribe; observations are fed and ledgered.
 *   shadow↔on flips are hot (volatile refs re-read per event); a flip INTO
 *   off mid-session makes the already-registered listeners inert (they
 *   re-check the gate before every action) but keeps them attached.
 *
 * Failure posture (red line ②, hard-coded, no key): every lane here is
 * async, fire-and-forget, and swallows its own errors; a broken feed or a
 * broken ledger at most costs telemetry, never session function.
 *
 * @module index
 */

import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { StructuredObservation } from '@aiwayds/dsh-topics-memory'

import { normalizeImproveLoop, readConfigValue, snapshotConfig, SelfImproveConfig, type SelfImproveRuntimeConfig } from './config.ts'
import { openPeerHandle, resolveImproveBundleRoot, unusedInjectionObservations, type PeerHandle } from './feed.ts'
import { ActionLedger } from './ledger.ts'
import { SignalCollector } from './signals.ts'

export const name = 'dsh-self-improve'

/** Settings-page schema — projected into the `dsh-self-improve` namespace. */
export const Config = SelfImproveConfig

/** Injectable host seams (tests stub these; production uses the defaults). */
export interface LoopDeps {
  openPeer(): Promise<PeerHandle | undefined>
  bundleRoot(): string
  now(): string
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
  // The off-guard: resolve the gate FIRST and return before any listener,
  // any peer probe, any filesystem touch — the guard test pins "zero
  // listeners after apply".
  const initialGate = normalizeImproveLoop(readConfigValue(config.improveLoop))
  if (initialGate === 'off') return

  const host = ctx as unknown as HostLike
  // Volatile hot path: every event re-snapshots the live refs, so a
  // settings-page shadow↔on flip lands on the next turn end.
  const cfgNow = () => snapshotConfig(config)
  const ledger = new ActionLedger(join(deps.bundleRoot(), 'meta', 'improve-actions.jsonl'))
  const nowIso = () => deps.now()

  // Peer handle: created lazily on first use, at most once per process.
  // undefined (peer absent / unloadable) is a STICKY outcome — spec §6.3:
  // the loop degrades to ledger-only, no retry storm, no补投.
  let peerPromise: Promise<PeerHandle | undefined> | undefined
  const peerOf = (): Promise<PeerHandle | undefined> => (peerPromise ??= deps.openPeer())

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
    }
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
      }
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
      } catch {
        // Contained.
      }
    })
  }
}

