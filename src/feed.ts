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

/** The exact TopicsService surface this repo drives — nothing more. The
 *  N2-added members are optional: a runtime peer older than 0.25.0 lacks
 *  them, and the handles degrade (empty roster / seam-unavailable) instead
 *  of breaking the loop lane (红线②). */
interface PeerTopicsService {
  feedObservations(obs: readonly StructuredObservation[], opts: { actor: string }): Promise<FeedResult>
  usageSignalsSync(): Map<string, { hits: number; opens: number }>
  setLessonStatus(slug: string, to: 'established' | 'deprecated' | 'removed', opts: { actor: string }): Promise<StoreResult>
  /** 0.25.0+: the established-lesson roster (MJ-3 semantics — hints never
   *  appear here). File-level reads behind an mtime cache; read-only. */
  lessonsSync?(): unknown[]
  /** 0.25.0+: the lesson data plane of the topic_save seam. The N2 fast
   *  lane pins kind/confidence/lessonSource itself. */
  saveTopic?(input: Record<string, unknown>): Promise<{ slug?: string }>
}

/** Structural view of the peer's StoreResult — only ok/reason are read. */
export interface StoreResult {
  ok?: boolean
  reason?: string
}

/** The slice of an established lesson the BL-3 word-face check reads. */
export interface PeerLessonEntry {
  slug: string
  title?: string
  triggers?: string[]
  /** 30-day injection telemetry annotation (ilog hits/opens), if any. */
  hits?: number
  opens?: number
}

/** The fast-lane save request — whitelist fields only, no conversation text. */
export interface PeerSaveLessonInput {
  title: string
  description?: string
  conclusion?: string
  triggers?: string[]
}

export interface PeerHandle {
  /** Method ① — structured observations into the peer's distill lane. */
  feed(observations: readonly StructuredObservation[]): Promise<FeedResult>
  /** The peer's mtime-cached 30-day usage aggregate (slug → {hits, opens}). */
  usageSignals(): Map<string, { hits: number; opens: number }>
  /** Method ② (spec §6.2, wave N3) — lesson status flips through the peer's
   *  store lock + index recompute; this repo never writes bundle files. */
  setLessonStatus(slug: string, to: 'established' | 'deprecated' | 'removed', opts: { actor: string }): Promise<StoreResult>
  /** Established lessons only (the BL-3 related-lesson check reads this; a
   *  peer without lessonsSync degrades to an empty roster, which the BL-3
   *  conjunction treats as the blind-spot branch — §6.3). */
  lessons(): PeerLessonEntry[]
  /** B2 决议 3② fast lane: create a hint lesson through the peer's lesson
   *  data plane (kind:'lesson', confidence:'hint', scope:'workspace',
   *  lessonSource:'correction' pinned HERE — the caller cannot widen it). */
  saveLesson(input: PeerSaveLessonInput): Promise<{ ok: boolean; slug?: string }>
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
    // 0.25.0+ members are probed, not assumed — an older runtime peer keeps
    // every other lane alive (optional-peer degradation, 红线②).
    const roster = (): PeerLessonEntry[] => {
      if (typeof service.lessonsSync !== 'function') return []
      const usage = safeUsage(service)
      try {
        return (service.lessonsSync() ?? []).map((raw) => {
          const e = raw as { slug?: unknown; title?: unknown; triggers?: unknown }
          const slug = typeof e.slug === 'string' ? e.slug : ''
          if (slug === '') return undefined
          const u = usage.get(slug)
          return {
            slug,
            ...(typeof e.title === 'string' && e.title !== '' ? { title: e.title.slice(0, 200) } : {}),
            ...(Array.isArray(e.triggers) ? { triggers: e.triggers.filter((t): t is string => typeof t === 'string').slice(0, 16) } : {}),
            ...(u !== undefined ? { hits: u.hits, opens: u.opens } : {}),
          }
        }).filter((e): e is PeerLessonEntry => e !== undefined)
      } catch {
        return []
      }
    }
    return {
      feed: (observations) => service.feedObservations(observations, { actor: 'dsh-self-improve' }),
      usageSignals: () => service.usageSignalsSync(),
      setLessonStatus: (slug, to, opts) => service.setLessonStatus(slug, to, opts),
      lessons: roster,
      saveLesson: async (input) => {
        if (typeof service.saveTopic !== 'function') return { ok: false }
        try {
          const r = await service.saveTopic({
            title: input.title,
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.conclusion !== undefined ? { conclusion: input.conclusion } : {}),
            ...(input.triggers !== undefined ? { triggers: input.triggers } : {}),
            kind: 'lesson',
            scope: 'workspace',
            confidence: 'hint',
            lessonSource: 'correction',
          })
          return { ok: true, ...(typeof r.slug === 'string' ? { slug: r.slug } : {}) }
        } catch {
          return { ok: false }
        }
      },
    }
  } catch {
    return undefined
  }
}

/** usageSignalsSync is older than lessonsSync; tolerate either being odd. */
function safeUsage(service: PeerTopicsService): Map<string, { hits: number; opens: number }> {
  try {
    return service.usageSignalsSync() ?? new Map()
  } catch {
    return new Map()
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
