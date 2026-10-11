/**
 * Session-signal collector (wave N1, spec 卷二 §2): eavesdrops the session
 * firehose and distills the B1 v1 signal shortlist into StructuredObservations
 * — field whitelist, features and counts ONLY (红线⑤: conversation text,
 * tool-call arguments and error reason bodies never leave the process).
 *
 * Wave-N1 active set (five of the six; jev-calibration lands with the N4
 * decision layer):
 *
 *   1. tool-error           — firehose `tool/call` (callId → name) + `tool/result`
 *                             isError + error.{name,code}; `error.reason` is
 *                             deliberately dropped (it is model-adjacent text).
 *   2. turn-end-negative    — `turn/end` reason ∈ {error, max-tokens, aborted};
 *                             the LlmFailure contributes its machine code only.
 *   3. repeat-call          — eavesdrops the host dsh-repeat-tool-reminder's
 *                             injected source (`MessageSourceMap
 *                             ['repeat-tool-reminder']`); one struggle event per
 *                             reminder. The reminder's own detection (canonical
 *                             arguments chain key) is host-owned — never
 *                             reimplemented here, and its arguments text never
 *                             read.
 *   4. interruption-pair    — aborted turn-end / interrupted assistant message,
 *                             then the next human (`source.kind === 'user'`)
 *                             message: occurrence + turn position only.
 *   5. unused-injection     — periodic (not firehose): the ilog aggregate
 *                             「injected ≥1, opens = 0 over the 30-day window」.
 *                             Lives in feed.ts (it reads the topics bundle, not
 *                             the firehose); this module only owns the four
 *                             firehose signals.
 *
 * Every handler is total: a malformed event degrades to "no observation",
 * never a throw into the host (red line ② fail-open).
 *
 * @module signals
 */

import type { StructuredObservation } from '@aiwayds/dsh-topics-memory'

/** Whitelist value caps — features stay features, never smuggled text. */
const TOOL_NAME_MAX_CHARS = 128
const ERROR_NAME_MAX_CHARS = 64
const ERROR_CODE_MAX_CHARS = 64
/** Per-session tool/call identity cap: one entry per in-flight call, FIFO. */
const CALL_NAMES_CAP = 256
/** Per-session unflushed buffer cap (a healthy session flushes every turn). */
const BUFFER_CAP = 200

/** Bounded string copy for whitelist detail fields. */
function feat(raw: unknown, cap: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim()
  return v === '' ? undefined : v.slice(0, cap)
}

function featInt(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : undefined
}

/** Firehose `tool/call` — the only event carrying the tool NAME for a callId. */
interface ToolCallData {
  callId?: unknown
  name?: unknown
}

/** Firehose `tool/result` — failure flag + structured failure identity. */
interface ToolResultData {
  turn?: unknown
  message?: { isError?: unknown }
  error?: { name?: unknown; code?: unknown }
}

/** Firehose `turn/end` — TurnEndReason sum type, envelope fields only. */
interface TurnEndData {
  turn?: unknown
  reason?: {
    kind?: unknown
    /** reason.kind === 'error': LlmFailure — only `code` may pass. */
    error?: { code?: unknown }
    /** reason.kind === 'aborted': TurnEndCancelCause — only `kind` passes. */
    reason?: { kind?: unknown }
  }
}

/** Firehose `assistant/message` — only the interrupted marker is read. */
interface AssistantMessageData {
  turn?: unknown
  interrupted?: unknown
}

/** Firehose `user/message` — only `source.kind` (and the reminder's bounded
 *  `summary` metadata) is read; `content` is conversation text and is never
 *  touched. */
interface UserMessageData {
  source?: { kind?: unknown; summary?: unknown }
}

/** A pending interruption: armed by aborted/interrupted, consumed by steer. */
interface PendingInterruption {
  turn: number
  trigger: 'aborted' | 'interrupted'
}

export interface SignalCollectorHooks {
  /**
   * Drain point: called once per `turn/end` with the observations buffered
   * since the previous turn end (spec: firehose signals feed per TURN, one
   * batch, never per event). Empty batches do not call this.
   */
  flush(sessionId: string, observations: readonly StructuredObservation[]): void
  /**
   * Turn-end notification, EVERY turn end (empty or not) — the feed-cadence
   * anchor for non-signal work like the periodic unused-injection check.
   */
  turnEnd?(sessionId: string): void
}

export class SignalCollector {
  private readonly hooks: SignalCollectorHooks
  private readonly now: () => string
  /** callId → tool name, per session — the tool-error observation's name source. */
  private readonly callNames = new Map<string, Map<string, string>>()
  /** Unflushed observations, per session. */
  private readonly buffers = new Map<string, StructuredObservation[]>()
  /** Armed interruption pending the steering user message, per session. */
  private readonly pendingSteer = new Map<string, PendingInterruption>()

  constructor(hooks: SignalCollectorHooks, now: () => string = () => new Date().toISOString()) {
    this.hooks = hooks
    this.now = now
  }

  /**
   * One firehose event. `type`/`data` are the SessionEventMap envelope as
   * topics-memory's `session/event` listener receives them; unknown types
   * are ignored (merge-extensible surface).
   */
  onSessionEvent(sessionId: string, type: string, data: unknown): void {
    try {
      if (type === 'tool/call') this.onToolCall(sessionId, data as ToolCallData)
      else if (type === 'tool/result') this.onToolResult(sessionId, data as ToolResultData)
      else if (type === 'assistant/message') this.onAssistantMessage(sessionId, data as AssistantMessageData)
      else if (type === 'user/message') this.onUserMessage(sessionId, data as UserMessageData)
      else if (type === 'turn/end') this.onTurnEnd(sessionId, data as TurnEndData)
    } catch {
      // Contained: a collector bug must never break the event dispatch.
    }
  }

  /** Session teardown: drop every per-session structure (map hygiene). */
  disposeSession(sessionId: string): void {
    this.callNames.delete(sessionId)
    this.buffers.delete(sessionId)
    this.pendingSteer.delete(sessionId)
  }

  // -- signal 1: tool-error -------------------------------------------------

  private onToolCall(sessionId: string, data: ToolCallData): void {
    const callId = feat(data.callId, 128)
    const name = feat(data.name, TOOL_NAME_MAX_CHARS)
    if (callId === undefined || name === undefined) return
    let map = this.callNames.get(sessionId)
    if (map === undefined) {
      map = new Map()
      this.callNames.set(sessionId, map)
    }
    if (map.size >= CALL_NAMES_CAP) {
      // FIFO drop of the oldest entry — bounded memory, latest calls win.
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    map.set(callId, name)
  }

  private onToolResult(sessionId: string, data: ToolResultData): void {
    if (data.message?.isError !== true) return
    const turn = featInt(data.turn)
    const callId = feat((data.message as { toolCallId?: unknown }).toolCallId, 128)
    const name = this.callNames.get(sessionId)?.get(callId ?? '') ?? 'unknown'
    const detail: NonNullable<StructuredObservation['detail']> = { toolName: name }
    if (turn !== undefined) detail.turn = turn
    const errorName = feat(data.error?.name, ERROR_NAME_MAX_CHARS)
    const errorCode = feat(data.error?.code, ERROR_CODE_MAX_CHARS)
    // `error.reason` is deliberately NOT copied — it is the failure's
    // user-facing text body (红线⑤).
    if (errorName !== undefined) detail.errorName = errorName
    if (errorCode !== undefined) detail.errorCode = errorCode
    this.emit(sessionId, { type: 'tool-error', detail })
  }

  // -- signal 2 + 4 (arming): turn-end --------------------------------------

  private onTurnEnd(sessionId: string, data: TurnEndData): void {
    const turn = featInt(data.turn)
    const kind = data.reason?.kind
    if (kind === 'error' || kind === 'max-tokens' || kind === 'aborted') {
      const detail: NonNullable<StructuredObservation['detail']> = { reason: kind }
      if (turn !== undefined) detail.turn = turn
      if (kind === 'error') {
        const errorCode = feat(data.reason?.error?.code, ERROR_CODE_MAX_CHARS)
        if (errorCode !== undefined) detail.errorCode = errorCode
      }
      if (kind === 'aborted') {
        const cancelKind = feat(data.reason?.reason?.kind, 32)
        if (cancelKind !== undefined) detail.cancelKind = cancelKind
        this.armSteer(sessionId, turn, 'aborted')
      }
      this.emit(sessionId, { type: 'turn-end-negative', detail })
    }
    // Every turn end is a feed cadence point — the buffer drains exactly
    // here (empty buffers skip the flush hook), and the wiring gets a
    // per-turn tick for non-signal periodic work.
    this.drain(sessionId)
    try {
      this.hooks.turnEnd?.(sessionId)
    } catch {
      // Contained.
    }
  }

  // -- signal 4 (arming): interrupted assistant prefix -----------------------

  private onAssistantMessage(sessionId: string, data: AssistantMessageData): void {
    if (data.interrupted !== true) return
    this.armSteer(sessionId, featInt(data.turn), 'interrupted')
  }

  private armSteer(sessionId: string, turn: number | undefined, trigger: PendingInterruption['trigger']): void {
    this.pendingSteer.set(sessionId, { turn: turn ?? -1, trigger })
  }

  // -- signal 3 (repeat-call) + 4 (steer side): user/message -----------------

  private onUserMessage(sessionId: string, data: UserMessageData): void {
    const kind = data.source?.kind
    if (kind === 'repeat-tool-reminder') {
      this.emitRepeatCall(sessionId, data.source?.summary)
      return
    }
    if (kind === 'user') {
      const pending = this.pendingSteer.get(sessionId)
      if (pending === undefined) return
      this.pendingSteer.delete(sessionId)
      const detail: NonNullable<StructuredObservation['detail']> = { trigger: pending.trigger }
      if (pending.turn >= 0) detail.turn = pending.turn
      this.emit(sessionId, { type: 'interruption-pair', detail })
    }
  }

  /**
   * The host reminder's `summary` metadata is the bounded one-liner
   * `${toolName} × ${count}` (CONTEXT_SUMMARY_MAX_CHARS) — metadata, not
   * content. Parsed into its two features; an unparseable summary still
   * counts the struggle event, with no fields guessed.
   */
  private emitRepeatCall(sessionId: string, summary: unknown): void {
    const detail: NonNullable<StructuredObservation['detail']> = {}
    if (typeof summary === 'string') {
      const m = /^(.+) × (\d+)$/u.exec(summary.trim())
      const toolName = m === null ? undefined : feat(m[1], TOOL_NAME_MAX_CHARS)
      const count = m === null ? undefined : featInt(Number(m[2]))
      if (toolName !== undefined) detail.toolName = toolName
      if (count !== undefined) detail.count = count
    }
    if (detail.toolName === undefined && detail.count === undefined) detail.detected = 1
    this.emit(sessionId, { type: 'repeat-call', detail })
  }

  // -- buffering + drain ------------------------------------------------------

  private emit(sessionId: string, partial: { type: string; detail: NonNullable<StructuredObservation['detail']> }): void {
    let buffer = this.buffers.get(sessionId)
    if (buffer === undefined) {
      buffer = []
      this.buffers.set(sessionId, buffer)
    }
    if (buffer.length >= BUFFER_CAP) buffer.shift()
    buffer.push({ type: partial.type, at: this.now(), sessionId, detail: partial.detail })
  }

  private drain(sessionId: string): void {
    const buffer = this.buffers.get(sessionId)
    if (buffer === undefined || buffer.length === 0) return
    this.buffers.delete(sessionId)
    try {
      this.hooks.flush(sessionId, buffer)
    } catch {
      // Contained: the flush hook is fire-and-forget and must not throw here.
    }
  }
}
