/**
 * durableOperationMatrix — the typed inventory of every LOAD-BEARING durable
 * operation in Mercury.
 *
 * One row per cross-file/cross-process state change: which files it touches,
 * who owns the lock, the write order, its idempotency key (or the lack of
 * one), how publication is announced, what recovery exists today, and every
 * interruption window an abrupt process exit opens. The matrix is DATA — the
 * generator (scripts/reliability/gen-durable-matrix.ts) renders it on demand
 * to an untracked path, so there is no tracked copy to trail this table (the
 * flagRegistry pattern).
 *
 * `failureClass` tags tie rows to the deterministic characterization fixtures
 * in scripts/reliability/prove-interruption-windows.ts (FC1–FC8). A row's
 * `recovery` describes the CURRENT behavior — rows are updated in place as the
 * durability slices land, so the matrix is always the as-built truth.
 */

/** The pinned failure classes (FC1–FC8 fixtures:
 *  scripts/reliability/prove-interruption-windows.ts; FC9 fixtures:
 *  scripts/changesets/prove-changeset-recovery.ts). */
export const FAILURE_CLASSES = [
  'FC1-teamcreate-partial', // exit after team file, before task/leader setup
  'FC2-sidecar-temp-collision', // two saveRunSidecar calls share one temp path
  'FC3-runrecord-surface-split', // outcome/artifact/handoff disagree after exit
  'FC4-mailbox-act-before-ack', // delivery acted on, exit before read-mark
  'FC5-corrupt-store-empty-overwrite', // mutation republishes over damaged bytes
  'FC6-task-epoch-resurrection', // interrupted reset leaves stale tasks live
  // (FC7-ledger-append-trim-race RETIRED with the fire-outcome ledger —
  //  the racing-trim class has no writer left.)
  'FC8-subscriber-revision-blind', // coalesced events, no revision/catch-up proof
  'FC9-changeset-partial-commit', // death mid multi-file rename walk / later-bytes divergence
] as const
export type FailureClass = (typeof FAILURE_CLASSES)[number]

/**
 * Where an operation's durable TRUTH lives. This is the axis
 * that SCOPES the single-writer migration: only `authority` rows hold state a
 * competing writer can silently lose, so only they move onto the durable
 * authority. The other three are the reasons a row does NOT need to move.
 *
 *   authority    the bytes ARE the truth; last-writer-wins over a shared file
 *   append-only  records are added, never rewritten; order is the truth
 *   projection   derived from something else and rebuildable; losing it is
 *                a repaint, not a data loss
 *   immutable    written once and never mutated; no writer can conflict
 *
 * `immutable` has no PRIMARY row today, and that is a finding rather than a
 * gap: immutable artefacts exist in this repo (the ChangeSet bundle's original
 * bytes, content-addressed artifact blobs, snapshots) but only ever as
 * COMPONENTS of a row whose truth lives elsewhere.
 * Keeping the class named is what makes that statement checkable.
 */
export const STATE_CLASSES = ['authority', 'append-only', 'projection', 'immutable'] as const
export type StateClass = (typeof STATE_CLASSES)[number]

export interface DurableOperationRow {
  /** Stable id, kebab, unique. */
  id: string
  /** Domain grouping for the rendered doc. */
  domain:
    | 'filestore'
    | 'teams'
    | 'tasks'
    | 'mailbox'
    | 'runs'
    | 'daemon'
    | 'cron'
    | 'stores'
    | 'changes'
    | 'lifecycle'
  /** Where this row's durable truth lives — migrates the `authority` rows. */
  stateClass: StateClass
  /**
   * For a HETEROGENEOUS row, the member of `files` that actually IS the truth.
   * Several rows mix classes — `daemon-run-record` holds a canonical journal
   * plus three files it calls materialized VIEWS; `text-change-set` mixes an
   * immutable byte bundle, an append-only journal and authority targets — so
   * naming the truth-bearing artefact is what keeps `stateClass` honest at row
   * granularity instead of averaging a row down to one word.
   */
  authorityArtifact?: string
  /** The row's schema/epoch identity: the versioned durable
   *  shape (or epoch mechanism) readers decode — 'n/a' only for sweeps that
   *  re-derive from other rows' schemas. */
  schemaOrEpoch: string
  /**
   * Flipped to true once the row commits through group-committed
   * critical section. The stage's operator ruling was to batch behind the
   * owner we already have rather than stand up a separate storage engine, so
   * "the authority" here IS the FileStore kernel committing a whole busy
   * period under one lock, one read and one publish.
   *
   * This is the mechanical completion ratchet the stage is judged by: "no
   * legacy write route survives" becomes countable rather than asserted.
   * Absent = still paying a full critical section per mutation. Note that
   * `tasks/*` and `team/*` hold their OWN locks (utils/tasks.ts,
   * withLockedTeamFile) rather than the kernel's, so the kernel change does
   * NOT reach them — they are the remaining scope, and the evidence names them
   * as the most contended rows.
   */
  migrated?: true
  /** What the operation is, one line. */
  operation: string
  /** Canonical owner key / scoping identity. */
  ownerKey: string
  /** Files touched, in write order. */
  files: string[]
  /** In-memory projections that must agree with disk. */
  projections: string[]
  /** Who serializes writers (lock owner), or 'none'. */
  lockOwner: string
  /** The write order across records (the interruption surface). */
  writeOrder: string
  /** Current idempotency key, or 'none'. */
  idempotencyKey: string
  /** How a commit is announced to observers. */
  publication: string
  /** CURRENT recovery behavior after an abrupt exit. */
  recovery: string
  /** Every interruption window an abrupt exit opens (numbered). */
  interruptionWindows: string[]
  /** Pinned failure classes this row participates in. */
  failureClass: FailureClass[]
  /** Primary source anchors. */
  source: string[]
}

export const DURABLE_OPERATION_MATRIX: readonly DurableOperationRow[] = [
  // ── FileStore kernel ────────────────────────────────────────────────────
  {
    id: 'filestore-write',
    schemaOrEpoch: 'per-store schemaVersion stamped as _v (fileStore VERSION_KEY); decoders own every prior version',
    domain: 'filestore',
    stateClass: 'authority',
    migrated: true,
    operation: 'FileStore whole-value write / locked update / mutate',
    ownerKey: 'store path (per-file)',
    files: ['<store>.json (tmp+rename via publishAtomic)'],
    projections: ['in-process subscriber fan-out (lastEmittedRaw latch)'],
    lockOwner: 'proper-lockfile on the store path (STORE_LOCK_OPTIONS) + per-path in-process opChain',
    writeOrder: 'lock → read → fn → durableAtomicPublish (exclusive tmp → fsync → rename → dir fsync) → in-process fanOut',
    idempotencyKey: 'none (last-writer-wins inside the lock)',
    publication: 'rename observed by chokidar watcher (+ optional poll floor) + immediate in-process fanOut',
    recovery:
      'Slice 1: publication rides durableAtomicPublish — fsync-before-rename + dir fsync (MERCURY_DURABLE_FSYNC=0 opts out), exclusive collision-free temps, failed publications self-clean, stale orphan temps swept per-dir. Slice 2: every OBJECT-store mutation advances a monotonic in-band `_rev` (revision · writer · operationId · digest) in the same rename; readResult() is the typed read (ready/missing/recoverable — never silently empty); a locked mutation over damaged bytes QUARANTINES the only copy (bounded sibling + recovery ledger) and resumes from the runtime last-good when known (FC5 fixed); subscribeChanges() delivers revision + cause + PROVABLE skippedRevisions with catch-up semantics (FC8 fixed). Bare arrays derive revisions via revisionOf or stay honestly null.',
    interruptionWindows: [
      'W1 (bounded): crash between tmp write and rename — the orphan temp is swept on the next publish into that dir (age-gated) and at boot recovery',
      'W2 (closed, Slice 1): fsync barriers make the publication power-loss durable',
      'W3 (closed, Slice 2): damaged store + mutate — quarantined + ledgered before any republish; last-good resume when the runtime holds a witness',
    ],
    failureClass: ['FC5-corrupt-store-empty-overwrite', 'FC8-subscriber-revision-blind'],
    source: ['src/substrate/fileStore.ts:80', 'src/substrate/fileStore.ts:519'],
  },
  {
    id: 'filestore-subscribe',
    schemaOrEpoch: 'reads the same _v-stamped shape; operation-id stamps dedupe replayed emissions',
    domain: 'filestore',
    stateClass: 'projection',
    operation: 'FileStore cross-process subscription (watcher + poll floor)',
    ownerKey: 'store path (per-file runtime)',
    files: ['<store>.json (read-only)'],
    projections: ['subscriber-held last value'],
    lockOwner: 'none (lock-free reads by doctrine)',
    writeOrder: 'n/a (observer)',
    idempotencyKey: 'operation-id dedup for stamped stores + content dedup (raw-string compare)',
    publication: 'chokidar add/change/unlink + Linux steady poll floor + debounce (25ms)',
    recovery:
      'Slice 2: subscribeChanges() carries {revision, cause, skippedRevisions} — a coalesced/missed commit arrives as ONE catch-up emission with the PROVABLE skip count (FC8 fixed); self-echo dedups by operationId (stronger than bytes); the immediate read baselines the revision watermark and never delivers old-after-new. A missed rename event is still bounded by the poll floor.',
    interruptionWindows: [
      'W1 (closed, Slice 2): coalesced commits arrive as one catch-up emission with the provable skip count',
      'W2 (bounded): watcher goes deaf — delivery waits for the floor tick; the catch-up emission then proves what was missed',
    ],
    failureClass: ['FC8-subscriber-revision-blind'],
    source: ['src/substrate/fileStore.ts:317', 'src/substrate/fileStore.ts:420'],
  },
  // ── Teams ───────────────────────────────────────────────────────────────
  {
    id: 'team-create',
    schemaOrEpoch: 'team config.json roster shape (v1 contract); the journal step schema versions the transaction',
    domain: 'teams',
    stateClass: 'authority',
    authorityArtifact: '<teams>/<team>/config.json (the journal is the transaction that protects it, not the truth itself)',
    operation: 'TeamCreate — team file + task-list reset + leader registrations + AppState',
    ownerKey: 'team name (sanitized)',
    files: [
      '<teams>/<team>/config.json (exclusive write)',
      '<config>/tasks/<team>/.highwatermark (via resetTaskList)',
      '<config>/tasks/<team>/ (dir create)',
    ],
    projections: [
      'AppState.teamContext',
      'leaderTeamName (tasks.ts module state)',
      'leadTeamFallback (teammate.ts module state)',
      'session-cleanup Set (bootstrap state)',
    ],
    lockOwner: 'the teams journal lock (scan/prepare) + the task-list lock inside the epoch step',
    writeOrder: 'journal prepared → s1 team-file (exclusive) → s2 task-epoch → journal committed → PROJECTION (registrations + AppState)',
    idempotencyKey: 'journal `team-create:<name>` — a re-run replays; a live concurrent create yields in-flight',
    publication: 'the journal COMMIT marker precedes any projection',
    recovery:
      'Slice 4a: the durable half is ONE journaled operation (teamOperations.performTeamCreateOperation). An abrupt exit at ANY boundary is recorded (prepared/applying) and recovery deterministically COMPENSATES via the guarded unwind (only a team whose leadSessionId matches the op owner is ever removed — FC1 fixed); a fully-applied op rolls forward. Registrations + AppState are PROJECTIONS of the committed state, rebuildable at boot (rebuildTeamProjection).',
    interruptionWindows: [
      'W1 (closed, Slice 4a): kill between team file and task epoch — journal-tracked, compensated at recovery',
      'W2 (closed, Slice 4a): kill before the commit marker — same compensation; after it, projection rebuilds from disk',
    ],
    failureClass: ['FC1-teamcreate-partial'],
    source: ['src/tools/TeamCreateTool/TeamCreateTool.ts:180', 'src/tools/TeamCreateTool/TeamCreateTool.ts:349'],
  },
  {
    id: 'team-spawn-member',
    schemaOrEpoch: 'the same roster v1 shape; the spawn ledger rows are an append-only v1 audit trail',
    domain: 'teams',
    stateClass: 'authority',
    migrated: true,
    authorityArtifact: '<teams>/<team>/config.json (roster; the spawn ledger beside it is an append-only audit trail)',
    operation: 'Teammate spawn — roster append + pane/worktree + mailbox + spawn ledger',
    ownerKey: 'team name + agent id',
    files: [
      '<teams>/<team>/config.json (locked append via appendTeamMember)',
      '<teams>/<team>/inboxes/<name>.json (first write)',
      '<config>/spawn-ledger.jsonl (append)',
    ],
    projections: ['AppState.teamContext.teammates', 'roster handles (daemon)'],
    lockOwner: 'withLockedTeamFile (proper-lockfile, durable publish)',
    writeOrder: 'spawn backend → roster append → ledger row → AppState',
    idempotencyKey: 'the AGENT ID is the operation id: appends are name-deduped upstream, removes key by agentId and are idempotent (remove-twice = no-op)',
    publication: 'roster file rename; the spawn ledger row is the audit record',
    recovery:
      'an exit between backend spawn and roster append orphans the spawned process — ownerWatch/workerParentWatch reap daemon children and assertSpawnCwd refuses poisoned respawns; between append and AppState the UI re-reads the roster (Team Center). Removes recover cleanly by idempotency.',
    interruptionWindows: [
      'W1: after backend spawn, before roster append — running teammate not in roster',
      'W2: after roster append, before AppState — roster/UI disagree',
    ],
    failureClass: ['FC1-teamcreate-partial'],
    source: ['src/utils/swarm/teamHelpers.ts:353', 'src/tools/shared/spawnMultiAgent.ts'],
  },
  {
    id: 'team-delete',
    schemaOrEpoch: 'journal roll-forward step schema (team-delete:<name>:<ts>)',
    domain: 'teams',
    stateClass: 'authority',
    operation: 'TeamDelete / session cleanup — worktrees + team dir + tasks dir + registrations',
    ownerKey: 'team name (sanitized)',
    files: [
      'member worktrees (git worktree remove / rm -rf)',
      '<teams>/<team>/ (rm -rf)',
      '<config>/tasks/<team>/ (rm -rf)',
    ],
    projections: ['AppState.teamContext', 'leaderTeamName', 'leadTeamFallback', 'session-cleanup Set'],
    lockOwner: 'the teams journal lock (scan/prepare)',
    writeOrder: 'journal prepared → remove (worktrees → team dir → tasks dir) → committed → in-memory clears',
    idempotencyKey: 'journal `team-delete:<name>:<ts>` (roll-forward kind)',
    publication: 'journal commit marker',
    recovery:
      'Slice 4a: deletion is a journaled ROLL-FORWARD operation (performTeamDeleteOperation) — an interrupted delete COMPLETES at recovery (idempotent rm), never resurrects as a partial team/tasks mix.',
    interruptionWindows: [
      'W1 (closed, Slice 4a): exit mid-removal — recovery rolls the deletion forward to completion',
      'W2: after disk removal, before in-memory clears — projections rebuild from (now absent) disk at boot',
    ],
    failureClass: ['FC1-teamcreate-partial'],
    source: ['src/utils/swarm/teamHelpers.ts:838'],
  },
  // ── Tasks ───────────────────────────────────────────────────────────────
  {
    id: 'task-outcome-envelope',
    schemaOrEpoch: 'AgentResultEnvelope v1 (task-outcomes.json)',
    domain: 'tasks',
    stateClass: 'authority',
    migrated: true,
    operation:
      'recordTaskOutcome — mint a background task’s terminal outcome (exactly once) at the LocalShellTask terminal transition',
    ownerKey: 'sessionId',
    files: ['<projectDir>/<sessionId>.task-outcomes.json (tmp+rename)'],
    projections: ['TaskOutputTool fallback read; TaskStop receipt is in-band'],
    lockOwner: 'per-session in-process write chain (no cross-process writer exists)',
    writeOrder:
      'load-or-cache → refuse duplicate taskId (first terminal outcome stands) → ring-bound (100) → durableAtomicPublish',
    idempotencyKey: 'taskId (a re-mint is a no-op)',
    publication: 'whole-file atomic snapshot beside the session transcript',
    recovery:
      'schema-versioned load (unknown version ⇒ empty, never a crash); a failed publish is swallowed — the terminal transition must not break on the envelope; the transcript notification remains the independent carrier of last resort.',
    interruptionWindows: [
      'W1: crash between the terminal state flip and the publish — the outcome exists only in the transcript notification (the pre-envelope status quo, never worse)',
    ],
    // FC3: the envelope missing while the transcript notification exists is
    // the run-record surface-split class (surfaces disagree after exit).
    failureClass: ['FC3-runrecord-surface-split'],
    source: ['src/tasks/taskOutcomeEnvelope.ts:118'],
  },
  {
    id: 'task-create',
    schemaOrEpoch: 'zod TaskSchema bodies + the .epoch marker (FC6 reset epochs)',
    domain: 'tasks',
    stateClass: 'authority',
    migrated: true,
    operation: 'createTask — id allocation (max of files+HWM) + body publish',
    ownerKey: 'taskListId (team or session)',
    files: ['<tasks>/<list>/<id>.json (tmp+rename)'],
    projections: ['tasksUpdated signal (in-process)'],
    lockOwner: 'task-list .lock (proper-lockfile)',
    writeOrder: 'readdir+HWM scan → id=max+1 → body publish (epoch-stamped)',
    idempotencyKey: 'none (a retried create mints a new id)',
    publication: 'body file rename + in-process signal; cross-process readers poll/list',
    recovery:
      'id + body + EPOCH commit as one atomic publication under the list lock (Slice 4a) — a crash leaves nothing or a complete current-epoch task; no missing/duplicate id, no mark/body disagreement. A caller that dies after publish and retries still creates a semantic duplicate under a new id (callers own that key).',
    interruptionWindows: [
      'W1: after publish, before the caller records the returned id — retry duplicates the task (caller-level)',
    ],
    failureClass: ['FC6-task-epoch-resurrection'],
    source: ['src/utils/tasks.ts:287'],
  },
  {
    id: 'task-delete',
    schemaOrEpoch: 'zod TaskSchema bodies; the high-water mark guards id reuse',
    domain: 'tasks',
    stateClass: 'authority',
    operation: 'deleteTask — HWM advance + unlink + cross-task reference sweep',
    ownerKey: 'taskListId',
    files: [
      '<tasks>/<list>/.highwatermark (tmp+rename)',
      '<tasks>/<list>/<id>.json (unlink)',
      'sibling task bodies (reference sweep rewrites)',
    ],
    projections: ['tasksUpdated signal'],
    lockOwner: 'NONE for HWM+unlink (only per-task locks inside the sweep)',
    writeOrder: 'HWM publish → unlink → per-sibling blocked/blocks rewrite',
    idempotencyKey: 'none',
    publication: 'file disappearance; no tombstone',
    recovery:
      'exit between HWM and unlink leaves both mark and body (benign: no id reuse); exit mid-reference-sweep leaves dangling blocks/blockedBy edges pointing at a deleted id with no repair pass.',
    interruptionWindows: [
      'W1: after HWM publish, before unlink — mark/body disagreement',
      'W2: mid reference sweep — dangling dependency edges',
    ],
    failureClass: ['FC6-task-epoch-resurrection'],
    source: ['src/utils/tasks.ts:387'],
  },
  {
    id: 'task-reset',
    schemaOrEpoch: 'the .epoch marker (monotonic epoch — the reset COMMIT POINT, FC6)',
    domain: 'tasks',
    stateClass: 'authority',
    authorityArtifact: '<tasks>/<list>/.epoch (the durable commit point readers filter on)',
    operation: 'resetTaskList — HWM capture + delete-all task bodies (new epoch)',
    ownerKey: 'taskListId',
    files: ['<tasks>/<list>/.highwatermark', '<tasks>/<list>/.epoch (THE COMMIT POINT)', '<tasks>/<list>/*.json (GC unlink loop)'],
    projections: ['tasksUpdated signal'],
    lockOwner: 'task-list .lock',
    writeOrder: 'scan highest → HWM publish → EPOCH bump (durable commit point) → unlink loop (GC)',
    idempotencyKey: 'the epoch number (monotonic; a re-run bumps again — idempotent intent)',
    publication: 'the .epoch marker',
    recovery:
      'Slice 4a (FC6 fixed): the epoch marker is the reset\'s durable COMMIT POINT — readers filter older-epoch bodies dead the instant it lands, so an interrupted unlink loop leaves dead bytes, never resurrected tasks. sweepDeadEpochTasks (the recovery orchestrator\'s GC pass) reclaims the bytes.',
    interruptionWindows: [
      'W1 (closed, Slice 4a): exit mid-unlink — surviving bodies are epoch-dead; the sweep GCs them',
    ],
    failureClass: ['FC6-task-epoch-resurrection'],
    source: ['src/utils/tasks.ts:150'],
  },
  // ── Mailbox ─────────────────────────────────────────────────────────────
  {
    id: 'mailbox-send',
    schemaOrEpoch: 'inbox message v1 (durable per-message id + per-inbox monotonic seq)',
    domain: 'mailbox',
    stateClass: 'authority',
    migrated: true,
    operation: 'writeToMailbox — locked append + inline compaction',
    ownerKey: 'recipient agent name + team',
    files: ['<teams>/<team>/inboxes/<name>.json (FileStore locked mutate)'],
    projections: [],
    lockOwner: 'FileStore lock on the inbox path',
    writeOrder: 'read → append {read:false, id, seq} → compact → publish',
    idempotencyKey: 'durable per-message id + per-inbox monotonic seq (Slice 4b), assigned under the append lock',
    publication: 'inbox rename + 1s poll floor; revisionOf = max seq (revision-aware subscribers)',
    recovery:
      'Slice 4b: every message carries a durable id + seq (legacy readers ignore the additive fields; legacy messages stay readable); markSpecificMessageAsRead keys on the exact id (content key = legacy fallback). Slice 2 closed the FC5 half: a damaged inbox is QUARANTINED before the next send can republish; compaction still only drops READ messages.',
    interruptionWindows: [
      'W2 (closed, Slice 2): damaged inbox + send — quarantined + ledgered before any republish',
    ],
    failureClass: ['FC4-mailbox-act-before-ack', 'FC5-corrupt-store-empty-overwrite'],
    source: ['src/utils/teammateMailbox.ts:163', 'src/utils/teammateMailbox.ts:51'],
  },
  {
    id: 'mailbox-consume',
    schemaOrEpoch: 'the dedup consumption ledger v1 (bounded 500, compacted)',
    domain: 'mailbox',
    stateClass: 'authority',
    migrated: true,
    authorityArtifact: '<teams>/<team>/dedup/<name>.json (the durable consumption ledger — bounded 500, so compacted, NOT append-only)',
    operation: 'drainScribeDispatches — read unread → deliver to child stdin → mark read',
    ownerKey: 'consumer agent name + team',
    files: [
      '<teams>/<team>/dedup/<name>.json (the DURABLE consumption ledger)',
      '<teams>/<team>/inboxes/<name>.json (mark-read mutate at drain end)',
    ],
    projections: ['roster.seenDispatchIds (in-memory fast path)', 'child transcript (the acted-on work)'],
    lockOwner: 'FileStore locks per store; the durable ledger records around the act',
    writeOrder: "read unread → dedup 'delivering' (durable, BEFORE the act) → roster.reply (ACT) → dedup 'delivered' → mark-read",
    idempotencyKey: 'the scribe request_id, persisted per consumer in the dedup ledger (bounded 500, survives restarts)',
    publication: 'ledger + mark-read publishes',
    recovery:
      "Slice 4b (FC4 fixed): a 'delivered' record makes redelivery a CONSUME (exactly-once across daemon restarts — the pure ack-loss window); a 'delivering' record (died mid-act) redelivers WITH the honest replay marker (at-least-once, never a silent duplicate — the acting agent verifies state first). The in-memory seen-set stays as the zero-IO fast path.",
    interruptionWindows: [
      'W1 (closed, Slice 4b): die after the act + durable complete, before mark-read — restart consumes, never re-executes',
      'W2 (bounded + honest, Slice 4b): die MID-act — redelivered with the replay marker',
    ],
    failureClass: ['FC4-mailbox-act-before-ack'],
    source: ['src/daemon/scribeDispatchBridge.ts:173', 'src/daemon/roster.ts:440'],
  },
  {
    id: 'mailbox-clear',
    schemaOrEpoch: 'inbox message v1 (content-key marks)',
    domain: 'mailbox',
    stateClass: 'authority',
    migrated: true,
    operation: 'clearMailbox / markMessagesAsRead family',
    ownerKey: 'agent name + team',
    files: ['<teams>/<team>/inboxes/<name>.json'],
    projections: ['unread badges (UI)'],
    lockOwner: 'FileStore lock',
    writeOrder: 'single locked mutate',
    idempotencyKey: 'content key (from+text+timestamp) for specific marks',
    publication: 'inbox rename',
    recovery:
      'single-record atomic — safe per write; the content-key mark can still mis-target one of two byte-identical messages (no id).',
    interruptionWindows: ['W1: none beyond the kernel windows (single record)'],
    failureClass: ['FC4-mailbox-act-before-ack'],
    source: ['src/utils/teammateMailbox.ts:247', 'src/utils/teammateMailbox.ts:1061'],
  },
  // ── Runs ────────────────────────────────────────────────────────────────
  {
    id: 'run-sidecar-save',
    schemaOrEpoch: 'run.json manifest v1 (per-owner monotonic writeSeq + operationId)',
    domain: 'runs',
    stateClass: 'authority',
    operation: 'saveRunSidecar — coalesced RunSnapshot persistence beside the transcript',
    ownerKey: 'OwnerKey (workspace+session+lane)',
    files: ['<transcript-dir>/<session>.run.json (durableAtomicPublish)'],
    projections: ['runCoordinator in-memory snapshot', '/run inspector', 'frame run capsule'],
    lockOwner: 'none (coordinator coalesces in-process only)',
    writeOrder: 'durableAtomicPublish (exclusive tmp → fsync → rename → dir fsync)',
    idempotencyKey: 'per-owner monotonic writeSeq + operationId + committedAt on every save (Slice 4c; resumed from the loaded sidecar)',
    publication: 'none (reader loads on resume)',
    recovery:
      'loads validate schema + shape (torn/newer → explicit recoverable). Slice 1: publication rides the shared durable primitive — the FC2 pid-only temp collision is CLOSED (collision-free temps), orphan temps are swept. Slice 4c adds operation/revision metadata to every save.',
    interruptionWindows: [
      'W1 (closed, Slice 1): overlapping flushes get distinct exclusive temps — no collision (FC2 fixed)',
      'W2 (bounded): crash between tmp write and rename — orphan swept on next publish/boot',
    ],
    failureClass: ['FC2-sidecar-temp-collision'],
    source: ['src/services/run/runSidecar.ts:39', 'src/services/run/runCoordinator.ts:101'],
  },
  {
    id: 'run-reconcile-resume',
    schemaOrEpoch: 'run.json manifest v1 (terminal runs are immutable receipts)',
    domain: 'runs',
    stateClass: 'projection',
    operation: 'reconcileOnResume — sidecar → interruption fold → task/verification sync → persist',
    ownerKey: 'OwnerKey',
    files: ['<transcript-dir>/<session>.run.json (re-publish)'],
    projections: ['runCoordinator snapshot', 'stop evaluator inputs'],
    lockOwner: 'none',
    writeOrder: 'load → fold events → sync tasks/verification → flush',
    idempotencyKey: 'run id (terminal runs never reactivate)',
    publication: 'sidecar re-publish',
    recovery:
      'the run-level story is sound (pending tools become uncertainty markers; terminal runs are receipts). Slice 5: incomplete multi-record OPERATIONS are reconciled by the boot recovery orchestrator BEFORE the REPL mounts (teams journal, orphan temps, dead epochs) — reconcileOnResume stays the run-level fold on top of already-reconciled durable state.',
    interruptionWindows: [
      'W1: exit mid-reconcile — re-runs idempotently next resume (events re-fold)',
    ],
    failureClass: ['FC2-sidecar-temp-collision'],
    source: ['src/services/run/runCoordinator.ts:323'],
  },
  // ── Daemon records ──────────────────────────────────────────────────────
  // ── (The old fire path's durable rows — the run-record journal, the
  //     fire-outcome ledger, its boot sweep, and the scheduled_tasks store —
  //     retired with their engine. SATURN's schedules ride
  //     the concourse worker record's own row; its fire decisions ride the
  //     per-session receipts' append-only files.) ──
  // ── Remaining defineStore consumers ────────────────────────────────────
  {
    id: 'store-leases',
    schemaOrEpoch: 'leases.json v1 (lease id agent+pattern; TTL expiry IS the contract)',
    domain: 'stores',
    stateClass: 'authority',
    migrated: true,
    operation: 'file-lease claim/release/list (per-team leases.json)',
    ownerKey: 'team name',
    files: ['<teams>/<team>/leases/leases.json (FileStore)'],
    projections: ['PreToolUse lease guard decisions'],
    lockOwner: 'FileStore lock',
    writeOrder: 'single locked mutate',
    idempotencyKey: 'lease id (agent+pattern)',
    publication: 'store rename',
    recovery: 'TTL-bounded (30m) so lost updates self-heal; a damaged store is quarantined + ledgered (Slice 2) and the guard still fails OPEN (allow) by doctrine.',
    interruptionWindows: ['W1: kernel windows (W2/W3 closed); a dropped store fails OPEN (allow) by design'],
    failureClass: ['FC5-corrupt-store-empty-overwrite'],
    source: ['src/utils/swarm/leaseGlob.ts'],
  },
  {
    id: 'store-prompt-drafts',
    schemaOrEpoch: 'prompt-draft _v-stamped fileStore shape',
    domain: 'stores',
    stateClass: 'authority',
    migrated: true,
    operation: 'prompt drafts (defineStore consumer)',
    ownerKey: 'per store (project dir / session)',
    files: ['<config>/drafts/… (prompt drafts)'],
    projections: ['prompt restore'],
    lockOwner: 'FileStore lock',
    writeOrder: 'single locked mutate each',
    idempotencyKey: 'per-record ids',
    publication: 'store rename',
    recovery: 'single-record atomic through the durable kernel (Slice 1+2: fsync barriers · `_rev` · quarantine guard · revision-aware subscriptions).',
    interruptionWindows: ['W1: kernel windows (see filestore-write — W2/W3 closed)'],
    failureClass: ['FC5-corrupt-store-empty-overwrite', 'FC8-subscriber-revision-blind'],
    source: ['src/utils/promptDraft.ts'],
  },
  {
    id: 'team-roster-sync-helpers',
    schemaOrEpoch: 'the same team config.json roster v1 (one truth, two writers)',
    domain: 'teams',
    stateClass: 'authority',
    migrated: true,
    authorityArtifact: '<teams>/<team>/config.json (the same roster file team-create owns — two writers, one truth)',
    operation: 'roster sync helpers (member modes / hidden panes / active flags)',
    ownerKey: 'team name',
    files: ['<teams>/<team>/config.json (locked tmp+rename)'],
    projections: ['TeamsDialog rows', 'Team Center phases'],
    lockOwner: 'withLockedTeamFile / Sync (bounded backoff, degrades to unlocked)',
    writeOrder: 'single locked RMW → durableAtomicPublish(/Sync)',
    idempotencyKey: 'none (last-writer-wins per field)',
    publication: 'roster rename',
    recovery: 'single-record atomic through the shared durable primitive (Slice 1); sync twin can degrade to UNLOCKED best-effort on lock exhaustion (documented).',
    interruptionWindows: ['W1 (bounded): crash between tmp write and rename — orphan swept on next publish/boot'],
    failureClass: ['FC1-teamcreate-partial'],
    source: ['src/utils/swarm/teamHelpers.ts:240', 'src/utils/swarm/teamHelpers.ts:304'],
  },
  // ── Lifecycle sweeps ────────────────────────────────────────────────────
  {
    id: 'lifecycle-startup-sweeps',
    schemaOrEpoch: 'n/a — sweeps re-derive from the swept owners\' schemas',
    domain: 'lifecycle',
    stateClass: 'projection',
    operation: 'startup sweeps — orphan temps, journals, boot preflight',
    ownerKey: 'daemon dir / project dir',
    files: ['<config>/last-preflight.json', '<durable homes>/*.tmp (orphan sweep)'],
    projections: ['boot notification'],
    lockOwner: 'per-store',
    writeOrder: 'read → conditional appends/updates',
    idempotencyKey: 'converging re-runs (sweeps re-derive from state)',
    publication: 'store renames',
    recovery:
      'ONE recovery orchestrator (substrate/recoveryOrchestrator.runBootRecovery) runs at interactive boot (replLauncher, before the REPL projection mounts) AND daemon boot (before any store is read): orphan-temp sweep across the durable homes (pattern-scoped, age-gated, bounded) → teams journal recovery → dead-epoch task GC → stale daemon-record reconcile (a TerminateProcess\'d supervisor\'s supervisor.json/.lock + control.key, conservative, one receipt) → leader-projection rebuild (session scope). Idempotent, memoized per process, typed report — /run, /team, and the doctor DURABILITY rows read the same state.',
    interruptionWindows: [
      'W1: exit mid-sweep — next boot converges (per-sweep; the orchestrator itself is idempotent)',
    ],
    failureClass: ['FC1-teamcreate-partial'],
    source: ['src/substrate/recoveryOrchestrator.ts', 'src/replLauncher.tsx'],
  },
  // ── Multi-file text change sets ───────────────────────────────
  {
    id: 'text-change-set',
    schemaOrEpoch: 'ChangeSet journal op v1 (prepared→…→committed) + immutable byte bundles + manifest.json',
    domain: 'changes',
    stateClass: 'authority',
    authorityArtifact: 'each target file (the ChangeSet bundle is immutable; the operation journal is append-only)',
    operation:
      'text-change-set — the ONE shared multi-file text commit walk (ChangeSet tool · Structure applies · LSP applies)',
    ownerKey: 'OwnerKey string + plan digest (idempotencyKey = owner#planDigest)',
    files: [
      '<changesetHome>/bundles/<digest16>/t<i>.bin + manifest.json (original bytes, durable, BEFORE any commit)',
      '.<target>.<pid>.<hex8>.tmp beside each target (staged planned bytes, fsynced)',
      '<changesetHome>/journal/op-<id>.json (prepared → applying → per-step applied → committed/aborted)',
      'each target file (rename of its staged temp, deterministic path order)',
    ],
    projections: ['owner-scoped plan ring (changeSetStore)', 'readFileState per changed path', 'ChangeReceipt ring + transaction plane (via the ONE effect)'],
    lockOwner:
      'in-process deterministic ordered path locks (sorted canonical paths — overlap-safe, deadlock-free) + the journal dir lock/chain',
    writeOrder:
      'revalidate ALL current bytes → bundle originals (durable) → stage ALL temps (fsync) → journal prepared (payload: digests+paths, never content) → rename walk (one durable step record each) → reread-verify ALL → committed marker → editor/LSP sync (awaited, bounded)',
    idempotencyKey: 'owner#planDigest — a committed plan re-applied REPLAYS the prior result without a second write',
    publication: 'ONE typed file.changeSet effect → exactly-once ChangeReceipt → canonical transaction; journal commit marker durable before exposure',
    recovery:
      'fulcrum walker (recoverChangeSetJournal, boot BOTH scopes + pre-commit sweep): every decision from CURRENT disk digests — all targets match planned ⇒ roll forward (commit marker); strict subset planned + rest original ⇒ compensate the applied subset from the bundle, VERIFIED by reread; any target matching NEITHER digest ⇒ unresolved — later bytes never overwritten, journal + bundle + temps retained as evidence, exact paths reported. In-process midway failure: digest-guarded compensation verified by reread (failed = complete restoration; indeterminate = exact differing paths). Idempotent and safe if recovery itself dies.',
    interruptionWindows: [
      'W1 (closed): death before the journal record — only sweeper-owned staged temps + an inert bundle remain (age-gated sweep + bundle compaction)',
      'W2 (closed): death mid rename-walk — the walker compensates the applied subset from the bundle (verified) or rolls forward when all landed',
      'W3 (closed): death after all renames, before the commit marker — all targets match planned ⇒ roll forward',
      'W4 (bounded, honest): later bytes at any target — unresolved, preserved, exact paths reported; never overwritten',
      'W5 (bounded): death during editor/LSP sync — disk state committed + verified; the effect for that call was never emitted (the model re-inspects); servers resync on next touch',
    ],
    failureClass: ['FC9-changeset-partial-commit'],
    source: [
      'src/services/changeTransaction/changeSetCommit.ts',
      'src/services/changeTransaction/changeSetPlan.ts',
      'src/substrate/operationJournal.ts',
    ],
  },
  {
    id: 'lifecycle-session-boundary',
    schemaOrEpoch: 'n/a — disposal of in-memory owner keys (no owned durable shape)',
    domain: 'lifecycle',
    stateClass: 'projection',
    operation: 'session switch / /clear / compaction / shutdown — owner teardown + team cleanup',
    ownerKey: 'OwnerKey / session id',
    files: ['run sidecar (flush/delete)', 'team dirs (cleanupSessionTeams)', 'cleared-sessions cache'],
    projections: ['ownerLifecycle registries', 'context epochs'],
    lockOwner: 'per-store',
    writeOrder: 'flush run → dispose owners → (exit) cleanup session teams',
    idempotencyKey: 'owner key disposal is idempotent',
    publication: 'per-store renames',
    recovery:
      'gracefulShutdown paths are best-effort; SIGKILL still skips cleanupSessionTeams. Slice 5 bounds the orphan window: resuming the leader session rebuilds the team projection (rebuildTeamProjection at boot) and RE-REGISTERS the team for session cleanup, so the next resume+exit cycle reclaims it. A team whose leader is never resumed persists until an explicit delete (visible in /team).',
    interruptionWindows: [
      'W1 (bounded, Slice 5): SIGKILL before cleanupSessionTeams — the next leader resume re-registers cleanup; never-resumed teams persist until explicit delete',
      'W2: exit between run flush and owner disposal — benign (resume reconciles)',
    ],
    failureClass: ['FC1-teamcreate-partial'],
    source: ['src/utils/swarm/teamHelpers.ts:773', 'src/services/run/ownerLifecycle.ts'],
  },
  {
    id: 'store-interview-sessions',
    domain: 'stores',
    stateClass: 'authority',
    schemaOrEpoch:
      'INTERVIEW_SCHEMA_VERSION (_v via fileStore) + per-session v1 checkpoints (sealed folded state + tail; the seal law closes sealed event-identity space)',
    operation: 'interview session event-log append/flush (per-identity settlement) + checkpoint compaction',
    ownerKey: 'projectKey (sha256(cwd) prefix 16) + sessionId',
    files: ['<config>/interview/<projectKey>.json (FileStore locked mutate; atomic publish)'],
    projections: ['the live in-process snapshot (stable reference) + pending-first adopt/resume'],
    lockOwner: 'the FileStore kernel lock (STORE_LOCK_OPTIONS) via interviewStore.mutate',
    writeOrder:
      'fold live → per-identity debounce (150ms) → mutate {checkpoint?, tail, updatedAtMs} → MAX_SESSIONS trim',
    idempotencyKey:
      'eventId (the fold receipt set; sealed ids closed by the seal law) + the per-identity accepted generation',
    publication:
      'fileStore atomic publish; typed InterviewSettlement (settled | degraded — degraded RETAINED for retry; the flush receipt reports every identity)',
    recovery:
      'rebuild = fold(checkpoint state, tail); pending-first outranks disk (CA-16); an unreadable log records a read-degrade ledger receipt (CA-17) and lists empty (declared fail-open)',
    interruptionWindows: [
      '1. die inside the debounce window — the accepted tail is lost with the process (bounded ≤150ms; the graceful-shutdown cleanup drains every identity and logs degradation)',
      '2. die during the mutate — the FileStore lane recovers (FC5 quarantine, last-good resume); the retained generation retries on the next drain',
    ],
    failureClass: ['FC5-corrupt-store-empty-overwrite', 'FC8-subscriber-revision-blind'],
    source: ['src/services/interview/store.ts', 'src/services/interview/contracts.ts'],
  },
] as const

// ── the resource-bound table ──────────────────────────────────
// Every LONG-LIVED structure the integrity touched or depends on:
// its writer, its declared bound, the reaper that enforces it, what a reap
// preserves, and the proof that exercises the boundary. Rendered into the
// generated doc beside the operation matrix; prove-durable-matrix asserts
// completeness and that every proof file exists.

export interface ResourceBoundRow {
  id: string
  /** The structure (in-memory or on-disk). */
  structure: string
  writer: string
  /** The declared bound (count / bytes / age). */
  bound: string
  /** The reaper/compactor enforcing it. */
  reaper: string
  /** What a reap preserves. */
  preserves: string
  /** The proof exercising the boundary. */
  proof: string
}

export const RESOURCE_BOUNDS: readonly ResourceBoundRow[] = [
  {
    id: 'interview-durable-sessions',
    structure: 'interview/<projectKey>.json sessions map (on disk)',
    writer: 'interview store persistEntry (per-identity mutate)',
    bound: 'MAX_SESSIONS = 10 sessions per project',
    reaper: 'updatedAtMs-ordered trim inside every mutate',
    preserves: 'the newest sessions',
    proof: 'scripts/interview/prove-resume-bounds.ts',
  },
  {
    id: 'interview-session-events',
    structure: 'per-session event log (live array + durable tail)',
    writer: 'appendInterviewEvent (push-in-place) / persistEntry',
    bound: 'tail ≤ 400 threshold + growth window; the prefix seals into the v1 checkpoint',
    reaper: 'persistEntry compaction (fold prefix onto checkpoint; splice the live tail in place)',
    preserves: 'decision identity, committed history, priorCommits, notes, context (the folded state)',
    proof: 'scripts/interview/prove-checkpoint-compaction.ts',
  },
  {
    id: 'interview-pending-persist',
    structure: 'pendingBySession Map (per-identity settlement entries)',
    writer: 'scheduleSave / persistEntry',
    bound: 'settled entries reap on settlement; degraded retained ≤ MAX_SESSIONS',
    reaper: 'settle-reap + oldest-degraded eviction (loud)',
    preserves: 'the newest degraded receipts (retryable state)',
    proof: 'scripts/interview/prove-settlement-receipts.ts',
  },
  {
    id: 'interview-live-checkpoints',
    structure: 'liveCheckpoints Map (in-memory checkpoint bases)',
    writer: 'noteLiveCheckpoint (compactions + disk resumes)',
    bound: '≤ MAX_SESSIONS entries',
    reaper: 'insertion-order eviction',
    preserves: 'the most recently touched sessions\' bases',
    proof: 'scripts/interview/prove-checkpoint-compaction.ts',
  },
  {
    id: 'publish-health-receipt',
    structure: 'durablePublish module health receipt (budget-exhausted + retried-success)',
    writer: 'noteBudgetExhausted / noteRetriedSuccess (all four publish outcomes)',
    bound: 'fixed-size counters + last-instance records',
    reaper: 'overwrite-in-place',
    preserves: 'the latest beyond-budget evidence',
    proof: 'scripts/reliability/prove-durable-publish.ts',
  },
  {
    id: 'store-recovery-ledger',
    structure: 'recovery/store-recovery.jsonl (quarantine + read-degrade events)',
    writer: 'quarantineDamagedStore / recordStoreReadDegradation (read path latched per store per process)',
    bound: 'read tail ≤ MAX_LEDGER_ROWS = 500',
    reaper: 'bounded tail read (writers append; readers bound)',
    preserves: 'the newest 500 events',
    proof: 'scripts/reliability/prove-recovery-orchestrator.ts',
  },
  {
    id: 'store-quarantine-copies',
    structure: '<store>.damaged-*.recovered siblings',
    writer: 'quarantineDamagedStore',
    bound: 'MAX_QUARANTINE_COPIES = 3 per store',
    reaper: 'oldest-pruned on every quarantine write',
    preserves: 'the newest damaged copies',
    proof: 'scripts/reliability/prove-recovery-orchestrator.ts',
  },
  {
    id: 'mailbox-dedup-ledger',
    structure: '<teams>/<team>/dedup/<name>.json consumption ledger',
    writer: 'mailbox consume (mark-read at drain end)',
    bound: 'bounded 500 (compacted, not append-only)',
    reaper: 'per-write compaction',
    preserves: 'the newest consumption receipts (the scribe deliveredKeys law)',
    proof: 'scripts/reliability/prove-interruption-windows.ts',
  },
  {
    id: 'filestore-compromised-locks',
    structure: 'fileStore compromisedLocks Set',
    writer: 'onCompromised (lease-loss records)',
    bound: '≤ active store paths; cleared per acquire',
    reaper: 'acquire-time delete',
    preserves: 'nothing (a refuse-to-publish flag)',
    proof: 'scripts/engine-durability/run-all.sh',
  },
  {
    id: 'team-compromised-locks',
    structure: 'teamHelpers compromisedTeamLocks Set',
    writer: 'lane onCompromised',
    bound: '≤ active team files; cleared per acquire',
    reaper: 'acquire-time delete',
    preserves: 'nothing (a refuse-to-publish flag)',
    proof: 'scripts/substrate/prove-team-roster-lock.ts',
  },
  {
    id: 'serialization-lanes',
    structure: 'createLanes / teamLanes Maps (group-commit lanes per path)',
    writer: 'lane factories (first touch per path)',
    bound: '≤ task lists / teams touched per process (session lifetime)',
    reaper: 'process lifetime (session-scoped by design)',
    preserves: 'lane identity per path',
    proof: 'scripts/formal-models/prove-task-lock-stall.ts',
  },
  {
    id: 'orphan-publish-temps',
    structure: 'durable publish temp files (.<name>.<pid>.<uuid>.tmp)',
    writer: 'durablePublish temp creation',
    bound: 'age ≥ 10 minutes before sweep eligibility',
    reaper: 'the recovery orchestrator boot sweep',
    preserves: 'live writers\' fresh temps',
    proof: 'scripts/reliability/prove-recovery-orchestrator.ts',
  },
]
