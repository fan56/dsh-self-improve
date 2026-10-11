/**
 * `/improve-review` — the unified approval queue (wave N3, spec 卷二 §4.3 +
 * B3 决议 3 / B4 决议 3): skill drafts AND lesson hints, one command surface.
 *
 *   /improve-review                queue list (skill drafts + peer hint lessons)
 *   /improve-review show <id>      full text + machine-assembled evidence summary
 *   /improve-review approve <id>   skill → install into ~/.dsh/skills/<name>/
 *                                  lesson → peer setLessonStatus(slug,'established')
 *   /improve-review reject <id>    skill → archive the draft under .archived/
 *                                  lesson → peer setLessonStatus(slug,'removed')
 *   /improve-review draft          manual trigger: last-7d ledger signals → draft
 *   /improve-review triggers       trigger-engine dry run: candidates + judgment
 *                                  basis, read-only (wave N2)
 *
 * Gate semantics (task N3, refining spec §7 MJ-A for the human surface):
 *   off    — the command IS registered (human-initiated only), but the queue
 *            is suppressed, generation refused (ledgered), mutations refused.
 *   shadow — read surfaces + draft generation/self-check run; EFFECTING
 *            mutations (install / lesson status flips) are refused.
 *   on     — everything. Skill install is ALWAYS human-review (no automatic
 *            path exists anywhere in this repo — B4 决议 1).
 *
 * Hand-written protection (B3 决议 4): install never overwrites an existing
 * skill directory — a name collision re-installs as `<name>-auto`; if that
 * exists too, the action is refused with a merge hint. Only drafts stamped
 * `source: auto-generated` (our own marker, 红线④) are ever installable.
 *
 * Evidence discipline (红线⑤): the machine summary stays counts + feature
 * tokens; the wave-N4 LLM pro/con upgrade (draftProCon) sends only OUR OWN
 * draft + the evidence line, caches per id+digest, and falls back to the
 * machine text verbatim on any failure. The N4 jev gates ride this module:
 * 门② contradiction warnings on lesson approve, 门④ retire suggestions in
 * the queue, reject-retire on installed auto skills.
 *
 * @module review
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

import type { ActionLedger, ReviewAction } from './ledger.ts'
import type { PeerHandle, PeerLessonEntry } from './feed.ts'
import type { ImproveLoopMode } from './config.ts'
import { cap, retireSuggestions, type JevGate, type JevJudgment } from './jev-gate.ts'
import { viewTriggers } from './triggers.ts'
import {
  DRAFT_LLM_MODEL,
  defaultDraftsRoot,
  defaultSkillsRoot,
  draftProCon,
  generateSkillDraft,
  parseSkillMd,
  type LlmFn,
  type ParsedSkillMd,
} from './skill-draft.ts'

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export type ReviewId = `skill:${string}` | `lesson:${string}`

/** Strict id grammar — no separators, no traversal (`..`, leading dots). */
export function parseReviewId(raw: string): ReviewId | undefined {
  const m = /^(skill|lesson):([a-z0-9]+(?:[._-][a-z0-9]+)*)$/u.exec(raw)
  if (m === null) return undefined
  const name = m[2]
  if (name.includes('..') || name.startsWith('.')) return undefined
  return `${m[1]}:${name}` as ReviewId
}

// ---------------------------------------------------------------------------
// Queue sources
// ---------------------------------------------------------------------------

export interface SkillQueueEntry {
  id: ReviewId
  name: string
  created?: string
  evidence?: string
  file: string
}

/** Live drafts (top-level dirs of the drafts root, ours only — 红线④). */
export function listSkillDrafts(draftsRoot: string = defaultDraftsRoot()): SkillQueueEntry[] {
  let names: string[]
  try {
    names = readdirSync(draftsRoot)
  } catch {
    return []
  }
  const out: SkillQueueEntry[] = []
  for (const dir of names) {
    if (dir.startsWith('.')) continue
    const file = join(draftsRoot, dir, 'SKILL.md')
    try {
      if (!existsSync(file)) continue
      const fm: ParsedSkillMd | undefined = parseSkillMd(readFileSync(file, 'utf8'))
      if (fm?.source !== 'auto-generated' || fm.name === undefined) continue
      out.push({ id: `skill:${fm.name}`, name: fm.name, created: fm.created, evidence: fm.evidence, file })
    } catch {
      // Unreadable entry is not queueable.
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1))
}

export interface HintLessonEntry {
  id: ReviewId
  slug: string
  title?: string
  description?: string
  scope?: string
  file: string
}

/** `type: lesson` from the raw frontmatter value (peer okf.topicKindOf rule). */
function lessonKindOf(rawType: string | undefined): boolean {
  return rawType !== undefined && rawType.trim().toLowerCase() === 'lesson'
}

/**
 * Hint lessons via the file-level direct bundle read (spec §6.1 read channel;
 * the peer exposes established lessons only — hints live for this queue).
 * Minimal top-level scalar frontmatter; unparseable files are skipped, never
 * thrown (红线②). No version gate yet — the versioned-check item stays open
 * (spec §11), and this read never writes.
 */
export function listHintLessons(bundleRoot: string): HintLessonEntry[] {
  const topicsDir = join(bundleRoot, 'topics')
  let names: string[]
  try {
    names = readdirSync(topicsDir)
  } catch {
    return []
  }
  const out: HintLessonEntry[] = []
  for (const file of names) {
    if (!file.endsWith('.md') || file === 'index.md') continue
    try {
      const text = readFileSync(join(topicsDir, file), 'utf8')
      const fm = parseSkillMd(text)
      if (fm === undefined) continue
      // Re-parse type/confidence/status scalars the skill parser drops.
      const head = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1] ?? ''
      const scalar = (key: string): string | undefined => new RegExp(`^${key}: ?(.*)$`, 'mu').exec(head)?.[1]?.trim().replace(/^"([\s\S]*)"$/, '$1')
      if (!lessonKindOf(scalar('type'))) continue
      const confidence = scalar('confidence') ?? 'hint'
      if (confidence !== 'hint' || scalar('status') === 'deprecated') continue
      const slug = file.slice(0, -3)
      out.push({ id: `lesson:${slug}`, slug, title: scalar('title'), description: fm.description, scope: scalar('scope'), file: join(topicsDir, file) })
    } catch {
      // Contained.
    }
  }
  return out.sort((a, b) => (a.slug < b.slug ? -1 : 1))
}

// ---------------------------------------------------------------------------
// Install / archive (B3 决议 4: 绝不覆盖手写)
// ---------------------------------------------------------------------------

export type InstallOutcome =
  | { status: 'installed'; dir: string; adjusted: boolean; backupDir: string }
  | { status: 'refused'; reason: 'gate' | 'missing-draft' | 'not-ours' | 'collision'; detail?: string }

/** Rewrite the `name:` line inside the frontmatter block only. */
function renameFrontmatterName(text: string, newName: string): string {
  const m = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/u.exec(text)
  if (m === null) return text
  const head = m[1].replace(/^name: .*$/mu, `name: ${JSON.stringify(newName)}`)
  return head + text.slice(m[1].length)
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\..*$/u, '').replace('T', '-')
}

/**
 * Install one draft into the skills root. Copy (not move) semantics for the
 * skill file; the draft itself moves to `<drafts>/.installed/<name>-<stamp>/`
 * so the queue empties naturally AND the exact installed bytes stay around as
 * the write-time backup (spec §5.2: skill 目录写前备份回 drafts).
 */
export function installSkill(id: ReviewId, deps: { gate: ImproveLoopMode; draftsRoot: string; skillsRoot: string }): InstallOutcome {
  if (deps.gate !== 'on') return { status: 'refused', reason: 'gate' }
  const name = id.slice('skill:'.length)
  const draftDir = join(deps.draftsRoot, name)
  const draftFile = join(draftDir, 'SKILL.md')
  if (!existsSync(draftFile)) return { status: 'refused', reason: 'missing-draft' }
  let raw: string
  let fm: ParsedSkillMd | undefined
  try {
    raw = readFileSync(draftFile, 'utf8')
    fm = parseSkillMd(raw)
  } catch {
    return { status: 'refused', reason: 'missing-draft' }
  }
  // Only OUR marker is installable — a hand-placed file in the drafts area is
  // never touched (绝不碰手写, and 红线④: unidentifiable → uninstallable).
  if (fm?.source !== 'auto-generated' || fm.name === undefined) return { status: 'refused', reason: 'not-ours' }

  let targetName = name
  let adjusted = false
  if (existsSync(join(deps.skillsRoot, name))) {
    if (existsSync(join(deps.skillsRoot, `${name}-auto`))) {
      return { status: 'refused', reason: 'collision', detail: `${name} 与 ${name}-auto 均已存在，请人工合并后清理草稿` }
    }
    targetName = `${name}-auto`
    adjusted = true
  }
  const targetDir = join(deps.skillsRoot, targetName)
  try {
    mkdirSync(deps.skillsRoot, { recursive: true })
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'SKILL.md'), adjusted ? renameFrontmatterName(raw, targetName) : raw)
    // Queue hygiene + backup: the exact installed bytes, archived by stamp.
    const backupDir = join(deps.draftsRoot, '.installed', `${name}-${stamp()}`)
    mkdirSync(join(deps.draftsRoot, '.installed'), { recursive: true })
    renameSync(draftDir, backupDir)
    return { status: 'installed', dir: targetDir, adjusted, backupDir }
  } catch {
    // A partial install (our own fresh dir — the existsSync guard above
    // proved it was not pre-existing) must not linger half-written: the host
    // provider would discover it without any ledger row.
    try {
      rmSync(targetDir, { recursive: true, force: true })
    } catch {
      // Contained.
    }
    return { status: 'refused', reason: 'collision', detail: 'write-failed' }
  }
}

export type ArchiveOutcome = { status: 'archived'; dir: string } | { status: 'refused'; reason: 'gate' | 'missing-draft' }

/** Reject = archive the draft under `.archived/` (rollback-able, uninstall clears it). */
export function archiveDraft(id: ReviewId, deps: { gate: ImproveLoopMode; draftsRoot: string }): ArchiveOutcome {
  if (deps.gate !== 'on') return { status: 'refused', reason: 'gate' }
  const name = id.slice('skill:'.length)
  const draftDir = join(deps.draftsRoot, name)
  if (!existsSync(join(draftDir, 'SKILL.md'))) return { status: 'refused', reason: 'missing-draft' }
  try {
    const target = join(deps.draftsRoot, '.archived', `${name}-${stamp()}`)
    mkdirSync(join(deps.draftsRoot, '.archived'), { recursive: true })
    renameSync(draftDir, target)
    return { status: 'archived', dir: target }
  } catch {
    return { status: 'refused', reason: 'missing-draft' }
  }
}

// ---------------------------------------------------------------------------
// 门④ adjudication (N4): reject on an INSTALLED auto-generated skill = retire
// (uninstall by archive). Never automatic, never applied to hand-written
// skills (红线④), always rollback-able (the exact bytes land in .archived).
// ---------------------------------------------------------------------------

export type RetireOutcome =
  | { status: 'retired'; dir: string; archiveDir: string }
  | { status: 'refused'; reason: 'gate' | 'missing-skill' | 'not-ours' }

export function retireInstalledSkill(id: ReviewId, deps: { gate: ImproveLoopMode; skillsRoot: string; draftsRoot: string }): RetireOutcome {
  if (deps.gate !== 'on') return { status: 'refused', reason: 'gate' }
  const name = id.slice('skill:'.length)
  const dir = join(deps.skillsRoot, name)
  let fm: ParsedSkillMd | undefined
  try {
    fm = parseSkillMd(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
  } catch {
    return { status: 'refused', reason: 'missing-skill' }
  }
  if (fm?.source !== 'auto-generated') return { status: 'refused', reason: 'not-ours' }
  try {
    const archiveDir = join(deps.draftsRoot, '.archived', `${name}-${stamp()}-uninstalled`)
    mkdirSync(join(deps.draftsRoot, '.archived'), { recursive: true })
    renameSync(dir, archiveDir)
    return { status: 'retired', dir, archiveDir }
  } catch {
    return { status: 'refused', reason: 'missing-skill' }
  }
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface ReviewCommandDeps {
  /** Loop gate as of NOW (volatile hot-flip aware). */
  gate(): ImproveLoopMode
  ledger: ActionLedger
  openPeer(): Promise<PeerHandle | undefined>
  bundleRoot(): string
  draftsRoot(): string
  skillsRoot(): string
  now(): string
  llm?: LlmFn
  /** The jev layer (N4): 门② contradiction check on lesson approve, and the
   *  queue's retire-suggestion feed reads its decisions ledger. Undefined or
   *  disabled layer → every surface behaves exactly as N3 (zero calls). */
  jev?: JevGate
}

const HELP = [
  '/improve-review — 审批队列（lesson hint + skill 草稿）',
  '  无参数                队列列表（含 jev 退役复审建议，如有）',
  '  show <id>             全文 + 证据摘要（LLM 正反方，失败回退机器拼）',
  '  approve <id>          skill 装机 / lesson hint→established（lesson 固化前过 jev 矛盾检测）',
  '  reject <id>           skill 草稿归档 / lesson 移除（removed）；',
  '                        若为已装机的 auto skill（无草稿）→ 退役卸装（归档备份，可回滚）',
  '  draft                 手动起稿：行动账近 7 天信号 → SKILL.md 草稿（自验门后过 jev 质量门）',
  '  triggers              触发引擎观察面：当前候选与判定依据（只读）',
].join('\n')

const MUTATION_TEXT_SHADOW = 'improveLoop=shadow：生效动作（装机 / lesson 状态变更）被拒绝；切 on 后重试。'
const MUTATION_TEXT_OFF = 'improveLoop=off：回路关闭，队列与处置不可用。'

const TRIGGER_REASON_TEXT: Record<string, string> = {
  'bl3-no-lesson': '无相关 established lesson → BL-3 盲区直通分支',
  'bl3-lesson-recurring': '相关 established lesson 在批准后仍复发 → 升级分支',
  'bl3-lesson-holds': '相关 established lesson 批准后窗口内无复发 → 抑制（lesson 治得住）',
  'already-fired-today': '今日已 fire 过（每日 ≤1）→ 候选记入，fire 抑制',
}

/** Map a peer StoreResult to a user-facing line (reason codes only). */
function seamResultText(ok: boolean | undefined, reason: string | undefined, verb: string, slug: string): string {
  if (ok) return `${verb} 完成：lesson:${slug}（原仓已 git 提交，可 revert）。`
  const why: Record<string, string> = {
    unauthorized: '原仓拒绝（unauthorized）',
    'not-found': 'lesson 不存在',
    'not-a-lesson': '该 slug 不是 lesson',
    'invalid-state': '状态机不允许该变更',
  }
  return `${verb} 失败：lesson:${slug} — ${why[reason ?? ''] ?? `原仓返回 ${reason ?? 'unknown'}`}`
}

// ---------------------------------------------------------------------------
// 门② contradiction detection (N4, spec 增补节): before a hint lesson is
// solidified to established, the jev layer is asked 「与现有 established
// lessons 矛盾吗」. adopt (≥0.60) → proceed silently; record (0.10–0.60) or
// any call failure → the approve PROCEEDS (human already decided — 人审优先)
// with a warning line. Layer off → zero calls, N3 text byte-identical.
// ---------------------------------------------------------------------------

const CONTRADICTION_CRITERIA = {
  true: '不矛盾，可以固化',
  false: '与现有 established lessons 矛盾（条件或动作冲突）',
} as const

/** The candidate's distilled fields from the bundle file (features only). */
function readLessonContent(bundleRoot: string, slug: string): { title?: string; description?: string; conclusion?: string } | undefined {
  let text: string
  try {
    text = readFileSync(join(bundleRoot, 'topics', `${slug}.md`), 'utf8')
  } catch {
    return undefined
  }
  try {
    const head = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1] ?? ''
    const scalar = (key: string): string | undefined => new RegExp(`^${key}: ?(.*)$`, 'mu').exec(head)?.[1]?.trim().replace(/^"([\s\S]*)"$/, '$1')
    return {
      ...(scalar('title') !== undefined ? { title: scalar('title') } : {}),
      ...(scalar('description') !== undefined ? { description: scalar('description') } : {}),
      ...(scalar('conclusion') !== undefined ? { conclusion: scalar('conclusion') } : {}),
    }
  } catch {
    return undefined
  }
}

/** State text — distilled bundle artifacts only, bounded (红线⑤). */
export function contradictionState(candidate: { title?: string; description?: string; conclusion?: string }, roster: readonly PeerLessonEntry[]): string {
  const lines = [
    'candidate_lesson:',
    `- title=${cap(candidate.title ?? '-', 120)}`,
    `- description=${cap(candidate.description ?? '-', 160)}`,
    `- conclusion=${cap(candidate.conclusion ?? '-', 200)}`,
    'established_lessons:',
    ...roster.slice(0, 8).map((l, i) => `${i + 1}. ${l.slug}: ${cap(l.title ?? '', 80)}${l.triggers !== undefined && l.triggers.length > 0 ? ` [${l.triggers.slice(0, 6).join(',')}]` : ''}`),
  ]
  return lines.join('\n')
}

function contradictionWarningText(j: JevJudgment): string {
  const p = j.probability !== undefined ? `p=${j.probability.toFixed(2)}` : `outcome=${j.outcome}`
  if (j.band === 'record') return `\n⚠ jev 矛盾检测 record（${p}）：与现有 established lessons 存在一定重叠/张力——approve 仍执行（人审优先），建议复核。`
  if (j.outcome === 'ok') return `\n⚠ jev 矛盾检测 fallback（${p}）：判定为与现有 established lessons 矛盾——approve 仍执行（人审优先），强烈建议先比对。`
  return `\n⚠ jev 矛盾检测不可用（${j.outcome}）：本次按纯码放行，建议人工比对现有 established lessons。`
}

/**
 * The 门② warning line for an approve, '' when the layer is off/disabled,
 * the roster is empty (nothing to contradict), the candidate is unreadable,
 * or the band is adopt. The call itself never blocks the approve (红线②).
 */
async function contradictionWarning(slug: string, peer: PeerHandle, deps: ReviewCommandDeps): Promise<string> {
  const jev = deps.jev
  if (jev === undefined || !jev.enabled()) return ''
  const roster = peer.lessons()
  if (roster.length === 0) return ''
  const candidate = readLessonContent(deps.bundleRoot(), slug)
  if (candidate === undefined) return ''
  const ref = `lesson:${slug}`
  const judgment = (await jev
    .judge({
      gate: 'lesson-contradiction',
      state: contradictionState(candidate, roster),
      subjects: [{ ref, instructions: '这条候选 lesson 与现有 established lessons 矛盾吗', criteria: CONTRADICTION_CRITERIA }],
    })
    .catch(() => undefined))?.get(ref)
  return judgment !== undefined && judgment.band !== 'adopt' ? contradictionWarningText(judgment) : ''
}

// ---------------------------------------------------------------------------
// 门④ queue feed: still-installed retire suggestions from the decisions ledger
// ---------------------------------------------------------------------------

function installedCreatedOf(skillsRoot: string, name: string): string | undefined {
  try {
    return parseSkillMd(readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8'))?.created
  } catch {
    return undefined
  }
}

/** Suggestions whose skill is STILL installed (a decided one self-clears). */
function liveRetireSuggestions(deps: ReviewCommandDeps): { name: string; probability?: number; created?: string }[] {
  const jev = deps.jev
  if (jev === undefined || !jev.enabled()) return []
  const skillsRoot = deps.skillsRoot()
  const out: { name: string; probability?: number; created?: string }[] = []
  for (const s of retireSuggestions(jev.decisionsFile())) {
    if (!s.ref.startsWith('skill:')) continue
    const name = s.ref.slice('skill:'.length)
    const created = installedCreatedOf(skillsRoot, name)
    if (created === undefined) continue
    out.push({ name, ...(s.probability !== undefined ? { probability: s.probability } : {}), created })
  }
  return out
}

export function buildReviewCommand(deps: ReviewCommandDeps): CommandDefinition {
  const ledgerReview = (action: ReviewAction, object: string, extra?: { detail?: string; rollback?: string }): void => {
    deps.ledger.append({ at: deps.now(), kind: 'review', gate: deps.gate(), action, object, ...extra })
  }

  const queueSummary = (gate: ImproveLoopMode): string => {
    const drafts = listSkillDrafts(deps.draftsRoot())
    const lessons = listHintLessons(deps.bundleRoot())
    const retire = liveRetireSuggestions(deps)
    if (drafts.length === 0 && lessons.length === 0 && retire.length === 0) return '审批队列空。'
    const lines = [`审批队列（improveLoop=${gate}）${drafts.length + lessons.length + retire.length} 项：`]
    for (const d of drafts) lines.push(`  ${d.id}  草稿  created=${d.created ?? '?'}  证据: ${d.evidence ?? '-'}`)
    for (const l of lessons) lines.push(`  ${l.id}  hint  ${l.title ?? ''}  scope=${l.scope ?? 'workspace'}`)
    for (const r of retire) {
      const p = r.probability !== undefined ? `jev p=${r.probability.toFixed(2)}, ` : ''
      lines.push(`  skill:${r.name}  退役复审建议（${p}created=${r.created ?? '?'}）— 不自动删除；确认无价值：reject skill:${r.name}（归档卸装，可回滚）`)
    }
    lines.push('show <id> 看全文；approve <id> / reject <id> 处置。')
    return lines.join('\n')
  }

  return {
    name: 'improve-review',
    description: '自我改进审批队列：审阅/批准/拒绝 skill 草稿与 lesson hint',
    input: { hint: '空=队列 | show|approve|reject <id> | draft | triggers' },
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      try {
        const gate = deps.gate()
        const argv = invocation.rawInput.trim().split(/\s+/u).filter((s) => s !== '')
        const sub = argv[0] ?? ''

        if (sub === '' || sub === 'help' || sub === 'list') {
          if (gate === 'off') return { kind: 'success', text: `improveLoop=off：队列为空（回路关闭；generate/approve 均不可用）。\n${HELP}` }
          return { kind: 'success', text: `${queueSummary(gate)}\n${HELP}` }
        }

        if (sub === 'triggers') {
          // The engine's observation surface: read-only dry run, every gate
          // above off (human-initiated reads don't violate the off guard).
          if (gate === 'off') return { kind: 'error', text: MUTATION_TEXT_OFF }
          const view = await viewTriggers({
            ledgerFile: () => join(deps.bundleRoot(), 'meta', 'improve-actions.jsonl'),
            openPeer: () => deps.openPeer(),
            now: deps.now,
          })
          const lines = [`触发引擎（improveLoop=${gate}，窗口 ${view.windowDays} 天 / 阈值 ${view.threshold}，今日已 fire：${view.spentToday ? '是' : '否'}）`]
          if (view.candidates.length === 0) {
            lines.push('当前无候选（无同类失败聚簇达到阈值）。')
          }
          for (const c of view.candidates) {
            lines.push(`候选 ${c.key} ×${c.count}（最近 ${c.lastAt}）`)
            lines.push(`  判定：${TRIGGER_REASON_TEXT[c.reason] ?? c.reason} → ${c.wouldFire ? 'would-fire' : 'no-fire'}${gate === 'shadow' && c.wouldFire ? '（shadow：只记 would-fire 账，不产草稿）' : ''}`)
            for (const r of c.related) {
              const usage = r.hits !== undefined ? `，30 天注入 hits=${r.hits}/opens=${r.opens ?? 0}` : ''
              lines.push(`  相关 established lesson：${r.slug}${usage}`)
            }
          }
          lines.push('（判定依据 = 行动账信号聚簇 + peer established lesson roster 词面交集 + 账内批准时间；无写动作）')
          return { kind: 'success', text: lines.join('\n') }
        }

        if (sub === 'draft') {
          const outcome = await generateSkillDraft({ kind: 'manual', evidence: [] }, {
            gate: () => gate,
            ledger: deps.ledger,
            ledgerFile: () => join(deps.bundleRoot(), 'meta', 'improve-actions.jsonl'),
            draftsRoot: deps.draftsRoot,
            now: deps.now,
            ...(deps.llm !== undefined ? { llm: deps.llm } : {}),
          })
          if (outcome.status === 'created') {
            return { kind: 'success', text: `草稿已生成：${outcome.file}\n证据: ${outcome.evidence}\n用 /improve-review show skill:${outcome.name} 审阅。` }
          }
          const why: Record<string, string> = {
            'gate-off': 'improveLoop=off：草稿生成被拒绝（已落账）',
            'daily-cap': '已达每日草稿上限（每日 ≤1，已落账）',
            'secret-gate': 'secret gate 拦截（已落账，未出网/未落盘）',
            'check-failed': '影子自验未过，不进队列（已落账）',
            'quality-gate': 'jev 质量门未过（<0.10），不进队列，草稿已归档（已落账）',
            'no-evidence': '行动账近 7 天无信号，无证据可起稿',
            'trigger-declined': '触发引擎未放行（cluster 请求须引擎 BL-3 清关；已落账）',
            'write-failed': '草稿落盘失败（已落账）',
            collision: '同名草稿非本插件产物，拒绝覆盖（已落账）',
            'llm-failed': 'LLM 调用失败（fail-open，已落账）',
          }
          return { kind: 'error', text: `草稿未生成：${why[outcome.reason] ?? outcome.reason}${outcome.detail !== undefined ? `（${outcome.detail}）` : ''}` }
        }

        const id = argv.length >= 2 ? parseReviewId(argv[1] ?? '') : undefined
        if ((sub === 'show' || sub === 'approve' || sub === 'reject') && id === undefined) {
          return { kind: 'error', text: `用法：/improve-review ${sub} <skill:名字|lesson:slug>` }
        }

        if (sub === 'show') {
          if (gate === 'off') return { kind: 'error', text: MUTATION_TEXT_OFF }
          if (id!.startsWith('skill:')) {
            const entry = listSkillDrafts(deps.draftsRoot()).find((d) => d.id === id)
            if (entry === undefined) return { kind: 'error', text: `队列中没有 ${id}` }
            let text: string
            try {
              text = readFileSync(entry.file, 'utf8')
            } catch {
              return { kind: 'error', text: `草稿读取失败：${entry.file}` }
            }
            // 第五增强 (N4): the machine summary stays verbatim; when the
            // distilled LLM route answers, a pro/con block is inserted before
            // the full text. Any failure (no credential, timeout, bad shape)
            // leaves the N3 output byte-identical.
            const machine = `${id} 的证据摘要（机器拼，信号计数+来源）：\n  ${entry.evidence ?? '-'}`
            const proCon = await draftProCon({
              id: id!,
              ...(entry.evidence !== undefined ? { evidence: entry.evidence } : {}),
              draftText: text,
              cacheFile: join(deps.bundleRoot(), 'meta', 'improve-summaries.jsonl'),
              ...(deps.llm !== undefined ? { llm: deps.llm } : {}),
              now: deps.now,
            }).catch(() => undefined)
            const block = proCon !== undefined ? `\n\nLLM 正反方摘要（${DRAFT_LLM_MODEL}）：\n  正方: ${proCon.pro}\n  反方: ${proCon.con}` : ''
            return { kind: 'success', text: `${machine}${block}\n\n——— SKILL.md 全文 ———\n${text}` }
          }
          const lesson = listHintLessons(deps.bundleRoot()).find((l) => l.id === id)
          if (lesson === undefined) return { kind: 'error', text: `队列中没有 ${id}` }
          let text: string
          try {
            text = readFileSync(lesson.file, 'utf8')
          } catch {
            return { kind: 'error', text: `lesson 读取失败：${lesson.file}` }
          }
          return { kind: 'success', text: `${id}（hint，仅供审批展示，从不注入）：\n\n——— bundle 全文 ———\n${text}` }
        }

        if (sub === 'approve' || sub === 'reject') {
          const approve = sub === 'approve'
          if (gate !== 'on') {
            ledgerReview('mutation-gate-refused', id!, { detail: `gate=${gate}` })
            return { kind: 'error', text: gate === 'off' ? MUTATION_TEXT_OFF : MUTATION_TEXT_SHADOW }
          }
          if (id!.startsWith('lesson:')) {
            const slug = id!.slice('lesson:'.length)
            const peer = await deps.openPeer()
            if (peer?.setLessonStatus === undefined) {
              ledgerReview('mutation-degraded', id!, { detail: 'topics-memory-unavailable' })
              return { kind: 'error', text: 'topics-memory 不可用：lessons 回路停摆（§6.3 降级），动作已落账。' }
            }
            // 门② (N4): 固化前的矛盾检测 — adopt → silent; record/fallback →
            // warning line, the human's approve still proceeds (人审优先).
            const warn = approve ? await contradictionWarning(slug, peer, deps).catch(() => '') : ''
            try {
              const actor = `dsh-self-improve:${String(invocation.agent?.id ?? 'manual')}`
              const result = await peer.setLessonStatus(slug, approve ? 'established' : 'removed', { actor })
              ledgerReview(approve ? 'approved' : 'rejected', id!, { rollback: `seam=setLessonStatus to=${approve ? 'established' : 'removed'} slug=${slug} actor=${actor}` })
              const text = seamResultText(result.ok, result.reason, approve ? 'approve' : 'reject', slug) + warn
              return result.ok ? { kind: 'success', text } : { kind: 'error', text }
            } catch (e) {
              ledgerReview('mutation-degraded', id!, { detail: `seam-failed:${e instanceof Error ? e.name : 'unknown'}` })
              return { kind: 'error', text: '写缝调用失败（fail-open），动作已落账。' }
            }
          }
          // skill mutation
          if (approve) {
            const outcome = installSkill(id!, { gate, draftsRoot: deps.draftsRoot(), skillsRoot: deps.skillsRoot() })
            if (outcome.status === 'installed') {
              ledgerReview('approved', id!, {
                ...(outcome.adjusted ? { detail: `installed-as=${outcome.dir.split('/').pop()}` } : {}),
                rollback: `installed=${outcome.dir} backup=${outcome.backupDir}`,
              })
              const note = outcome.adjusted ? `\n注意：同名 skill 已存在，已按规则以 -auto 后缀装机。` : ''
              return { kind: 'success', text: `已装机：${outcome.dir}/SKILL.md（草稿已归档为装机备份）${note}` }
            }
            if (outcome.reason === 'collision' && outcome.detail !== undefined && outcome.detail.includes('合并')) {
              ledgerReview('mutation-collision', id!, { detail: 'merge-required' })
              return { kind: 'error', text: `装机拒绝：${outcome.detail}。合并方案：人工比对 ~/.dsh/skills/ 与草稿内容，合并后 reject 草稿。` }
            }
            const why: Record<string, string> = {
              gate: MUTATION_TEXT_SHADOW,
              'missing-draft': `队列中没有 ${id}`,
              'not-ours': `装机拒绝：${id} 缺 source: auto-generated 标记（绝不碰非本插件产物）`,
              collision: `装机失败（已落账）`,
            }
            if (outcome.reason === 'collision' || outcome.reason === 'not-ours') ledgerReview('mutation-collision', id!, { detail: outcome.detail ?? outcome.reason })
            return { kind: 'error', text: why[outcome.reason] ?? '装机失败' }
          }
          const outcome = archiveDraft(id!, { gate, draftsRoot: deps.draftsRoot() })
          if (outcome.status === 'archived') {
            ledgerReview('rejected', id!, { rollback: `archived=${outcome.dir}` })
            return { kind: 'success', text: `已拒绝并归档：${id} → ${outcome.dir}` }
          }
          // 门④ adjudication (N4): no live draft, but an INSTALLED
          // auto-generated skill → reject = retire-uninstall (archived copy,
          // rollback-able). Hand-written skills are refused (绝不碰手写).
          const retired = retireInstalledSkill(id!, { gate, skillsRoot: deps.skillsRoot(), draftsRoot: deps.draftsRoot() })
          if (retired.status === 'retired') {
            ledgerReview('rejected', id!, { rollback: `uninstalled=${retired.dir} archived=${retired.archiveDir}` })
            return { kind: 'success', text: `已退役并卸装：${id}\n  备份：${retired.archiveDir}（回滚 = 将该目录拷回 ${retired.dir}）` }
          }
          ledgerReview(outcome.reason === 'gate' ? 'mutation-gate-refused' : 'mutation-collision', id!, { detail: outcome.reason })
          return { kind: 'error', text: outcome.reason === 'gate' ? MUTATION_TEXT_SHADOW : `队列中没有 ${id}` }
        }

        return { kind: 'error', text: `未知子命令「${sub}」。\n${HELP}` }
      } catch (e) {
        // The command surface is fail-open: a bug here must never break the
        // host session — settle as an error result (红线②).
        return { kind: 'error', text: `/improve-review 内部错误（已吞错）：${e instanceof Error ? e.name : 'unknown'}` }
      }
    },
  }
}

/**
 * Mount the command through the shared dsh-commands registry (the topics
 * vault pattern): hosts without the service never see a registration, and
 * the off-guard's zero-firehose-listener property is untouched — this is a
 * human-initiated surface, not a loop lane.
 */
export function registerReviewCommand(ctx: unknown, deps: ReviewCommandDeps): void {
  try {
    const host = ctx as { inject?: (services: string[], fn: (sub: unknown) => void) => void }
    if (typeof host.inject !== 'function') return
    host.inject(['commands'], (sub) => {
      const c = sub as {
        commands?: { register: (d: CommandDefinition) => unknown }
        effect?: (fn: () => unknown, label?: string) => unknown
      }
      if (c?.commands === undefined || typeof c.commands.register !== 'function') return
      // e2e B1 regression guard: calling the extracted bare function loses the
      // CommandRuntime receiver (`this.layers` → TypeError, silently eaten by
      // effect containment) and /improve-review silently never registers.
      const register = () => c.commands!.register(buildReviewCommand(deps))
      if (typeof c.effect === 'function') c.effect(register, 'improve: /improve-review')
      else void register()
    })
  } catch {
    // Contained: a registry hiccup only costs the command (红线②).
  }
}

// Re-exported so index.ts wires one import surface.
export { defaultDraftsRoot, defaultSkillsRoot, generateSkillDraft }
