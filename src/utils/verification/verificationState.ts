// ============================================================================
//  verificationState — the mutation→verification evidence model (Sol 5.6 WS5;
//  OWNER-ADDRESSED since the frontier sprint).
//
//  ONE question, answered mechanically PER OWNER: "was the CURRENT tree
//  verified after the last code mutation *of this conversation*?" Every
//  successful first-party file mutation (Edit / Write / NotebookEdit / a
//  succeeded LSP apply effect) advances that owner's mutation sequence; every
//  verification command that completes records an evidence row stamped with
//  the owner's sequence AND the tracked-working-tree digest. The summary is
//  then a pure fold:
//
//    unverified — no evidence this session and none persisted for this tree
//    failed     — the newest evidence after the last mutation exited non-zero
//    stale      — mutations happened after the newest evidence, or the
//                 persisted evidence was recorded for a DIFFERENT tree
//    verified   — the newest evidence is green, covers this tree, and no
//                 mutation followed it (detail names what it covered)
//
//  OWNER MODEL: state is keyed by the canonical OwnerKey
//  (services/run/ownerKey.ts) in a bounded OwnerScopedStore. Two
//  conversations in one process can never share a mutation sequence, and
//  one owner's evidence can never satisfy another's mutation. Callers that
//  predate owner threading omit the owner and get the process MAIN owner —
//  single-conversation behavior is unchanged. Persisted evidence stays
//  TREE-bound (shared across restarts by design); an in-process owner never
//  inherits another owner's in-session sequence.
//
//  Consumers: the MercuryFrame chip (stale/failed only — no standing banner),
//  /health's VERIFICATION check, the self-check Stop hook (a completion
//  claim after mutation needs POST-mutation evidence — in-turn ordering
//  matters), and scripts/verify/fast.ts (which records its own evidence).
//
//  Evidence persists to <cwd>/.claude/verify/evidence.json so a restarted
//  session reads the digest-bound truth honestly: same tree ⇒ the record
//  stands; changed tree ⇒ stale, never silently green.
// ============================================================================

import { adoptiveProjectPath } from '../projectStoreAdoption.js'
import { getMercuryHome } from '../envUtils.js'
import { sanitizePath } from '../sessionStoragePortable.js'
import { execFile, execFileSync } from 'node:child_process'
import { gitExe } from '../git.js'
import { subprocessEnv } from '../subprocessEnv.js'
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import * as path from 'node:path'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { registerOwnerScopedStore } from '../../services/run/ownerLifecycle.js'
import { OwnerScopedStore } from '../../services/run/ownerScopedStore.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { loadDeclaredGates, matchDeclaredGate } from './projectGates.js'

export type VerificationScope =
  | 'full-gate'
  | 'typecheck'
  | 'suite'
  | 'proof'
  | 'build'
  | 'artifact-smoke'
  | 'fast'
  | 'test'
  /** generic project-verification families (foreign repos — npm/yarn/
   *  pnpm/make/cargo/just lint · check/validate/verify/ci verbs). The AVS
   *  field run's `npm run validate` + `npm test` minted NOTHING because the
   *  classifier only knew Mercury-repo shapes, so the evidence model called
   *  real green runs "unverified" while the commit gate's own (parallel)
   *  recognizer accepted them — one fact, two vocabularies. */
  | 'lint'
  | 'check'
  /** the read-back settlement class — every file mutated this
   *  session was Read back after the last mutation, in a workspace with NO
   *  verification machinery (a gate-verifiable workspace never mints this;
   *  the command classes above stay the only evidence there). */
  | 'read-back'

export interface EvidenceRecord {
  command: string
  ok: boolean
  scope: VerificationScope
  /** What this run covered, human-readable ("full gate", "scripts/lsp", …). */
  coverage: string
  ranAt: number
  /** Tracked-working-tree digest at record time (null: not a git checkout). */
  treeDigest: string | null
  /** Mutation sequence at record time — ordering INSIDE a session/turn. */
  seq: number
  /** Declared-gate identity: rows minted by a project-declared
   *  gate carry its stable id so soak counting keys on the gate, not the
   *  command spelling. Absent for family-classified rows. */
  gateId?: string
  /** Declared soak floor: the gate needs this many green runs on the current
   *  tree before it reads satisfied (default/absent = 1). */
  minRuns?: number
}

export type VerificationStateWord = 'verified' | 'stale' | 'failed' | 'unverified'

export interface VerificationSnapshot {
  state: VerificationStateWord
  detail: string
  lastEvidence: EvidenceRecord | null
  mutationsSinceEvidence: number
  lastMutationAt: number | null
}

const EVIDENCE_SCHEMA = 1
const MAX_RECORDS = 20

// ── owner-scoped session state ───────────────────────────────────────────────
interface OwnerVerificationState {
  mutationSeq: number
  lastMutationAt: number | null
  sessionRecords: EvidenceRecord[]
  persistedLoaded: boolean
  /** read-back settlement: absolute paths mutated since the last
   *  evidence that have NOT yet been read back. A mutation with unknown
   *  paths poisons settlement (pendingUnknownMutation) — the bounded demand
   *  ceiling is the backstop there. */
  pendingReadBack: Set<string>
  pendingUnknownMutation: boolean
  /** How many stop-gate evidence demands were issued since the last mutation
   *  or evidence row — the bounded re-arm (an evidence demand is
   *  unsatisfiable BY CONSTRUCTION for non-gate work; a demand that produced
   *  nothing twice settles honestly instead of looping). */
  evidenceDemands: number
}

const ownerStates = new OwnerScopedStore<OwnerVerificationState>({
  name: 'verification',
  create: () => ({
    mutationSeq: 0,
    lastMutationAt: null,
    sessionRecords: [],
    persistedLoaded: false,
    pendingReadBack: new Set(),
    pendingUnknownMutation: false,
    evidenceDemands: 0,
  }),
})
registerOwnerScopedStore(ownerStates)

/** Resolve the effective owner: explicit key, else the process MAIN owner. */
function effectiveOwner(owner?: OwnerKey): OwnerKey {
  return owner ?? processMainOwner()
}

const subscribers = new Set<() => void>()

function notify(): void {
  for (const cb of subscribers) {
    try {
      cb()
    } catch {
      /* subscriber errors never break the writer */
    }
  }
}

/** useSyncExternalStore-compatible subscription for UI chips. */
export function subscribeVerification(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/** Test/shutdown seam — drops EVERY owner's state (not the persisted file). */
export function _resetVerificationStateForTesting(): void {
  ownerStates.clearAllForShutdown()
  digestCache.clear()
}

/** Slice-1 owner teardown: drop one owner's in-session state. Idempotent. */
export function disposeVerificationOwner(owner: OwnerKey): void {
  ownerStates.dispose(owner)
}

/** Proof/diagnostic seam: live owner count in the verification registry. */
export function _verificationOwnerCountForTesting(): number {
  return ownerStates.size
}

// ── tree digest (shared trick with build.ts/.build-tree) ────────────────────
// Keyed by cwd: two owners in DIFFERENT workspaces must never share a digest
// (the old single-slot cache handed workspace B workspace A's tree).
const digestCache = new Map<string, { digest: string | null; at: number }>()
const DIGEST_TTL_MS = 10_000

export function computeWorkingTreeDigest(cwd: string): string | null {
  const now = Date.now()
  const cached = digestCache.get(cwd)
  if (cached && now - cached.at < DIGEST_TTL_MS) return cached.digest
  let digest: string | null = null
  let idxDir: string | null = null
  try {
    idxDir = mkdtempSync(path.join(tmpdir(), 'verify-tree-'))
    const env = { ...subprocessEnv(), GIT_INDEX_FILE: path.join(idxDir, 'index') }
    // execFileSync ARGV, never execSync command strings: execSync runs each
    // string through ComSpec — cmd.exe on win32 — so the four git calls cost
    // EIGHT process creations there where argv costs four, all on the event
    // loop (TASK-017 S2, tree-digest-execsync-through-cmd; the async twin
    // below already spells argv for the same reason). Still synchronous by
    // design at this seam — the async twin is the hot-path door.
    execFileSync(gitExe(), ['read-tree', 'HEAD'], { windowsHide: true, cwd, env, stdio: 'pipe', timeout: 30_000 })
    // .mercury/ AND .claude/ are HARNESS STATE (this very evidence file, gate
    // verdicts, doctor artifacts, workflow runs) — their churn must never
    // read as "the tree changed"; otherwise recording evidence would
    // immediately invalidate itself (the exact self-observation the gate run
    // caught). add-then-RESET, never an `:(exclude)` pathspec: `git add`
    // EXITS NONZERO whenever a PRESENT-and-gitignored harness dir is named
    // by an exclude pathspec (git treats even an exclude pathspec as
    // "explicitly naming" the ignored dir), which nulls every digest
    // repo-wide. `git reset -- <dirs>` restores the harness dirs to HEAD in
    // the temp index — immune to their presence/ignore state.
    execFileSync(gitExe(), ['add', '-A', '--', '.'], { windowsHide: true, cwd, env, stdio: 'pipe', timeout: 30_000 })
    execFileSync(gitExe(), ['reset', '-q', '--', '.claude', '.mercury'], { windowsHide: true, cwd, env, stdio: 'pipe', timeout: 30_000 })
    digest = execFileSync(gitExe(), ['write-tree'], { windowsHide: true, cwd, env, stdio: 'pipe', timeout: 30_000 }).toString().trim() || null
  } catch {
    digest = null
  } finally {
    if (idxDir) rmSync(idxDir, { recursive: true, force: true })
  }
  digestCache.set(cwd, { digest, at: now })
  return digest
}

/**
 * Async variant for drain/hot paths (the context-capsule producer): the SAME
 * temp-index trick and the SAME cache/TTL, but async execFile — `git add -A`
 * hashes the whole working tree (~1.5s on a large repo, ~1% CPU: pure
 * subprocess wall time) and the sync form blocks the event loop for all of
 * it (the tasks-runs-only red, queued keypresses burst-drained
 * out of their intended state windows). Concurrent callers coalesce on one
 * in-flight build per cwd.
 */
const digestInFlight = new Map<string, Promise<string | null>>()

export function computeWorkingTreeDigestAsync(cwd: string): Promise<string | null> {
  const cached = digestCache.get(cwd)
  if (cached && Date.now() - cached.at < DIGEST_TTL_MS) return Promise.resolve(cached.digest)
  const inFlight = digestInFlight.get(cwd)
  if (inFlight) return inFlight
  const build = (async (): Promise<string | null> => {
    let digest: string | null = null
    let idxDir: string | null = null
    try {
      idxDir = mkdtempSync(path.join(tmpdir(), 'verify-tree-'))
      const env = { ...subprocessEnv(), GIT_INDEX_FILE: path.join(idxDir, 'index') }
      const git = (args: string[]): Promise<string> =>
        new Promise((resolve, reject) => {
          execFile(gitExe(), args, { windowsHide: true, cwd, env }, (err, stdout) =>
            err ? reject(err) : resolve(stdout),
          )
        })
      await git(['read-tree', 'HEAD'])
      // add-then-RESET — the same law as the sync form (a present-and-
      // gitignored harness dir must not null the digest repo-wide; reset
      // restores the harness dirs to HEAD in the temp index).
      await git(['add', '-A', '--', '.'])
      await git(['reset', '-q', '--', '.claude', '.mercury'])
      digest = (await git(['write-tree'])).trim() || null
    } catch {
      digest = null
    } finally {
      if (idxDir) rmSync(idxDir, { recursive: true, force: true })
      digestInFlight.delete(cwd)
    }
    digestCache.set(cwd, { digest, at: Date.now() })
    return digest
  })()
  digestInFlight.set(cwd, build)
  return build
}

// ── persistence ──────────────────────────────────────────────────────────────
// runtime evidence lives OUTSIDE the checkout
// by default — a config-home project-keyed store. The workspace copy
// (<project>/.mercury/verify/evidence.json) is an explicit OPT-IN via
// MERCURY_WORKSPACE_EVIDENCE; reads still accept a legacy workspace file so
// pre-3.4 evidence migrates instead of vanishing.
function evidencePath(cwd: string): string {
  return path.join(getMercuryHome(), 'verify', sanitizePath(cwd), 'evidence.json')
}
function workspaceEvidencePath(cwd: string): string {
  return path.join(adoptiveProjectPath(cwd, 'verify'), 'evidence.json')
}
function workspaceEvidenceOptIn(): boolean {
  const v = flagEnv('MERCURY_WORKSPACE_EVIDENCE')
  return v === '1' || v === 'true'
}

function loadPersisted(cwd: string, state: OwnerVerificationState): void {
  if (state.persistedLoaded) return
  state.persistedLoaded = true
  try {
    // Config-home store first; the legacy/opt-in workspace file as fallback.
    let raw: string
    try {
      raw = readFileSync(evidencePath(cwd), 'utf8')
    } catch {
      raw = readFileSync(workspaceEvidencePath(cwd), 'utf8')
    }
    const parsed = JSON.parse(raw) as { schema?: number; records?: EvidenceRecord[] }
    if (parsed.schema === EVIDENCE_SCHEMA && Array.isArray(parsed.records)) {
      // Persisted rows belong to an EARLIER process: their seq ordering is
      // meaningless against this owner's counter — normalize to seq 0 so
      // any in-session mutation outranks them; the tree digest carries the
      // real cross-restart truth.
      state.sessionRecords = parsed.records.slice(-MAX_RECORDS).map(r => ({ ...r, seq: 0 }))
    }
  } catch {
    /* absent/corrupt ⇒ no persisted evidence — honest 'unverified' */
  }
}

function persist(cwd: string, state: OwnerVerificationState): void {
  try {
    // Durable publication — collision-free temp, win32 retry.
    const payload = JSON.stringify({ schema: EVIDENCE_SCHEMA, records: state.sessionRecords.slice(-MAX_RECORDS) }, null, 2)
    durableAtomicPublishSync(evidencePath(cwd), payload)
    if (workspaceEvidenceOptIn()) {
      durableAtomicPublishSync(workspaceEvidencePath(cwd), payload)
    }
  } catch {
    /* best-effort — a persistence failure never breaks the session model */
  }
}

// ── mutation marking ─────────────────────────────────────────────────────────
const MUTATION_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

/** True when a completed tool call mutated tracked files (first-party paths).
 *  LEGACY input-shape classifier — used ONLY for tools that emit no typed
 *  ToolEffect (a tool whose result carries an effect is judged by the effect
 *  observer instead: outcome + actual changedPaths, never input intent).
 *  LSP migrated to typed effects in — its apply:true INPUT no longer
 *  marks anything; a failed/no-op apply advances nothing, and a real apply
 *  marks exactly its written paths through the effect observer. */
export function isMutationToolCall(toolName: string, _input: unknown): boolean {
  return MUTATION_TOOLS.has(toolName)
}

/** ONE canonical form for read-back debt keys: realpath when resolvable
 *  (macOS `/tmp` vs `/private/tmp` symlink forms must collide), resolve
 *  otherwise (the file may be gone by pay time). Exported so the efficiency
 *  gate keys its exemption identically — one law, never two spellings. */
export function canonicalEvidencePath(p: string): string {
  const resolved = path.resolve(p)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

export function markMutation(
  owner?: OwnerKey,
  changedPaths?: readonly string[],
  cwd?: string,
  opts?: {
    /** the publication settled a digest-bearing
     *  MutationReceipt — exact bytes are PROVEN harness-side, so no
     *  model-visible read-back debt mints. The verification (test) lane
     *  still advances through mutationSeq. */
    digestReceipted?: boolean
  },
): void {
  const state = ownerStates.get(effectiveOwner(owner))
  state.mutationSeq++
  state.lastMutationAt = Date.now()
  // read-back tracking: known paths become read-back debt; a mutation
  // whose paths are unknown poisons settlement (the bounded demand ceiling is
  // the honest backstop). A fresh mutation re-arms the demand budget.
  if (changedPaths && changedPaths.length > 0) {
    if (!opts?.digestReceipted) {
      for (const p of changedPaths) state.pendingReadBack.add(canonicalEvidencePath(p))
    }
  } else {
    state.pendingUnknownMutation = true
  }
  state.evidenceDemands = 0
  // Invalidation is scoped to the tree the mutation touched (hot-path
  // cadence C2c): the cache is deliberately keyed by cwd — two workspaces
  // must never share a digest — so an edit in workspace A must not discard
  // workspace B's still-valid one. An unknown cwd keeps the conservative
  // full clear.
  if (cwd !== undefined) digestCache.delete(cwd)
  else digestCache.clear() // the tree changed somewhere — every digest is suspect
  //  negative-discovery law: the mutation may have CREATED a
  // gate (a gates.json, a package.json, a Godot project) — a cached
  // not-verifiable verdict must not survive it.
  if (cwd !== undefined) verifiableCache.delete(cwd)
  else verifiableCache.clear()
  notify()
}

/** Default-ON gate (MERCURY_VERIFY_EVIDENCE=0 kills observation, records,
 *  the evidence file, and the chip — re-read live per call). */
export function verifyEvidenceEnabled(): boolean {
  return flagEnv('MERCURY_VERIFY_EVIDENCE') !== '0'
}

/** The universal-chokepoint observer (toolExecution): marks mutations and
 *  records Bash-run verification commands, from ONE completed-call event.
 *  Owner-addressed: a subagent's mutations advance ITS sequence, never the
 *  main conversation's. */
export function observeCompletedToolCall(
  toolName: string,
  input: unknown,
  ok: boolean,
  cwd: string,
  owner?: OwnerKey,
  /** 'launch' = the call merely STARTED a background task
   *  (its ok/code are presentation, not outcome) — evidence never mints from
   *  it. Omitted/'terminal' keeps the historical behavior exactly. */
  lifecycle?: 'terminal' | 'launch',
): void {
  try {
    if (!verifyEvidenceEnabled()) return
    if (ok && isMutationToolCall(toolName, input)) {
      const p = (input as { file_path?: unknown; notebook_path?: unknown } | undefined)
      const filePath = typeof p?.file_path === 'string' ? p.file_path : typeof p?.notebook_path === 'string' ? p.notebook_path : null
      markMutation(owner, filePath ? [filePath] : undefined, cwd)
      return
    }
    // read-back settlement: a successful WHOLE-FILE Read of a mutated
    // file pays its read-back debt; when the debt clears in a workspace with
    // NO verification machinery, the settlement mints an honest evidence row
    // (scope 'read-back') — the four-round unsatisfiable loop becomes
    // structurally unreachable. A gate-verifiable workspace never mints here.
    // Ranged Reads never pay (wave finding 10: a 1-line peek must not attest
    // "changed files read back") — mirroring the efficiency gate's law, which
    // exempts only whole-file demanded read-backs.
    if (ok && toolName === 'Read') {
      const inp = input as { file_path?: unknown; offset?: unknown; limit?: unknown } | undefined
      if (typeof inp?.file_path === 'string' && inp.offset === undefined && inp.limit === undefined) {
        noteReadBack(cwd, inp.file_path, owner)
      }
      return
    }
    if (toolName === 'Bash' || toolName === 'PowerShell') {
      // PowerShell too: Windows sessions run their verifies through
      // the PowerShell tool — Bash-only observation left every Windows green
      // run unminted, so receipts could never exist there.
      // a background LAUNCH is not a terminal outcome — its
      // fabricated ok/code must never mint evidence. The real mint happens at
      // the LocalShellTask terminal transition (recordShellCommandOutcome).
      if (lifecycle === 'launch') return
      const command = String((input as { command?: unknown } | undefined)?.command ?? '')
      const cls = classifyVerificationCommand(command, cwd)
      if (cls) recordEvidence(cwd, { command, ok, ...cls }, owner)
    }
  } catch {
    /* observation must never break tool execution */
  }
}

// ──: workspace verifiability + read-back settlement + demand budget ──

/** Probe cache: cwd → does this workspace carry ANY recognizable
 *  verification machinery? (package.json test/typecheck/verify/check
 *  scripts, run-all-suites.sh, scripts/<domain>/run-all.sh, vitest/jest
 *  config.) The stop gate's "run the smallest real verification" demand is
 *  APPLICABLE only where such machinery exists — demanding gate evidence in
 *  a Desktop docs folder is unsatisfiable by construction. */
const verifiableCache = new Map<string, { verdict: boolean; at: number }>()
const VERIFIABLE_TTL_MS = 60_000
/**  negative-discovery law: a NEGATIVE verdict must never
 *  outlive the creation of a real gate. Mercury-observed mutations
 *  invalidate the cache instantly (markMutation); external creation is
 *  bounded by this short TTL — seconds, never the 60s positive window. */
const VERIFIABLE_NEGATIVE_TTL_MS = 5_000

export function workspaceVerifiable(cwd: string, owner?: OwnerKey): boolean {
  // Observed evidence outranks the probe: a session that already ran a
  // recognized verification command has PROVEN the machinery exists.
  const state = ownerStates.peek(effectiveOwner(owner))
  if (state?.sessionRecords.some(r => r.scope !== 'read-back')) return true
  const cached = verifiableCache.get(cwd)
  if (
    cached &&
    Date.now() - cached.at <
      (cached.verdict ? VERIFIABLE_TTL_MS : VERIFIABLE_NEGATIVE_TTL_MS)
  ) {
    return cached.verdict
  }
  let verdict = false
  try {
    const has = (rel: string): boolean => {
      try {
        return existsSync(path.join(cwd, rel))
      } catch {
        return false
      }
    }
    if (has('scripts/run-all-suites.sh')) verdict = true
    //  rank 1 + Godot adapter: explicit declarations are
    // machinery by definition; a project.godot workspace always carries at
    // least the engine's own headless parse/scene checks — the field's seven
    // scene gates were invisible to the shape probes below.
    if (!verdict && loadDeclaredGates(cwd).length > 0) verdict = true
    if (!verdict && has('project.godot')) verdict = true
    if (!verdict && has('package.json')) {
      try {
        const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
          scripts?: Record<string, unknown>
        }
        const s = pkg.scripts ?? {}
        verdict = ['test', 'typecheck', 'verify', 'check', 'lint'].some(k => typeof s[k] === 'string')
      } catch {
        /* unreadable package.json proves nothing */
      }
    }
    if (!verdict) {
      verdict = ['vitest.config.ts', 'vitest.config.js', 'jest.config.ts', 'jest.config.js', 'Makefile'].some(has)
    }
    if (!verdict && has('scripts')) {
      try {
        verdict = readdirSync(path.join(cwd, 'scripts'), { withFileTypes: true }).some(
          d => d.isDirectory() && existsSync(path.join(cwd, 'scripts', d.name, 'run-all.sh')),
        )
      } catch {
        /* unreadable scripts dir proves nothing */
      }
    }
  } catch {
    verdict = false
  }
  verifiableCache.set(cwd, { verdict, at: Date.now() })
  return verdict
}

/** A successful Read of a mutated file pays its read-back debt; full
 *  settlement in a NON-verifiable workspace mints the read-back evidence row
 *  (which clears mutationsSinceEvidence through the normal fold). */
function noteReadBack(cwd: string, filePath: string, owner?: OwnerKey): void {
  const state = ownerStates.get(effectiveOwner(owner))
  const abs = canonicalEvidencePath(filePath)
  if (!state.pendingReadBack.delete(abs)) return
  if (
    state.pendingReadBack.size === 0 &&
    !state.pendingUnknownMutation &&
    state.mutationSeq > (state.sessionRecords.at(-1)?.seq ?? 0) &&
    !workspaceVerifiable(cwd, owner)
  ) {
    recordEvidence(
      cwd,
      {
        command: '(read-back)',
        ok: true,
        scope: 'read-back',
        coverage: 'changed files read back (no verification machinery in this workspace)',
      },
      owner,
    )
  }
}

/** item-1 typed demand/gate contract: the read-back paths the stop
 *  gate's demand is (or would be) asking for — the owner's unpaid read-back
 *  debt, in a workspace where read-back IS the evidence class (no
 *  verification machinery). The fable tool-efficiency gate consults THIS set
 *  (one store, one law — never a parallel copy) and passes those Reads so
 *  the demand it must satisfy is satisfiable on the first call; the Read
 *  then mints the read-back row through the normal observer. In a
 *  gate-verifiable workspace this is EMPTY — redundant re-reads stay
 *  discouraged there (the AVS field contradiction: the stop hook demanded
 *  "read each changed file back — read-back is the evidence" and the
 *  efficiency gate denied exactly those Reads as wasted context). */
const EMPTY_PATH_SET: ReadonlySet<string> = new Set()

export function demandedReadBackPaths(cwd: string, owner?: OwnerKey): ReadonlySet<string> {
  const state = ownerStates.peek(effectiveOwner(owner))
  if (!state || state.pendingReadBack.size === 0) return EMPTY_PATH_SET
  if (workspaceVerifiable(cwd, owner)) return EMPTY_PATH_SET
  return new Set(state.pendingReadBack)
}

/** The stop gate reports it issued an evidence demand — the bounded re-arm's
 *  counter. Reset by any new mutation (re-arms honestly) or evidence row. */
export function noteEvidenceDemandIssued(owner?: OwnerKey): void {
  const state = ownerStates.get(effectiveOwner(owner))
  state.evidenceDemands++
}

/** Demands issued since the last mutation/evidence (the evaluator's bound). */
export function evidenceDemandCount(owner?: OwnerKey): number {
  return ownerStates.peek(effectiveOwner(owner))?.evidenceDemands ?? 0
}

// ── the ONE verification-command vocabulary ─────────────────────────
//
//  "Is this shell command a verification, and what does it prove?" had TWO
//  parallel recognizers: this classifier (minted evidence — Mercury-repo
//  shapes only) and the fable commit gate's VERIFY_PATTERNS (accepted chains —
//  broad npm/pytest/cargo families). A recognizer
//  split means `npm run validate` + `npm test` green mint NO evidence, so
//  the stop gate demanded read-back "no verification machinery" while real
//  suites were green, and the commit gate forced a same-command rerun of
//  work the evidence model never saw. One fact, one vocabulary, two
//  consumers: the classifier below is the single owner; the commit gate
//  imports `isVerifySegment`/`splitShellControlOps` from here.

/** Blank quoted args ("…"/'…', backslash-escape aware) so a verify-shaped
 *  word INSIDE a commit message or echo string can never read as a verify
 *  (`git commit -m "npm test fixed"` must classify as nothing). */
export function stripQuotedShellArgs(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
}

/** The leading command token of a segment, path-stripped + lowercased. */
export function leadingShellCommandToken(segment: string): string {
  const tok = segment.trim().split(/\s+/)[0] ?? ''
  return tok.replace(/^.*[\\/]/, '').toLowerCase()
}

/** Heads that exit 0 (or merely print) WITHOUT running anything — a verify
 *  WORD as their argument is not a verify. */
export const NOOP_COMMAND_HEADS: ReadonlySet<string> = new Set([
  'echo', 'printf', 'true', 'false', ':', 'cat', 'ls', 'pwd', 'test', '[',
])

/** Per-segment left-operator class. `&&` guards (right runs iff left
 *  SUCCEEDED); `pipe` is a pipeline join (exit-preserving ONLY under
 *  pipefail); `or` (`||`) runs the right iff the left FAILED — which ALSO
 *  means the right side may never run (reachability, wave finding 3);
 *  everything else (`;` newline `&`) breaks the chain. */
export type ShellChainOp = '&&' | 'pipe' | 'or' | 'break'
export interface ShellCommandSegment {
  text: string
  opBefore: ShellChainOp | 'start'
}

/**
 * Split a command on the shell control operators, classifying each boundary.
 * Quoted args are blanked FIRST (an operator inside a commit message never
 * splits), and fd-duplication redirects (`2>&1`, `>&2`) are neutralized so
 * their `&` never reads as a background op — the old gate split `npm test
 * 2>&1 && git commit` into a broken chain and denied a correctly chained
 * commit.
 */
export function splitShellControlOps(command: string): ShellCommandSegment[] {
  // Neutralize fd-duplication (`2>&1`, `>&2`) AND bash's combined-redirect
  // forms (`&>`, `&>>`) BEFORE splitting — their `&` is a redirect, not a
  // background op (`npm test &> log` split at the `&` and killed the mint;
  // wave finding 6).
  const bare = stripQuotedShellArgs(command)
    .replace(/\d*>&\d*/g, '>')
    .replace(/&>>?/g, '>')
  // Keep delimiters; `&&`/`||` must precede the single-char `&`/`|` so the
  // two-char operators win the alternation.
  const parts = bare.split(/(&&|\|\||;|\n|&|\|)/)
  const segments: ShellCommandSegment[] = []
  let opBefore: ShellCommandSegment['opBefore'] = 'start'
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === undefined) continue
    if (i % 2 === 1) {
      opBefore = part === '&&' ? '&&' : part === '|' ? 'pipe' : part === '||' ? 'or' : 'break'
      continue
    }
    if (part.trim() === '') continue
    segments.push({ text: part, opBefore })
  }
  return segments
}

/** `set -o pipefail` (incl. combined flags: `set -euo pipefail`) in any
 *  segment strictly BEFORE index `i` — the pipeline exit then reflects a
 *  failing verify, so `pipe` boundaries preserve the verifier's exit. */
export function pipefailActiveBefore(
  segments: readonly ShellCommandSegment[],
  i: number,
): boolean {
  for (let j = 0; j < i; j++) {
    if (/\bset\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*o\s+pipefail\b/.test(segments[j]!.text)) return true
  }
  return false
}

/**
 * A per-project verify escape: MERCURY_VERIFY_PATTERN (compat
 * MERCURY_VERIFY_PATTERN), an extra case-insensitive regex, lets a repo whose
 * green-gate runner the families can't name (a `./gradlew`, a wrapper) still
 * classify. Absent/unparseable ⇒ null ⇒ the curated families alone decide.
 */
export function projectVerifyPattern(): RegExp | null {
  const raw = flagEnv('MERCURY_VERIFY_PATTERN')
  if (!raw) return null
  try {
    return new RegExp(raw, 'i')
  } catch {
    return null
  }
}

/** Generic verb → the honest evidence scope. */
function verbScope(verb: string): VerificationScope {
  const v = verb.toLowerCase()
  if (v === 'test') return 'test'
  if (v === 'typecheck') return 'typecheck'
  if (v === 'build') return 'build'
  if (v === 'lint') return 'lint'
  return 'check' // check / validate / verify / ci
}

const GENERIC_VERBS = 'test|build|typecheck|lint|check|validate|verify|ci'

// The three GENERIC_VERBS matchers are static — minted ONCE at module load.
// They were re-minted per shell segment, unconditionally, after every Bash/
// PowerShell result for the whole session (even a bare `ls` paid all three
// before falling through). No /g flag, so the shared objects are stateless.
const NPM_VERB_RE = new RegExp(
  `\\b(npm|yarn|pnpm)\\s+(?:(?:--prefix|-w|--workspace|-C|--dir|--cwd|cwd|--filter|-F)(?:[=\\s]\\S+)?\\s+)?(?:workspace\\s+\\S+\\s+)?(?:run\\s+)?(${GENERIC_VERBS})(?::\\S+)?\\b`,
  'i',
)
const MAKE_VERB_RE = new RegExp(`\\bmake\\s+(${GENERIC_VERBS})\\b`, 'i')
const JUST_VERB_RE = new RegExp(`\\bjust\\s+(${GENERIC_VERBS})\\b`, 'i')

/** A classified verify with optional declared-gate identity (:
 *  gateId keys receipts + soak counting; minRuns is the declared soak floor). */
export interface VerifyClassification {
  scope: VerificationScope
  coverage: string
  gateId?: string
  minRuns?: number
}

/**
 * Classify ONE control-op-free segment. Authority order:
 * project-DECLARED gates first (rank 1 — needs cwd), then Mercury-canonical
 * shapes, then ecosystem families (the commit gate's vocabulary + Godot),
 * then the per-project pattern. Null = not a verify. Callers pass
 * POST-stripQuotedShellArgs text (splitShellControlOps output); cwd is
 * optional — without it, declared gates simply don't participate (every
 * curated family still classifies identically).
 */
export function classifyVerifySegment(
  segment: string,
  cwd?: string,
): VerifyClassification | null {
  const c = segment.trim()
  if (!c || NOOP_COMMAND_HEADS.has(leadingShellCommandToken(c))) return null
  // ── rank 1: explicit project-local gate declarations ──
  if (cwd !== undefined) {
    const declared = matchDeclaredGate(c, cwd)
    if (declared) return declared
  }
  // ── Mercury-canonical shapes ──
  if (/run-all-suites\.sh/.test(c)) {
    // A subset run proves less — coverage says which subset.
    const m = c.match(/run-all-suites\.sh\s+([a-z0-9 _-]+)/)
    return m?.[1]?.trim()
      ? { scope: 'suite', coverage: `gate subset: ${m[1].trim()}` }
      : { scope: 'full-gate', coverage: 'full gate (every domain suite)' }
  }
  if (/scripts\/typecheck\/run-all\.sh|bun run typecheck\b/.test(c)) {
    return { scope: 'typecheck', coverage: 'strict typecheck floor' }
  }
  const suite = c.match(/scripts\/([a-z0-9-]+)\/run-all\.sh/)
  if (suite?.[1]) return { scope: 'suite', coverage: `scripts/${suite[1]} suite` }
  const proof = c.match(/(prove-[a-z0-9-]+\.ts)/)
  if (proof?.[1]) return { scope: 'proof', coverage: proof[1] }
  if (/scripts\/verify\/fast\.ts|bun run verify:fast\b/.test(c)) {
    // The slice rung's own in-run record (scope 'fast'/'full-gate' with the
    // selected suites or the escalation NAMED) is the richer row; this
    // command-shape row stays honest about which rung ran.
    return { scope: 'fast', coverage: 'verify:fast (slice rung)' }
  }
  if (/bun run verify\b/.test(c)) return { scope: 'full-gate', coverage: 'full gate (bun run verify)' }
  if (/bun run artifact:smoke\b/.test(c)) return { scope: 'artifact-smoke', coverage: 'isolated artifact smoke' }
  if (/bun run build\.ts|bun run build\b/.test(c)) return { scope: 'build', coverage: 'real artifact build' }
  if (/\bbun\s+(run\s+)?test\b|\bvitest\b(?! --version)/.test(c)) return { scope: 'test', coverage: 'test run' }
  // ── generic project families (the commit gate's vocabulary, now shared) ──
  const npm = c.match(NPM_VERB_RE)
  if (npm?.[1] && npm[2]) {
    return { scope: verbScope(npm[2]), coverage: `${npm[1].toLowerCase()} ${npm[2].toLowerCase()}` }
  }
  if (/\bpytest\b/i.test(c)) return { scope: 'test', coverage: 'pytest' }
  if (/\bpython3?\s+\S*test/i.test(c)) return { scope: 'test', coverage: 'python test run' }
  if (/\bgo\s+test\b/i.test(c)) return { scope: 'test', coverage: 'go test' }
  const cargo = c.match(/\bcargo\s+(test|build|check)\b/i)
  if (cargo?.[1]) return { scope: verbScope(cargo[1]), coverage: `cargo ${cargo[1].toLowerCase()}` }
  if (/\btsc\b/.test(c)) return { scope: 'typecheck', coverage: 'tsc' }
  if (/\bjest\b/i.test(c)) return { scope: 'test', coverage: 'jest' }
  const make = c.match(MAKE_VERB_RE)
  if (make?.[1]) return { scope: verbScope(make[1]), coverage: `make ${make[1].toLowerCase()}` }
  if (/\bnode\s+--test\b/i.test(c)) return { scope: 'test', coverage: 'node --test' }
  const just = c.match(JUST_VERB_RE)
  if (just?.[1]) return { scope: verbScope(just[1]), coverage: `just ${just[1].toLowerCase()}` }
  // Foreign-ecosystem runners (wave finding 2: without these, a red gradle/mvn
  // suite is INVISIBLE to the evidence model while the read-back class settles
  // the stop demand — the commit receipt must never ride that blind spot).
  const gradle = c.match(/\bgradlew?\s+(test|check|build)\b/i)
  if (gradle?.[1]) return { scope: verbScope(gradle[1]), coverage: `gradle ${gradle[1].toLowerCase()}` }
  const mvn = c.match(/\bmvn\s+(?:-\S+\s+)*(test|verify|package)\b/i)
  if (mvn?.[1]) return { scope: mvn[1].toLowerCase() === 'test' ? 'test' : 'check', coverage: `mvn ${mvn[1].toLowerCase()}` }
  if (/\bsbt\s+test\b/i.test(c)) return { scope: 'test', coverage: 'sbt test' }
  const dotnet = c.match(/\bdotnet\s+(test|build)\b/i)
  if (dotnet?.[1]) return { scope: verbScope(dotnet[1]), coverage: `dotnet ${dotnet[1].toLowerCase()}` }
  const bazel = c.match(/\bbazel\s+(test|build)\b/i)
  if (bazel?.[1]) return { scope: verbScope(bazel[1]), coverage: `bazel ${bazel[1].toLowerCase()}` }
  if (/\brake\s+(test|spec)\b/i.test(c)) return { scope: 'test', coverage: 'rake test' }
  if (/\bmix\s+test\b/i.test(c)) return { scope: 'test', coverage: 'mix test' }
  if (/\btox\b(?!\S)/i.test(c)) return { scope: 'test', coverage: 'tox' }
  // Godot headless gates (: the field's seven scene
  // checks were invisible to this vocabulary). A godot binary running a
  // script headlessly (--script/-s — GUT's gut_cmdln.gd included) is a test
  // run; --check-only/--validate-only is a parse check; a bare headless
  // launch (running the game) is NOT a verify.
  if (/\bgodot[\w.-]*(\s|$)/i.test(c)) {
    const script = c.match(/(?:--script|-s)\s+(\S+)/i)
    if (/--headless\b/i.test(c) && script?.[1]) {
      return { scope: 'test', coverage: `godot headless ${script[1]}` }
    }
    if (/--check-only\b|--validate-only\b/i.test(c)) {
      return { scope: 'check', coverage: 'godot parse check' }
    }
  }
  if (/\bgreen-?gate\b/i.test(c)) return { scope: 'check', coverage: 'green-gate runner' }
  // A leading script invocation whose PATH names a curated verify word —
  // `bash scripts/check.sh`, `sh ci.sh`, `./run-tests`. Word-set curated.
  const script = c.match(/^\s*(?:bash|sh)\s+(\S*(?:test|check|verify|gate|suite|ci|lint)\S*)/i)
    ?? c.match(/^\s*(\.\/\S*(?:test|check|verify|gate|suite|ci|lint)\S*)/i)
  if (script?.[1]) return { scope: 'check', coverage: `project script ${script[1]}` }
  const extra = projectVerifyPattern()
  if (extra?.test(c)) return { scope: 'check', coverage: 'project verify pattern (MERCURY_VERIFY_PATTERN)' }
  return null
}

/** Commit-gate view of the vocabulary: is this segment a real verify? */
export function isVerifySegment(segment: string, cwd?: string): boolean {
  return classifyVerifySegment(stripQuotedShellArgs(segment), cwd) !== null
}

/** Tails that may follow a minting verify without poisoning the binding: the
 *  chained-commit idiom (`verify && git add && git commit`) and pure no-ops.
 *  Anything else after the verify (a `sed -i`, a redirect write, a build
 *  step) could mutate the tree AFTER the suite ran — recordEvidence digests
 *  the POST-command tree, so the row would attest a tree the suite never
 *  saw (wave finding 3a). */
const SAFE_TAIL_HEADS = new Set(['git', 'echo', 'printf', 'true', ':'])

function safeTailSegment(segment: string): boolean {
  // A real redirect (post fd-neutralization) can write a tracked file.
  if (/(^|\s)>>?\s/.test(segment) && !/>{1,2}\s*['"]?\/(?:dev|proc)\//.test(segment)) {
    return false
  }
  return SAFE_TAIL_HEADS.has(leadingShellCommandToken(segment))
}

/**
 * Classify a FULL command for evidence minting. A verify segment mints ONLY
 * when the row would be TRUE:
 *  · REACHABILITY (wave finding 3): no `||` boundary at or before the verify
 *    — `[ -d node_modules ] || npm ci` exits 0 WITHOUT running the verify
 *    when the left side succeeds; a green row would be pure fiction.
 *  · CWD BINDING (3b): no earlier `cd /abs` / `cd ~` — the suite ran against
 *    a different tree than the digest describes.
 *  · EXIT PROPAGATION: later boundaries are `&&` (or `pipe` under pipefail);
 *    `npm test | tee log` without pipefail masks a red suite.
 *  · TREE BINDING (3a): later segments are safe tails (git/no-op) — a
 *    mutation after the verify would bind the row to a tree the suite never
 *    saw.
 */
export function classifyVerificationCommand(
  command: string,
  cwd?: string,
): VerifyClassification | null {
  const segments = splitShellControlOps(command)
  outer: for (let i = 0; i < segments.length; i++) {
    const cls = classifyVerifySegment(segments[i]!.text, cwd)
    if (!cls) continue
    for (let j = 0; j <= i; j++) {
      const seg = segments[j]!
      if (seg.opBefore === 'or') continue outer // conditionally-skipped verify
      if (j < i && /^\s*cd\s+['"]?[/~]/.test(seg.text)) continue outer // foreign tree
    }
    if (verifyExitPropagates(segments, i)) return cls
  }
  return null
}

function verifyExitPropagates(
  segments: readonly ShellCommandSegment[],
  i: number,
): boolean {
  const pipefail = pipefailActiveBefore(segments, i)
  for (let j = i + 1; j < segments.length; j++) {
    const op = segments[j]!.opBefore
    if (op === 'pipe' && pipefail) continue
    if (op !== '&&') return false
    // An `&&`-joined tail still binds the digest — it must not mutate.
    if (!classifyVerifySegment(segments[j]!.text) && !safeTailSegment(segments[j]!.text)) {
      return false
    }
  }
  return true
}

// payload-bearing subscription — the canonical evidence
// plane projects verification rows without this module importing it (the
// same one-way idiom as the receipt mint's subscribers).
type EvidenceRecordedSubscriber = (owner: OwnerKey, record: EvidenceRecord) => void
const evidenceSubscribers = new Set<EvidenceRecordedSubscriber>()

export function subscribeEvidenceRecorded(cb: EvidenceRecordedSubscriber): () => void {
  evidenceSubscribers.add(cb)
  return () => {
    evidenceSubscribers.delete(cb)
  }
}

export function recordEvidence(
  cwd: string,
  e: {
    command: string
    ok: boolean
    scope: VerificationScope
    coverage: string
    gateId?: string
    minRuns?: number
  },
  owner?: OwnerKey,
): void {
  const resolvedOwner = effectiveOwner(owner)
  const state = ownerStates.get(resolvedOwner)
  loadPersisted(cwd, state)
  const record: EvidenceRecord = {
    ...e,
    ranAt: Date.now(),
    treeDigest: computeWorkingTreeDigest(cwd),
    seq: state.mutationSeq,
  }
  // A GREEN row settles the demand budget; a RED row must NOT — resetting on
  // failure re-arms the "fix the failing verification" branch forever (each
  // failed re-run buying two more demands: the unsatisfiable loop shape
  // in the failed arm). Read-back debt clears either way
  // (an evidence attempt happened; the mutations were exercised).
  if (e.ok) state.evidenceDemands = 0
  state.pendingReadBack.clear()
  state.pendingUnknownMutation = false
  state.sessionRecords.push(record)
  if (state.sessionRecords.length > MAX_RECORDS) {
    state.sessionRecords = state.sessionRecords.slice(-MAX_RECORDS)
  }
  persist(cwd, state)
  for (const cb of evidenceSubscribers) {
    try {
      cb(resolvedOwner, record)
    } catch {
      /* subscriber errors never break the writer */
    }
  }
  notify()
}

/**
 * the background task's TERMINAL transition mints its
 * verification evidence with the REAL exit code — the launch-time tool
 * result (fabricated code 0 + backgroundTaskId) minted nothing. Called by
 * LocalShellTask's result handlers on natural completion/failure; a KILLED
 * task mints nothing (stopped is not a verification outcome). Never throws.
 */
export function recordShellCommandOutcome(
  command: string,
  exitCode: number,
  cwd: string,
  owner?: OwnerKey,
): void {
  try {
    if (!verifyEvidenceEnabled()) return
    const cls = classifyVerificationCommand(command, cwd)
    if (cls) recordEvidence(cwd, { command, ok: exitCode === 0, ...cls }, owner)
  } catch {
    /* observation must never break task settlement */
  }
}

/** The owner's observed verification records, oldest first (bounded to the
 *  session ring). The AgentResultEnvelope reads these to
 *  cross-check declared checks against what actually ran — read-only view,
 *  never mutates or persists. */
export function evidenceRecordsFor(owner?: OwnerKey): readonly EvidenceRecord[] {
  const state = ownerStates.peek(effectiveOwner(owner))
  return state ? [...state.sessionRecords] : []
}

// ── the summary fold ─────────────────────────────────────────────────────────
export function verificationSummary(
  cwd: string,
  opts?: { skipDigest?: boolean; owner?: OwnerKey },
): VerificationSnapshot {
  const state = ownerStates.get(effectiveOwner(opts?.owner))
  loadPersisted(cwd, state)
  const last = state.sessionRecords.at(-1) ?? null
  if (!last) {
    return {
      state: 'unverified',
      detail:
        state.mutationSeq > 0
          ? `${state.mutationSeq} mutation(s) this session — no verification evidence yet`
          : 'no verification evidence for this tree yet',
      lastEvidence: null,
      mutationsSinceEvidence: state.mutationSeq,
      lastMutationAt: state.lastMutationAt,
    }
  }
  const mutationsSince = state.mutationSeq - last.seq
  if (!last.ok) {
    return {
      state: 'failed',
      detail: `${last.coverage} FAILED (${ageLabel(last.ranAt)})${mutationsSince > 0 ? ` · ${mutationsSince} mutation(s) since` : ''}`,
      lastEvidence: last,
      mutationsSinceEvidence: mutationsSince,
      lastMutationAt: state.lastMutationAt,
    }
  }
  if (mutationsSince > 0) {
    return {
      state: 'stale',
      detail: `${mutationsSince} mutation(s) after the last evidence (${last.coverage}, ${ageLabel(last.ranAt)})`,
      lastEvidence: last,
      mutationsSinceEvidence: mutationsSince,
      lastMutationAt: state.lastMutationAt,
    }
  }
  //  soak law (the field father_soak case): a declared minRuns:N
  // gate is satisfied only by N green runs on the CURRENT tree — one green
  // run reads as in-progress, never verified. Counted as the trailing
  // consecutive green rows for the same gateId at the current seq (a red in
  // between breaks the streak; the fold above already handled last-red).
  // 'stale' is the honest word in the fixed 4-word vocabulary: evidence
  // exists but does not yet cover what the gate demands.
  if (last.ok && last.gateId !== undefined && (last.minRuns ?? 1) > 1) {
    const need = last.minRuns ?? 1
    let got = 0
    for (let i = state.sessionRecords.length - 1; i >= 0; i--) {
      const r = state.sessionRecords[i]!
      if (r.gateId !== last.gateId) continue
      if (!r.ok || r.seq !== last.seq) break
      got++
    }
    if (got < need) {
      return {
        state: 'stale',
        detail: `soak ${got}/${need} — ${last.coverage} needs ${need} green runs on this tree`,
        lastEvidence: last,
        mutationsSinceEvidence: 0,
        lastMutationAt: state.lastMutationAt,
      }
    }
  }
  // No in-session mutations after the evidence — but the TREE is the truth
  // across restarts: evidence recorded for a different tree is stale.
  // skipDigest: render-path consumers (the frame chip) must never spawn git;
  // they keep session-only honesty and leave cross-restart staleness to
  // /health and the summary's full callers.
  if (!opts?.skipDigest && last.treeDigest !== null) {
    const current = computeWorkingTreeDigest(cwd)
    if (current !== null && current !== last.treeDigest) {
      return {
        state: 'stale',
        detail: `tree changed since the last evidence (${last.coverage}, ${ageLabel(last.ranAt)})`,
        lastEvidence: last,
        mutationsSinceEvidence: 0,
        lastMutationAt: state.lastMutationAt,
      }
    }
  }
  return {
    state: 'verified',
    detail: `${last.coverage} green (${ageLabel(last.ranAt)})`,
    lastEvidence: last,
    mutationsSinceEvidence: 0,
    lastMutationAt: state.lastMutationAt,
  }
}

function ageLabel(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}
