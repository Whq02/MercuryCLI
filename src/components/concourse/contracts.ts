
export type ConcourseLifecycleLabel =
  | 'draft'
  | 'queued'
  | 'starting'
  | 'working'
  | 'needs-you'
  | 'stalled'
  | 'ready-to-review'
  | 'paused'
  | 'attached'
  | 'stopped'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'parked'
  | 'elsewhere'

export interface ConcourseElsewhereV1 {
  dir: string
  key: string
  name: string
  running: number
  needsYou: number
  finished: number
}

export interface ConcourseRowV1 {
  sessionId: string
  title: string
  state: ConcourseLifecycleLabel
  projectLabel: string
  ownerLabel: string | null
  ageLabel: string | null
  modelId?: string
  seats: { held: number; ceiling: number } | 'waits' | null
  nowLabel?: string | null
  workflowsAllowed?: boolean
  scheduleNextFireMs?: number
  workspaceDir?: string
  worktreeBranch?: string
  waitReason?: 'seat' | 'repo-held' | 'session-paused' | 'session-retiring' | 'no-repository' | 'git-unavailable' | 'unborn-head' | 'unblocked'
  waitDetail?: string
  transcriptPath?: string
  foreignProject?: string
  door?:
    | { kind: 'switch-project'; dir: string; running: number; needsYou: number; finished: number }
    | { kind: 'pick-project'; more: number }
}

export function concourseWaitCopy(reason?: string, byTitle?: string): string {
  switch (reason) {
    case 'repo-held':
      return `repo held by ${byTitle ?? 'a live session'}`
    case 'unblocked':
      return 'unblocked — replay starts it'
    case 'session-paused':
      return 'held — the target is paused'
    case 'session-retiring':
      return 'held — the target is parking'
    case 'no-repository':
    case 'unborn-head':
      return 'needs git — say yes to the offer'
    case 'git-unavailable':
      return 'needs git installed'
    default:
      return 'waits for a seat'
  }
}

export interface ConcourseSnapshotV1 {
  schema: 1
  revision: number
  clock: string
  context: { projectLabel: string; operatorHandle: string; effortLabel?: string }
  breadcrumb: { active: 'boot' | 'concourse' | 'main-repl' }
  coordinator: {
    mode: 'off' | 'rules-only' | 'agent-assisted'
    assistModelLabel?: string
    assistModelAvailability?: import('../../services/concourse/coordinatorModels.js').CoordinatorModelAvailability
    assistModelStatus?: string
    fallbackReason?: string
  }
  mainRepl: {
    kind: 'non-model-controller'
    counted: false
    submission: 'disabled-while-parked'
    reachedBy: 'esc'
  }
  counts: {
    live: number
    needsYou: number
    working: number
    queued: number
    seatsHeld: number
    seatsDenominator: number
    admission: 'auto-balanced' | 'fixed'
  }
  needsYou: Array<{
    obligationId: string
    sessionId: string
    title: string
    question: string
    projectLabel: string
    agentLabel: string
    ageLabel: string
    ref?: string
    foreignProject?: { dir: string; name: string }
  }>
  groups: Array<{
    id: 'attached' | 'needs-you' | 'stalled' | 'ready-to-review' | 'working' | 'queued' | 'starting' | 'paused' | 'stopped' | 'elsewhere' | 'parked'
    label: string
    rows: ConcourseRowV1[]
  }>
  elsewhere?: ConcourseElsewhereV1[]
  peek: null | {
    sessionId: string
    title: string
    state: ConcourseLifecycleLabel
    projectLabel: string
    agentLabel: string
    modelLabel: string
    seats: { held: number; ceiling: number } | null
    timeline: Array<{ clock: string; label: string }>
    scope: { kind: 'clear' } | { kind: 'overlap'; detail: string }
    actions: Array<'enter-full-session' | 'pause-after-turn' | 'redirect' | 'resume'>
    settings?: { revisionLabel: string; profileRevision: number; current: boolean }
    identityColor?: string
    residentState: 'settled' | 'empty' | 'wink' | 'refused' | 'molt' | 'held'
    residentReason?: string
  }
  newSession: {
    seeds: {
      projectLabel: string
      agentLabel: string
      modelLabel: string
      modelId: string
      modelIsDefault: boolean
      effortLevel: string
      effortIsDefault: boolean
      isolation: 'isolated-worktree' | 'exclusive' | 'shared-read-only'
      seatsMax: 1 | 2
    }
    draft: string
    draftCaret?: number
    modelOptions?: Array<{ modelId: string; displayName: string }>
    advancedAvailable?: boolean
    titleSeed?: string
    preflight?: { ok: boolean; refusals: string[] }
  }
}

export type ConcourseBoardRow =
  | { kind: 'group'; id: string; label: string; count: number }
  | { kind: 'session'; row: ConcourseRowV1 }

export function boardRowsOf(snapshot: ConcourseSnapshotV1): ConcourseBoardRow[] {
  const out: ConcourseBoardRow[] = []
  for (const g of snapshot.groups) {
    out.push({ kind: 'group', id: g.id, label: g.label, count: g.rows.length })
    for (const row of g.rows) out.push({ kind: 'session', row })
  }
  return out
}

export function stableSelectionFallback(
  ids: readonly string[],
  sel: string | null,
  lastIdx: number,
): { sessionId: string | null; index: number } {
  const at = sel === null ? -1 : ids.indexOf(sel)
  if (at >= 0) return { sessionId: sel, index: at }
  if (ids.length === 0) return { sessionId: null, index: 0 }
  const index = Math.min(lastIdx, ids.length - 1)
  return { sessionId: ids[Math.max(0, index)] ?? null, index: Math.max(0, index) }
}

export function deriveEffectivePeek(
  storePeek: ConcourseSnapshotV1['peek'],
  sessionRows: readonly ConcourseRowV1[],
  selectedId: string | null,
): ConcourseSnapshotV1['peek'] {
  const selRow = selectedId !== null ? sessionRows.find(r => r.sessionId === selectedId) : undefined
  if (storePeek === null || selRow === undefined || storePeek.sessionId === selRow.sessionId) return storePeek
  return {
    sessionId: selRow.sessionId,
    title: selRow.title,
    state: selRow.state,
    projectLabel: selRow.projectLabel,
    agentLabel: selRow.ownerLabel ?? 'Mercury',
    modelLabel: '—',
    seats: typeof selRow.seats === 'string' ? null : selRow.seats,
    timeline: [],
    scope: { kind: 'clear' as const },
    actions: [
      'enter-full-session' as const,
      ...(selRow.state === 'working' || selRow.state === 'needs-you' || selRow.state === 'ready-to-review'
        ? (['pause-after-turn', 'redirect'] as const)
        : []),
      ...(selRow.state === 'paused' ? (['resume'] as const) : []),
    ],
    residentState: 'settled' as const,
  }
}

export type ControlNoteKind = 'pending' | 'applied' | 'held' | 'refused' | 'failed'
export interface ControlNote {
  state: ControlNoteKind
  reason?: string
  next?: string
}
export type ControlNoteState = ControlNoteKind | ControlNote

export const controlNoteOf = (n: ControlNoteState): ControlNote =>
  typeof n === 'string' ? { state: n } : n

export interface ConcourseCallbacks {
  enterSession: (sessionId: string) => void
  resumeOlderChat?: (sessionId: string, transcriptPath: string, title: string) => void
  newSession?: (opts?: { contractText?: string }) => void
  openQueuedRoom?: (sessionId: string) => void
  daemonOfferArmed?: () => boolean
  answerDaemonOffer?: (yes: boolean) => void
  noteControl?: (control: string, state: ControlNoteState) => void
  peekSession: (sessionId: string) => void
  answerObligation: (obligationId: string, answer: string) => void
  answerPermission?: (requestId: string, allow: boolean, obligationId: string) => void
  openObligation: (obligationId: string) => void
  claimObligation: (obligationId: string) => void
  withdrawObligation: (obligationId: string) => void
  pauseAfterTurn: (sessionId: string) => void
  resumeSession: (sessionId: string) => void
  interruptSession?: (sessionId: string) => void
  setSessionModel?: (sessionId: string, modelId: string, displayName?: string) => void
  setSessionEffort?: (sessionId: string, effort: string) => void
  stopSession?: (sessionId: string) => void
  archiveSession?: (sessionId: string) => void
  removeSession?: (sessionId: string) => void
  renameSession?: (sessionId: string, title: string) => void
  redirectSession: (sessionId: string, instruction: string) => void
  startSessionDraft: (text: string, caret?: number) => void
  setDraftSeed: (patch: {
    projectDir?: string | null
    modelKey?: string | null
    effort?: string | null
    isolation?: 'isolated-worktree' | 'exclusive' | 'shared-read-only' | null
    title?: string | null
    agentName?: string | null
    seatsMax?: 1 | 2 | null
  }) => void
  submitSessionDraft: (text: string) => void
  enterBootSettings: () => void
  exitToRepl: () => void
  retrySnapshot?: () => void
  sendCoordinatorMessage?: (
    text: string,
    clientMessageId?: string,
    onAccepted?: () => void,
    opts?: { manager?: boolean },
  ) => Promise<void>
  switchCoordinatorModel: (modelId: string) => Promise<import('../../services/concourse/coordinatorModels.js').CoordinatorSwitchReceiptV1>
  switchCoordinatorMode: (
    mode: 'off' | 'rules-only' | 'agent-assisted',
  ) => Promise<import('../../services/concourse/coordinatorModels.js').CoordinatorSwitchReceiptV1>
  switchCoordinatorEffort?: (
    effort: string,
  ) => Promise<import('../../services/concourse/coordinatorModels.js').CoordinatorSwitchReceiptV1>
}
