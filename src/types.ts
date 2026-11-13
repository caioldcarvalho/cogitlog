export type SessionOutcome = 'completed' | 'partial' | 'abandoned' | 'interrupted'
export type AttemptOutcome = 'succeeded' | 'failed' | 'partial'
export type IndexOutcome = SessionOutcome | 'in_progress'

export interface FileRef {
  path: string
  base_commit: string | null
  dirty: boolean
}

interface BaseEvent {
  session_id: string
  seq: number
  type: string
  at: string
}

/**
 * Fields shared by every event that carries prose.
 *
 * `description` is the one-line summary used by query/log/show. It is optional on
 * disk: events written before spec 0.4 have none, and readers fall back to the
 * first line of `body` (see `describeEvent`). `links` holds session ids this event
 * points at — from `--relates-to` or `[[session-id]]` written inline in the body.
 */
interface ProseEvent extends BaseEvent {
  body: string
  description?: string | null
  links?: string[]
  /** Spec 0.5+. "observer" when `cogitlog observe` extracted this event from an agent
   *  transcript instead of someone recording it. Absent means written by hand. */
  source?: 'observer'
  /** Spec 0.5+, observer only. The verbatim transcript quote the event was checked against. */
  evidence?: string
}

export interface BeginEvent extends BaseEvent {
  type: 'begin'
  intent: string
  context: string | null
  git_head: string | null
  resumed_from: string | null
  source?: 'observer'
}

export interface NoteEvent extends ProseEvent {
  type: 'note'
  files: FileRef[]
}

export interface DecisionEvent extends ProseEvent {
  type: 'decision'
  alternatives: Array<{ option: string; reason_rejected: string }>
  files: FileRef[]
}

export interface AttemptEvent extends ProseEvent {
  type: 'attempt'
  outcome: AttemptOutcome
  reason: string | null
  files: FileRef[]
}

export interface UncertaintyEvent extends ProseEvent {
  type: 'uncertainty'
  files: FileRef[]
}

export interface CloseEvent extends BaseEvent {
  type: 'close'
  outcome: SessionOutcome
  outcome_note: string | null
  files: FileRef[]
}

export type SessionEvent =
  | BeginEvent
  | NoteEvent
  | DecisionEvent
  | AttemptEvent
  | UncertaintyEvent
  | CloseEvent

/** One line of the scannable summary an index entry carries for its session. */
export interface DigestEntry {
  seq: number
  type: string
  description: string
}

export interface IndexEntry {
  session_id: string
  index_version: number
  started_at: string
  closed_at: string | null
  agent: { tool: string; model: string | null }
  git_head: string | null
  intent: string
  outcome: IndexOutcome
  outcome_note: string | null
  files: string[]
  tags: string[]
  /** Spec 0.4+. One description per event, so the whole store can be scanned
   *  without opening session files. Absent on entries written by older versions —
   *  `cogitlog repair` backfills it. */
  digest?: DigestEntry[]
  /** Spec 0.4+. Union of every `links` array in the session's events. */
  links?: string[]
}

export interface Config {
  spec_version: string
  created_at: string
}
