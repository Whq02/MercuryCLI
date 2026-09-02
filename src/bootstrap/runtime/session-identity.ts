// ============================================================================
//  src/bootstrap/runtime/session-identity.ts — the session-identity owner
//
//
//  Scope: MIXED, deliberately co-owned (identity is ONE concern):
//   - the id trio (sessionId · parentSessionId · sessionProjectDir) is
//     CONVERSATION-scoped — switchSession/regenerateSessionId are its only
//     mutators;
//   - the cwd trio (originalCwd · projectRoot · cwd) is PROCESS-scoped,
//     resolved ONCE at construction (realpath + NFC, with the File-Provider
//     EPERM fallback);
//   - planSlugCache stays WITH identity — its ONLY mutation coupling is the
//     eviction switchSession/regenerateSessionId perform (the banked T17
//     sequence pinned this co-location).
//
//  The laws the contract net pins (prove-state-contract LAW 1, preserved
//  EXACTLY by this owner):
//   - ATOMIC pair: sessionId and sessionProjectDir change together — one
//     method, no separate setters, they cannot drift;
//   - projectDir NEVER carries over (every switch resets it);
//   - EMIT-AFTER-WRITE: subscribers read the NEW id synchronously
//     (concurrentSessions' PID-file sync depends on it);
//   - NO same-id guard: switching to the current id re-emits;
//   - regenerateSessionId does NOT emit the switch signal (the asymmetry is
//     deliberate — PID-file sync never hears regenerations).
//
//  Construction is EAGER at facade module load — the boot realpath and the
//  boot sessionId must not move (boot-order receipts, a recorded risk).
//  resetStateForTests rebuilds the instance: fresh uuid, re-resolved cwd,
//  and the switch signal's subscribers die with the old instance.
//
//  BOOTSTRAP-ISOLATION LEAF (the same custom-rules/bootstrap-isolation
//  convention state.ts carries): imports are node built-ins, the sanctioned
//  crypto leaf, the signal primitive, and types. src/bootstrap/state.ts is
//  the ONLY sanctioned importer; every consumer goes through the frozen
//  facade.
// ============================================================================
import { realpathSync } from 'fs'
import { cwd } from 'process'
import type { SessionId } from 'src/types/ids.js'
// randomUUID arrives through the crypto indirection leaf so the browser-sdk
// build can swap implementations (package.json "browser" maps crypto.ts →
// crypto.browser.ts). The leaf purely re-exports node:crypto — no circular-
// dep exposure. The path-alias spelling slips past the bootstrap-isolation
// rule (it only inspects ./ and / prefixes), so the disable below states
// the sanction explicitly.
// eslint-disable-next-line custom-rules/bootstrap-isolation -- the sanctioned crypto leaf (see note)
import { randomUUID } from 'src/utils/crypto.js'
import { createSignal } from 'src/utils/signal.js'

export class SessionIdentityOwner {
  originalCwd: string
  // Where the session's PROJECT lives — frozen at boot (--worktree included).
  // Mid-session EnterWorktreeTool never moves it: history, skills, and
  // session storage stay anchored to the boot project. File operations use
  // `cwd`, never this.
  projectRoot: string
  cwd: string
  sessionId: SessionId
  // Lineage pointer: the session this one was minted FROM (a strategy-mode
  // session regenerating into its implementation session records the parent).
  parentSessionId: SessionId | undefined = undefined
  // The directory holding this session's `.jsonl` transcript; null means
  // "derive it from originalCwd".
  sessionProjectDir: string | null = null
  // sessionId → plan word-slug. Bounded by construction: the only writers
  // beyond the setter are switchSession/regenerateSessionId, and both evict
  // the outgoing session's entry.
  readonly planSlugCache: Map<string, string> = new Map()
  private readonly sessionSwitched = createSignal<[id: SessionId]>()
  private readonly cwdChanged = createSignal<[cwd: string]>()

  constructor() {
    // The boot cwd is realpath'd (then NFC-normalized) so it matches how
    // shell.ts setCwd sanitizes paths — session-storage dirs derive from
    // this string and must agree with later cd's byte-for-byte.
    let resolvedCwd = ''
    if (
      typeof process !== 'undefined' &&
      typeof process.cwd === 'function' &&
      typeof realpathSync === 'function'
    ) {
      const rawCwd = cwd()
      try {
        resolvedCwd = realpathSync(rawCwd).normalize('NFC')
      } catch {
        // realpath lstat's every path component, and macOS File-Provider
        // mounts (CloudStorage) answer that with EPERM — keep the raw cwd.
        resolvedCwd = rawCwd.normalize('NFC')
      }
    }
    this.originalCwd = resolvedCwd
    this.projectRoot = resolvedCwd
    this.cwd = resolvedCwd
    this.sessionId = randomUUID() as SessionId
  }

  setOriginalCwd(nextCwd: string): void {
    this.originalCwd = nextCwd.normalize('NFC')
  }

  /**
   * The one sanctioned caller is --worktree startup. Mid-session
   * EnterWorktreeTool must NOT call this — project identity (skills,
   * history, session storage) stays where the session started.
   */
  setProjectRoot(nextCwd: string): void {
    this.projectRoot = nextCwd.normalize('NFC')
  }

  setCwdState(nextCwd: string): void {
    this.cwd = nextCwd.normalize('NFC')
    // EMIT-AFTER-WRITE, same law as switchSession: subscribers read the NEW
    // cwd synchronously, and the argument is the normalized value the cell
    // now holds. NO same-value guard, mirroring the no-same-id law above —
    // the owner stays dumb; a render consumer's snapshot compare
    // (useSyncExternalStore) is the dedupe seat, so a policy re-write of the
    // unchanged cwd costs a listener sweep and no repaint.
    this.cwdChanged.emit(this.cwd)
  }

  /**
   * The atomic session switch: `sessionId` and `sessionProjectDir` move as
   * ONE write — neither has a separate setter, so drift between them is
   * impossible by construction. The emit-after-write and
   * never-carries laws are in the header.
   */
  switchSession(sessionId: SessionId, projectDir: string | null = null): void {
    // Evict the outgoing session's slug — repeated /resume must not grow the
    // Map, and only the CURRENT session's slug is ever read (plans.ts
    // getPlanSlug defaults to getSessionId()).
    this.planSlugCache.delete(this.sessionId)
    this.sessionId = sessionId
    this.sessionProjectDir = projectDir
    this.sessionSwitched.emit(sessionId)
  }

  /** Does NOT emit the switch signal (deliberate — see the header). */
  regenerateSessionId(
    options: { setCurrentAsParent?: boolean } = {},
  ): SessionId {
    if (options.setCurrentAsParent) {
      this.parentSessionId = this.sessionId
    }
    // Evict the outgoing session's slug (the Map's boundedness law). A
    // caller that wants the slug to survive the regeneration (REPL.tsx
    // clearContext) reads it out BEFORE this runs.
    this.planSlugCache.delete(this.sessionId)
    // A regenerated session belongs to the current project: projectDir
    // resets to null and getTranscriptPath() re-derives from originalCwd.
    this.sessionId = randomUUID() as SessionId
    this.sessionProjectDir = null
    return this.sessionId
  }

  /**
   * Subscribe to switchSession's emit. This leaf cannot import its listeners
   * (bootstrap sits at the bottom of the import DAG), so interested parties
   * register themselves — concurrentSessions.ts does, to keep the PID file's
   * sessionId in step with --resume.
   */
  onSessionSwitch(listener: (id: SessionId) => void): () => void {
    return this.sessionSwitched.subscribe(listener)
  }

  /**
   * Subscribe to setCwdState's emit — the ground-move beat. Every writer
   * funnels through setCwdState (Shell.setCwd and the concourse repo pick
   * both do), so one subscription hears every ground move; the chrome that
   * names the session's folder re-reads on this beat instead of sampling
   * the cwd at render and healing on the next unrelated repaint.
   */
  onCwdChange(listener: (cwd: string) => void): () => void {
    return this.cwdChanged.subscribe(listener)
  }
}
