/**
 * Plugin configuration — the `dsh-self-improve` settings namespace (the
 * profile entry id, same spelling the settings page and cordis.patch.yml
 * use). Three keys, spec 卷二 §7 + 增补节:
 *
 *   improveLoop       — the loop master gate: off | shadow | on. off (the
 *                       default) registers ZERO listeners (byte-for-byte
 *                       host behavior); shadow collects + ledgers, never
 *                       feeds; on collects, ledgers AND feeds.
 *   improveJevBackend — the jev decision layer backend ('' = layer off;
 *                       'zen' = opencode-zen). Key lands in wave N1, the
 *                       wiring lands in wave N4 — until then nothing reads
 *                       it beyond this schema.
 *   improveJevModel   — pinned decision model; '' = sentinel resolving to
 *                       the backend default (jev-1.13-free for zen) at call
 *                       time, same sentinel pattern as topics-memory's
 *                       jevModel. Unused until N4.
 *
 * All three are volatile: a 0.1.7 host hands apply() live references and
 * swaps them in-place on a settings-page edit, so a shadow↔on flip is hot.
 * A flip INTO off mid-session only makes the already-registered listeners
 * inert (they re-read the gate per event and exit); arming from a boot-time
 * off always needs a reload — that is the price of the zero-listener guard.
 *
 * @module config
 */

import z from '@deepseek-ai/schemastery'

/** The three loop states, spec §5.5 灰度四步 (default off → shadow → on). */
export const IMPROVE_LOOP_MODES = ['off', 'shadow', 'on'] as const
export type ImproveLoopMode = (typeof IMPROVE_LOOP_MODES)[number]

export const SelfImproveConfig = z.object({
  /** Loop master gate (spec §7 MJ-A): off = the loop never acts; shadow =
   *  collect + action-ledger only, nothing is fed to topics-memory; on =
   *  collect, ledger AND feed. Default off, volatile. */
  improveLoop: z.string().default('off').volatile(),
  /** jev decision backend for the loop's judgment gates (spec 增补节):
   *  '' = enhancement layer off (pure-code paths only); 'zen' =
   *  opencode-zen free tier. Key lands now, wiring lands in wave N4. */
  improveJevBackend: z.string().default('').volatile(),
  /** Pinned decision model id; '' = resolve the backend default at call
   *  time (zen → jev-1.13-free). Unused until N4. */
  improveJevModel: z.string().default('').volatile(),
})

export type SelfImproveConfigValue = {
  improveLoop: string
  improveJevBackend: string
  improveJevModel: string
}

/** Settings keys in schema order — the config snapshot fold reads these. */
export const CONFIG_KEYS = ['improveLoop', 'improveJevBackend', 'improveJevModel'] as const

/** Live config reference as a 0.1.7 host passes it (topics-memory
 *  spelling): `.get()` snapshots the current value — the host swaps the
 *  reference in-place when a volatile field is edited on the settings page. */
interface VolatileRef<T> {
  get(): T
}

/** apply()-time config: live VolatileRef fields on real hosts, plain values
 *  on bare test harnesses — {@link readConfigValue} accepts both. */
export type SelfImproveRuntimeConfig = Partial<{
  [K in keyof SelfImproveConfigValue]: VolatileRef<SelfImproveConfigValue[K]> | SelfImproveConfigValue[K]
}>

/** Snapshot one config slot: live ref → current value, plain value → itself. */
export function readConfigValue(slot: unknown): unknown {
  const ref = slot as { get?: unknown } | undefined
  return typeof ref?.get === 'function' ? (ref as { get(): unknown }).get() : slot
}

/**
 * Fold an apply()-time config into a plain snapshot, schema defaults
 * applied (bare test harnesses may pass partial/absent configs).
 */
export function snapshotConfig(config: SelfImproveRuntimeConfig | undefined): SelfImproveConfigValue {
  const raw: Record<string, unknown> = {}
  for (const k of CONFIG_KEYS) {
    const slot = (config as Record<string, unknown> | undefined)?.[k]
    // Skip absent keys so the defaults fold below keeps them (an explicit
    // undefined spread would wipe the default).
    if (slot !== undefined) raw[k] = readConfigValue(slot)
  }
  return {
    improveLoop: typeof raw.improveLoop === 'string' ? raw.improveLoop : 'off',
    improveJevBackend: typeof raw.improveJevBackend === 'string' ? raw.improveJevBackend : '',
    improveJevModel: typeof raw.improveJevModel === 'string' ? raw.improveJevModel : '',
  }
}

/**
 * Normalize the gate string into a loop mode. Anything that is not exactly
 * one of the three states (including a host-parsed non-string) degrades to
 * 'off' — fail-open toward "the loop never acts" (red line ② direction:
 * a typo'd value can never widen the loop's reach).
 */
export function normalizeImproveLoop(raw: unknown): ImproveLoopMode {
  return IMPROVE_LOOP_MODES.includes(raw as ImproveLoopMode) ? (raw as ImproveLoopMode) : 'off'
}
