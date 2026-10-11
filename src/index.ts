/**
 * dsh-self-improve — the self-improvement loop for dsh (wave 2 of the
 * wayfinder self-improve map; spec 卷二 is the contract).
 *
 * Wave-2 shape (spec §1-§7): session-signal collector (B1's six-signal
 * shortlist) → structured observation feed into topics-memory via its
 * export seam → distill produces `lesson` topics → /improve-review approval
 * queue → skill drafts (shadow-verified) install to ~/.dsh/skills, never
 * overwriting hand-written skills. Tiered gating per B4: low-risk auto,
 * high-risk human-reviewed; two-repo gates (`improveLoop` here,
 * `lessonInject` in topics-memory).
 *
 * This scaffold boots as an inert plugin — every loop surface lands in
 * implementing commits behind the default-off `improveLoop` gate.
 */

export const name = 'dsh-self-improve'

export interface SelfImproveConfig {
  improveLoop?: 'off' | 'shadow' | 'on'
}

export async function apply(ctx: unknown, config: SelfImproveConfig = {}): Promise<void> {
  // Inert until wave-2 lands; the gate defaults to off and must stay a
  // no-op when off (default-off byte-for-byte house rule).
  void ctx
  void config.improveLoop
}
