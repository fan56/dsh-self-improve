/**
 * The action ledger — `meta/improve-actions.jsonl` (spec 卷二 §5.2): the
 * loop's auditable account of everything it did. One JSON object per line,
 * jev-log discipline throughout:
 *
 *   - field whitelist — entries are typed literals; nothing free-form can
 *     enter (the observation `type`/`detail` copied here are already
 *     feature-only output of the collector);
 *   - 512KB compaction — past the cap the file rewrites to its newest three
 *     quarters (the shadow-ledger pattern, topics-memory appendShadowLedger);
 *   - silent on failure — a broken ledger path never breaks the loop lane
 *     (red line ② fail-open); failures are swallowed.
 *
 * Gate semantics (spec §7 MJ-A): shadow writes signal lines only (never
 * feeds); on writes signal lines AND one feed-result line per feed; a
 * missing topics-memory peer writes a throttled feed-degraded line. The
 * ledger has no key of its own — it lives and dies with `improveLoop`.
 *
 * @module ledger
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { StructuredObservation } from '@aiwayds/dsh-topics-memory'

/** Feature map copied verbatim from a collector observation (already
 *  bounded scalar fields; re-checked here so the ledger is self-contained). */
export type FeatureDetail = NonNullable<StructuredObservation['detail']>

export type ActionLedgerEntry =
  | {
      at: string
      kind: 'signal'
      gate: 'shadow' | 'on'
      sessionId?: string
      type: string
      detail?: FeatureDetail
    }
  | {
      at: string
      kind: 'feed'
      gate: 'on'
      count: number
      accepted: number
      duplicates: number
      rejected: number
    }
  | {
      at: string
      kind: 'feed-degraded'
      gate: 'shadow' | 'on'
      reason: string
    }

/** Entries above this size compact to the newest three quarters. */
export const LEDGER_MAX_BYTES = 512 * 1024

export class ActionLedger {
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  get path(): string {
    return this.file
  }

  /**
   * Append one whitelisted entry. The file is read-appended (existing lines
   * always preserved); past 512KB it compacts to the newest three quarters —
   * the same shape as the peer's shadow ledger, with one deliberate
   * divergence: that one skips the read below the cap (an append becomes a
   * one-line overwrite); ours reads unconditionally so the account actually
   * accumulates. Whole-file rewrite, silent on any failure (red line ②).
   */
  append(entry: ActionLedgerEntry): void {
    try {
      let lines: string[] = []
      try {
        lines = readFileSync(this.file, 'utf8').split('\n').filter((l) => l !== '')
        if (lines.length > 0 && statSync(this.file).size > LEDGER_MAX_BYTES) {
          lines = lines.slice(Math.floor(lines.length / 4))
        }
      } catch {
        // First write, or the file vanished between calls — start fresh.
      }
      lines.push(JSON.stringify(entry))
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, lines.join('\n') + '\n')
    } catch {
      // The ledger must never break the lane (red line ②).
    }
  }
}
