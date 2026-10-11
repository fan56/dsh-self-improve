/**
 * The write-seam wiring (spec 卷二 §6.2 method ①): a TopicsService instance
 * constructed DIRECTLY over the same bundle root topics-memory resolves —
 * dynamic-imported so the optional peer's absence degrades cleanly (采集照
 * 跑、投喂跳过、降级落账, spec §6.3).
 *
 * 拍板 (direct construction vs consuming the host instance): topics-memory
 * keeps its TopicsService closure-local — it is not a registered cordis
 * service, so there is nothing to consume from ctx. Direct construction
 * over `resolveImproveBundleRoot()` (the same env resolution as the peer's
 * paths.resolveBundleRoot) is the only seam that works without a hard
 * dependency. Writes still go through the peer's own store lock/queue and
 * its `feedObservations` whitelist gate — this module never touches bundle
 * topic files (禁直写清单 respected: our only artifacts are the
 * feedObservations appends and OUR OWN ledger under meta/).
 *
 * The peer surface here is deliberately STRUCTURAL (local minimal
 * interfaces + a cast on the dynamic import): the optional peer must be
 * able to drift a minor version without breaking this repo's build, and a
 * missing peer must not even resolve the deep import paths.
 *
 * @module feed
 */

import { existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { FeedResult, StructuredObservation } from '@aiwayds/dsh-topics-memory'

/** Cap on slugs per unused-injection snapshot (sorted by windowed hits desc). */
export const UNUSED_INJECTION_SLUG_CAP = 20
/** The usage-signal window of the B1 #3 rule, in days. */
export const USAGE_WINDOW_DAYS = 30

/** The exact TopicsService surface this repo drives — nothing more. */
interface PeerTopicsService {
  feedObservations(obs: readonly StructuredObservation[], opts: { actor: string }): Promise<FeedResult>
  usageSignalsSync(): Map<string, { hits: number; opens: number }>
  setLessonStatus(slug: string, to: 'established' | 'deprecated' | 'removed', opts: { actor: string }): Promise<StoreResult>
}

/** Structural view of the peer's StoreResult — only ok/reason are read. */
export interface StoreResult {
  ok?: boolean
  reason?: string
}

export interface PeerHandle {
  /** Method ① — structured observations into the peer's distill lane. */
  feed(observations: readonly StructuredObservation[]): Promise<FeedResult>
  /** The peer's mtime-cached 30-day usage aggregate (slug → {hits, opens}). */
  usageSignals(): Map<string, { hits: number; opens: number }>
  /** Method ② (spec §6.2, wave N3) — lesson status flips through the peer's
   *  store lock + index recompute; this repo never writes bundle files. */
  setLessonStatus(slug: string, to: 'established' | 'deprecated' | 'removed', opts: { actor: string }): Promise<StoreResult>
}

export type FeedOutcome =
  | { status: 'fed'; accepted: number; duplicates: number; rejected: number }
  | { status: 'unavailable' }

/**
 * The bundle root, resolved with the SAME env ladder as topics-memory's
 * paths.resolveBundleRoot (which is not reachable at runtime when the peer
 * is absent — hence this local copy; kept behavior-identical on purpose):
 * $DSH_TOPICS_HOME → $DSH_HOME/topics → ~/.dsh/topics, with the one-time
 * legacy `llmwiki` migration fail-open replicated.
 */
export function resolveImproveBundleRoot(): string {
  const topicsHome = process.env.DSH_TOPICS_HOME?.trim()
  if (topicsHome !== undefined && topicsHome !== '') return topicsHome
  const dshHome = process.env.DSH_HOME?.trim()
  const base = dshHome !== undefined && dshHome !== '' ? dshHome : join(homedir(), '.dsh')
  const next = join(base, 'topics')
  const legacy = join(base, 'llmwiki')
  if (existsSync(next) || !existsSync(legacy)) return next
  try {
    renameSync(legacy, next)
    return next
  } catch {
    return existsSync(next) ? next : legacy
  }
}

/**
 * getConfig for the constructed TopicsService. The facade consults config
 * only on injection/tool paths this repo never drives — feeds and usage
 * aggregates read the sidecar logs directly. The view mirrors the peer's
 * own bare-harness defaults with every behavioral key off: we own no
 * injection surface, so nothing here can change peer behavior.
 */
const TOPICS_SERVICE_VIEW = (): unknown => ({
  repo: '',
  autoInject: false,
  injectDedup: true,
  suppressEcho: true,
  topK: 0,
  perTopicBudget: 300,
  totalBudget: 1500,
  matchThreshold: 0.3,
  tagBoost: 0,
  injectMode: 'pointer',
  qualityLane: 'off',
  graphDepth: 0,
  recencyWindowDays: 7,
  autoObserve: false,
  includeSubagents: false,
  observationMaxChars: 2000,
  distillEveryTurns: 5,
  distillOnSessionEnd: false,
  distillProvider: '',
  distillModel: '',
  distillBatchSize: 40,
  distillMaxModelCalls: 8,
  consolidateCadence: 'off',
  deprecatedTtlDays: 0,
  usageBoost: 0,
  pushDebounceSeconds: 45,
  zeroOpenDecay: false,
  jevEnabled: false,
  jevBackend: '',
  jevModel: '',
  jevTimeoutMs: 15000,
  jevSecretFile: '',
  jevLayaFallback: false,
  jevLayaUrl: '',
  embeddingProvider: '',
  embeddingModel: '',
  packageMode: 'off',
  lessonInject: 'off',
})

/**
 * Open the peer handle: dynamic-import @aiwayds/dsh-topics-memory and build
 * a BundleStore + TopicsService over the shared bundle root. Returns
 * undefined when the peer is absent or refuses to load (optional peer,
 * spec §6.3 degradation) — callers ledger the degradation and keep
 * collecting.
 */
export async function openPeerHandle(): Promise<PeerHandle | undefined> {
  try {
    const storeMod = (await import('@aiwayds/dsh-topics-memory/lib/store.js')) as unknown as {
      BundleStore: new (root: string) => unknown
    }
    const serviceMod = (await import('@aiwayds/dsh-topics-memory/lib/service.js')) as unknown as {
      TopicsService: new (store: unknown, getConfig: () => unknown) => PeerTopicsService
    }
    const store = new storeMod.BundleStore(resolveImproveBundleRoot())
    const service = new serviceMod.TopicsService(store, TOPICS_SERVICE_VIEW)
    return {
      feed: (observations) => service.feedObservations(observations, { actor: 'dsh-self-improve' }),
      usageSignals: () => service.usageSignalsSync(),
      setLessonStatus: (slug, to, opts) => service.setLessonStatus(slug, to, opts),
    }
  } catch {
    return undefined
  }
}

/**
 * B1 signal #3 as a pure function over the peer's usage aggregate: slugs
 * injected at least once in the rolling 30-day window with zero opens —
 * 「注入了没用」. Sorted by windowed hits descending, capped; one
 * observation PER SLUG (StructuredObservation.detail is flat, and the
 * aggregate carries no session dimension per spec §2.1 #3).
 */
export function unusedInjectionObservations(
  signals: ReadonlyMap<string, { hits: number; opens: number }>,
  now: () => string = () => new Date().toISOString(),
): StructuredObservation[] {
  const at = now()
  const rows = [...signals.entries()]
    .filter(([, s]) => s.hits >= 1 && s.opens === 0)
    .sort((a, b) => b[1].hits - a[1].hits)
    .slice(0, UNUSED_INJECTION_SLUG_CAP)
  return rows.map(([slug, s]) => ({
    type: 'unused-injection',
    at,
    detail: {
      slug: slug.slice(0, 128),
      hits: s.hits,
      opens: s.opens,
      windowDays: USAGE_WINDOW_DAYS,
    },
  }))
}
