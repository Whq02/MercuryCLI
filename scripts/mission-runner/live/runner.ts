// ============================================================================
//  scripts/mission-runner/live/runner.ts — the built-artifact task runner.
//
//  Drives the CURRENT distributable from OUTSIDE the repository tree (the
//  benchmark precedent, generalized): seed → clone task state → launch
//  `node dist/mercury.mjs -p <brief> --model … --permission-mode flow
//  --output-format json` under the operator's subscription config home →
//  grade with the corpus grader → mine the session transcript → append ONE
//  raw JSONL outcome row. A crashed or timed-out run is a RESULT, never
//  silently retried.
//
//  Deterministic proof seam: HELIX_AGENT_CMD replaces the model launch with
//  a scripted command (bash -c), so runner/grader/aggregation contracts are
//  CI-provable with zero model calls. HELIX_TIME_CEILING_OVERRIDE
//  narrows ceilings for timeout proofs.
//
//  CLI:
//    bun runner.ts --task --policy solo --run 1 --out rows.jsonl
//    bun runner.ts --na --task --policy router --out rows.jsonl
// ============================================================================
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  evaluateMissionCompletion,
  parseReviewResult,
} from '../../../src/services/mission/completion.js'
import { sanitizePath } from '../../../src/utils/sessionStoragePortable.js'
import { CORPUS_SEED_ROOT, type HelixTask } from '../corpus/contracts.js'
import { taskById } from '../corpus/tasks.js'
import { gradeTask } from '../corpus/grade.js'
import { seedAll, type SeededRepo } from '../corpus/seed.js'
import { corpusDigest } from '../corpus/manifest.js'
import { policyApplicability, policyById, policyDigest, type HelixPolicy } from './policies.js'

const repoRoot = resolve(new URL('../../..', import.meta.url).pathname)

export type HelixRunStatus =
  | 'accepted'
  | 'rejected'
  | 'incomplete'
  | 'indeterminate'
  | 'not-applicable'
  // a DELIBERATE mid-run interruption (the benchmark's own
  // act, resumable in a fresh process) — distinct from 'incomplete', which
  // stays the ceiling timeout.
  | 'interrupted'

export interface HelixRunRow {
  ts: string
  taskId: string
  family: number
  partition: string
  policyId: string
  policyDigest: string
  corpusDigest: string
  mercurySha: string
  artifactTree: string
  model: string
  effortIntent: string
  status: HelixRunStatus
  accepted: boolean
  naReason?: string
  graderComponents?: { name: string; pass: boolean; detail: string }[]
  changedPaths?: string[]
  isError?: boolean
  timedOut?: boolean
  runIndex?: number
  numTurns?: number
  durationMs?: number
  durationApiMs?: number
  wallSeconds?: number
  inputTokens?: number
  outputTokens?: number
  cacheRead?: number
  models?: string[]
  sessionId?: string
  toolCalls?: Record<string, number>
  toolFailures?: number
  incorrectClaim?: boolean
  resultChars?: number
  resultText?: string
  /** H3 'selected' arm metadata. */
  selectedProfile?: string
  selectionSource?: string
  selectionReasons?: string[]
  executedAs?: string
  mappingNote?: string
  /** H4 independent completion evaluation. */
  reviewerVerdict?: string
  completionState?: string
  completionDecidedBy?: string
  reviewerDisagreesWithGrader?: boolean
  /** external-baseline arm metadata (additive; absent on Mercury rows). */
  adapterId?: string
  adapterVersion?: string
  /** mutation-honesty metrics (additive; transcript-mined where
   *  available — see mineTranscript). */
  mutationCalls?: number
  noChangeOutcomes?: number
  maxNoChangeStreak?: number
  callsToFirstCorrectMutation?: number
  mutationFailures?: number
  /**  interruption/resume linkage (additive). An interrupted
   *  row keeps its workdir and names it; the resumed row names the session
   *  it continued. */
  runPhase?: 'interrupted' | 'resumed'
  interruptedAfterSec?: number
  resumedFromSessionId?: string
  workdir?: string
  /**  §5.9 interactive lane (additive): the run mode and the
   *  TYPED operator-attention ledger — one entry per tape send;
   *  counts + kinds + offsets only, never captured frame content (§4.9). */
  runMode?: 'interactive-pty'
  attentionEvents?: { atMs: number; kind: string; chars: number }[]
  /** effort as independently observed in the
   *  external harness's own records (adapters' mineObserved). */
  effortObserved?: string
}

function gitOut(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function artifactTree(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'dist/manifest.json'), 'utf8'))
    return String(manifest.buildTree ?? 'unknown')
  } catch {
    return 'unknown'
  }
}

let seededCache: SeededRepo[] | null = null
export function seededRepos(root: string = CORPUS_SEED_ROOT): SeededRepo[] {
  if (!seededCache) seededCache = seedAll(root, repoRoot)
  return seededCache
}

export function materializeTask(task: HelixTask, root: string): { dir: string; baseSha: string } {
  const seeded = seededRepos(root).find(r => r.id === task.repo)
  if (!seeded) throw new Error('repo not seeded: ' + task.repo)
  const dir = mkdtempSync(join(tmpdir(), 'helix-run-' + task.id + '-'))
  execFileSync('git', ['clone', '-q', seeded.dir, join(dir, 'work')], { encoding: 'utf8' })
  const sha = task.ref.kind === 'sha' ? task.ref.value : seeded.refs[task.ref.value]
  if (!sha) throw new Error(task.id + ': unknown ref')
  execFileSync('git', ['-C', join(dir, 'work'), 'checkout', '-q', sha], { encoding: 'utf8' })
  return { dir, baseSha: sha }
}

/** the content-mutation tools whose outcomes the honesty
 *  metrics track (the per-tool + set-level no-change vocabulary). */
const MUTATION_TOOL_NAMES = new Set(['Edit', 'Write', 'ChangeSet', 'NotebookEdit'])

/** The truthful no-change result markers (Edit/Write · ChangeSet). */
const NO_CHANGE_RESULT_RE = /^No changes (made to|needed)/

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as { type?: string; kind?: string; text?: string }[])
      .filter(c => c?.type === 'text' || c?.kind === 'text')
      .map(c => String(c.text ?? ''))
      .join('\n')
  }
  return ''
}

/** Session transcript mining (the enrich-benchmark precedent, session-keyed).
 *  Exported for the deterministic scripts/repetition-guard mining prover.
 *
 *  Reads BOTH transcript formats: the legacy rows
 *  ({type:'assistant'|'user', message:{...}}) and transcript vNext
 *  ({schemaVersion:1, payload:{kind:'output'|'input', ...}} — the shape
 *  owner is src/fabric/record.ts). batch D caught the vNext gap
 *  live: the miner matched nothing and returned HARD ZEROS — the §4.7
 *  absence-is-not-zero law now holds: an unrecognizable transcript yields
 *  {} (absent metrics), never zero-valued ones. */
export function mineTranscript(configHome: string, sessionId: string): Partial<HelixRunRow> {
  const projectsDir = join(configHome, 'projects')
  let path: string | null = null
  try {
    for (const dir of readdirSync(projectsDir)) {
      const candidate = join(projectsDir, dir, sessionId + '.jsonl')
      if (existsSync(candidate)) {
        path = candidate
        break
      }
    }
  } catch {
    return {}
  }
  if (!path) return {}
  const models = new Set<string>()
  const toolCalls: Record<string, number> = {}
  let toolFailures = 0
  let turns = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  const seenMsgIds = new Set<string>()
  // mutation-honesty mining: correlate mutation tool_use → result.
  const mutationUseById = new Map<string, { name: string; inputJson: string }>()
  let mutationCalls = 0
  let noChangeOutcomes = 0
  let maxNoChangeStreak = 0
  let mutationFailures = 0
  let mutationResultsSeen = 0
  let callsToFirstCorrectMutation: number | undefined
  let streakKey: string | null = null
  let streak = 0
  let recognizedRecords = 0
  const resultsSeenByCallId = new Set<string>()
  // vNext streams SEVERAL records per provider message with monotonically
  // growing usage — the LAST record per id carries the truth (batch D's
  // second live catch: first-record-wins read a 10.8k-token turn as 41).
  const vnextUsageByMsg = new Map<string, Record<string, number> | undefined>()
  const seenToolCallIds = new Set<string>()

  // Shared tool-result classification (both formats feed it).
  const classifyResult = (use: { name: string; inputJson: string } | undefined, isError: boolean, bodyText: string): void => {
    if (isError) toolFailures += 1
    if (!use) return
    mutationResultsSeen += 1
    if (isError) mutationFailures += 1
    if (NO_CHANGE_RESULT_RE.test(bodyText)) {
      noChangeOutcomes += 1
      const key = `${use.name} ${use.inputJson}`
      streak = key === streakKey ? streak + 1 : 1
      streakKey = key
      if (streak > maxNoChangeStreak) maxNoChangeStreak = streak
    } else {
      streakKey = null
      streak = 0
      if (!isError && callsToFirstCorrectMutation === undefined) {
        callsToFirstCorrectMutation = mutationResultsSeen
      }
    }
  }

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    // ── transcript vNext (src/fabric/record.ts owns the shape) ─────────────
    if (row.schemaVersion === 1 && row.payload && typeof row.payload === 'object') {
      const payload = row.payload as {
        kind?: string
        model?: string
        providerMessageId?: string
        usage?: Record<string, number>
        content?: unknown
      }
      const blocks = Array.isArray(payload.content)
        ? (payload.content as { kind?: string; callId?: string; name?: string; input?: unknown; body?: unknown; isError?: boolean }[])
        : []
      if (payload.kind === 'output') {
        recognizedRecords += 1
        if (payload.model && payload.model !== '<synthetic>') models.add(payload.model)
        // Last record per message id wins (streamed growth); anonymous
        // records count as their own turns.
        const id = payload.providerMessageId
          ? String(payload.providerMessageId)
          : 'anon-' + String(recognizedRecords)
        vnextUsageByMsg.set(id, payload.usage)
        for (const block of blocks) {
          if (block?.kind === 'tool-use' && typeof block.name === 'string') {
            // Streamed echoes repeat the same call across records of one
            // message — a callId counts exactly once.
            const callId = String(block.callId ?? '')
            if (callId && seenToolCallIds.has(callId)) continue
            if (callId) seenToolCallIds.add(callId)
            toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1
            if (MUTATION_TOOL_NAMES.has(block.name)) {
              mutationCalls += 1
              if (callId) {
                mutationUseById.set(callId, {
                  name: block.name,
                  inputJson: JSON.stringify(block.input ?? null),
                })
              }
            }
          }
        }
      } else if (payload.kind === 'input') {
        recognizedRecords += 1
      }
      // Tool results ride input records (and echoes elsewhere): classify
      // each callId exactly once, first appearance wins.
      for (const block of blocks) {
        if (block?.kind !== 'tool-result') continue
        const callId = String(block.callId ?? '')
        if (callId && resultsSeenByCallId.has(callId)) continue
        if (callId) resultsSeenByCallId.add(callId)
        classifyResult(
          callId ? mutationUseById.get(callId) : undefined,
          block.isError === true,
          toolResultText(block.body),
        )
      }
      continue
    }

    // ── the legacy rows ─────────────────────────────────────────────────────
    const message = row.message as
      | { model?: string; id?: string; usage?: Record<string, number>; content?: unknown }
      | undefined
    if (row.type === 'assistant' && message) {
      recognizedRecords += 1
      if (message.model && message.model !== '<synthetic>') models.add(message.model)
      const id = String(message.id ?? '')
      if (!id || !seenMsgIds.has(id)) {
        if (id) seenMsgIds.add(id)
        turns += 1
        inputTokens += message.usage?.input_tokens ?? 0
        outputTokens += message.usage?.output_tokens ?? 0
        cacheRead += message.usage?.cache_read_input_tokens ?? 0
      }
      if (Array.isArray(message.content)) {
        for (const block of message.content as {
          type?: string
          name?: string
          id?: string
          input?: unknown
        }[]) {
          if (block.type === 'tool_use' && block.name) {
            toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1
            if (MUTATION_TOOL_NAMES.has(block.name)) {
              mutationCalls += 1
              if (block.id) {
                mutationUseById.set(block.id, {
                  name: block.name,
                  inputJson: JSON.stringify(block.input ?? null),
                })
              }
            }
          }
        }
      }
    }
    if (row.type === 'user' && message && Array.isArray(message.content)) {
      recognizedRecords += 1
      for (const block of message.content as {
        type?: string
        is_error?: boolean
        tool_use_id?: string
        content?: unknown
      }[]) {
        if (block.type !== 'tool_result') continue
        classifyResult(
          block.tool_use_id ? mutationUseById.get(block.tool_use_id) : undefined,
          block.is_error === true,
          toolResultText(block.content),
        )
      }
    }
  }
  // Fold the vNext per-message finals into the shared counters.
  for (const usage of vnextUsageByMsg.values()) {
    turns += 1
    inputTokens += usage?.inputTokens ?? 0
    outputTokens += usage?.outputTokens ?? 0
    cacheRead += usage?.cacheReadInputTokens ?? 0
  }
  // §4.7 absence is not zero: a transcript this miner cannot read yields
  // ABSENT metrics, never zero-valued ones.
  if (recognizedRecords === 0) return {}
  return {
    numTurns: turns,
    inputTokens,
    outputTokens,
    cacheRead,
    models: [...models].sort(),
    toolCalls,
    toolFailures,
    mutationCalls,
    noChangeOutcomes,
    maxNoChangeStreak,
    mutationFailures,
    ...(callsToFirstCorrectMutation !== undefined && {
      callsToFirstCorrectMutation,
    }),
  }
}

export const CLAIM_PATTERN = /\b(all tests pass|tests? (now )?pass|fixed|complete[d.!]|done[.!])\b/i

export interface RunOptions {
  root?: string
  configHome?: string
  outFile?: string
  runIndex?: number
  /** Proof seam: replaces the model launch. */
  agentCmd?: string
  keepWorkdir?: boolean
  /** Extra recorded fields (the 'selected' arm's decision metadata). */
  rowExtras?: Partial<HelixRunRow>
  /** kill the launch after N seconds as a DELIBERATE typed
   *  interruption (never a silent retry); forces keepWorkdir so the run can
   *  resume. A ceiling tighter than N still wins and types as 'incomplete'. */
  interruptAfterSec?: number
  /** continue an interrupted run in a FRESH process against
   *  its kept workdir (`--resume <sessionId>` on the real launch path). */
  resumeFrom?: { sessionId: string; workdir: string }
  /** the interactive PTY lane — drive the product (or
   *  the agentCmd fixture) inside a REAL pty via the driver, with a
   *  timed operator-input tape. Every send is a TYPED attention event by
   *  construction.
   *  §4.14 laws live in the tape discipline: generous first-send offsets
   *  (boot lag), a primer keystroke before load-bearing sends, and
   *  content-sequence assertions downstream — never fixed-instant frames. */
  interactive?: {
    tape: InteractiveSend[]
    cols?: number
    rows?: number
  }
}

export interface InteractiveSend {
  atMs: number
  /** ptydrive escape syntax (\x1b, \r, …). */
  text: string
  /** The typed attention vocabulary. */
  kind: 'primer' | 'brief' | 'nudge' | 'answer' | 'interrupt' | 'control'
}

/** The continuation prompt for resumed runs — deliberately terse: retained
 *  intent must come from the session, never a restated brief (family 22). */
export const RESUME_PROMPT = 'Continue the task exactly where it left off and finish it completely.'

/** The real launch argv (exported pure so provers pin the resume shape). */
export function launchArgs(policy: HelixPolicy, brief: string, resumeSessionId?: string): string[] {
  const args = [join(repoRoot, 'dist/mercury.mjs')]
  if (resumeSessionId) args.push('--resume', resumeSessionId)
  args.push('-p', brief, '--model', policy.model, '--permission-mode', 'flow', '--output-format', 'json')
  return args
}

/** Discover the newest session transcript a launch created under the config
 *  home for a given workdir (an interrupted run never prints its final JSON,
 *  so its session id must be FOUND, not parsed). */
export function findLatestSession(configHome: string, workdir: string, sinceMs: number): string | null {
  // The product's project dir is slugged from its REALPATH cwd (chdir
  // resolves the macOS /var → /private/var symlink), so the raw and the
  // resolved workdir BOTH name candidate slugs — the same class the reference
  // adapter's mineObserved fixed (a live catch). Raw-only slugging
  // made every interactive/interrupted row miss its session. Slugging
  // REUSES the product's own sanitizePath (every non-alphanumeric byte,
  // 200-clamp + hash) — a collector-local three-character rule diverges the
  // day a workdir carries a dot or underscore; a reaped
  // workdir that can never realpath gets the /private alias explicitly.
  const candidates = new Set<string>([workdir])
  try {
    candidates.add(realpathSync(workdir))
  } catch {
    if (/^\/(var|tmp|etc)\//.test(workdir)) candidates.add('/private' + workdir)
  }
  let best: { id: string; mtime: number } | null = null
  for (const candidate of candidates) {
    const dir = join(configHome, 'projects', sanitizePath(candidate))
    try {
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith('.jsonl')) continue
        const mtime = statSync(join(dir, entry)).mtimeMs
        if (mtime >= sinceMs && (!best || mtime > best.mtime)) {
          best = { id: entry.slice(0, -'.jsonl'.length), mtime }
        }
      }
    } catch {
      continue
    }
  }
  return best ? best.id : null
}

export function runTask(taskId: string, policyId: string, options: RunOptions = {}): HelixRunRow {
  return runTaskWithPolicy(taskId, policyById(policyId), options)
}

/** seam: run under a caller-supplied policy OBJECT (the comparison
 *  lab's Glassbird-owned arms — ablations, solo-minimal). Identity, grading,
 *  emission and cleanup stay THIS runner's; no second runner exists. */
export function runTaskWithPolicy(
  taskId: string,
  policy: HelixPolicy,
  options: RunOptions = {},
): HelixRunRow {
  const task = taskById(taskId)
  const extras = options.rowExtras ?? {}
  const base: HelixRunRow = {
    ts: new Date().toISOString(),
    taskId: task.id,
    family: task.family,
    partition: task.partition,
    policyId: policy.id,
    policyDigest: policyDigest(policy),
    corpusDigest: corpusDigest(),
    mercurySha: gitOut(['rev-parse', 'HEAD'], repoRoot),
    artifactTree: artifactTree(),
    model: policy.model,
    effortIntent: policy.effort,
    status: 'indeterminate',
    accepted: false,
    runIndex: options.runIndex ?? 1,
  }

  const applicability = policyApplicability(policy, task)
  if (!applicability.applicable) {
    const row = { ...base, status: 'not-applicable' as const, naReason: applicability.reason, ...extras }
    emit(row, options.outFile)
    return row
  }

  // resume: continue in the KEPT workdir of an interrupted run; the
  // base sha resolves from the seeded refs (no re-clone — the whole point
  // is fresh-process continuity over the same tree).
  const resuming = options.resumeFrom
  let scratch = ''
  let workdir: string
  let baseSha: string
  if (resuming) {
    workdir = resuming.workdir
    if (!existsSync(workdir)) throw new Error('resumeFrom workdir missing: ' + workdir)
    const seeded = seededRepos(options.root ?? CORPUS_SEED_ROOT).find(r => r.id === task.repo)
    const sha = task.ref.kind === 'sha' ? task.ref.value : seeded?.refs[task.ref.value]
    if (!sha) throw new Error(task.id + ': unknown ref')
    baseSha = sha
  } else {
    const materialized = materializeTask(task, options.root ?? CORPUS_SEED_ROOT)
    scratch = materialized.dir
    workdir = join(scratch, 'work')
    baseSha = materialized.baseSha
  }
  const configHome = options.configHome ?? process.env.MERCURY_CONFIG_DIR ?? join(homedir(), '.mercury')
  const brief = resuming
    ? RESUME_PROMPT
    : (policy.briefPrefix ?? '') + task.brief + (policy.briefSuffix ?? '')
  const ceilingSec = Number(process.env.HELIX_TIME_CEILING_OVERRIDE ?? task.timeCeilingSec)
  // A deliberate interruption arms a tighter kill; the ceiling still wins
  // when it is tighter (and keeps its own 'incomplete' type).
  const interruptSec = options.interruptAfterSec
  const interruptArmed = typeof interruptSec === 'number' && interruptSec > 0 && interruptSec < ceilingSec
  const effectiveTimeoutSec = interruptArmed ? interruptSec : ceilingSec

  const agentCmd = options.agentCmd ?? process.env.HELIX_AGENT_CMD
  const started = Date.now()
  let stdout = ''
  let timedOut = false
  let spawnErrored = false
  if (options.interactive) {
    // ── the §5.9 interactive PTY lane ───────────────────────────────────────
    const lane = options.interactive
    const chunksPath = join(scratch !== '' ? scratch : workdir, 'pty-chunks.jsonl')
    const tapePath = join(scratch !== '' ? scratch : workdir, 'pty-tape.json')
    writeFileSync(tapePath, JSON.stringify(lane.tape.map(s => ({ atMs: s.atMs, text: s.text }))), 'utf8')
    const child = agentCmd
      ? ['bash', '-c', agentCmd]
      : ['node', join(repoRoot, 'dist/mercury.mjs'), '--model', policy.model, '--permission-mode', 'flow']
    const result = spawnSync(
      'python3',
      [
        join(repoRoot, 'scripts/streaming/ptydrive.py'),
        '--cols',
        String(lane.cols ?? 120),
        '--rows',
        String(lane.rows ?? 40),
        '--seconds',
        String(effectiveTimeoutSec),
        '--send-file',
        tapePath,
        '--out',
        chunksPath,
        '--',
        ...child,
      ],
      {
        cwd: workdir,
        encoding: 'utf8',
        timeout: (effectiveTimeoutSec + 30) * 1000,
        maxBuffer: 64 * 1024 * 1024, // §4.14: NEVER the 1 MiB default
        env: {
          ...process.env,
          MERCURY_CONFIG_DIR: configHome,
          // BOTH effort wires: Mercury reads its registered spelling; the
          // agentCmd adapter arm is the external product reading its
          // own env contract.
          MERCURY_EFFORT_LEVEL: policy.effort,
          CLAUDE_CODE_EFFORT_LEVEL: policy.effort,
          MERCURY_EVOLUTION_LEDGER: '0',
          HELIX_TASK_ID: task.id,
          HELIX_POLICY_ID: policy.id,
          HELIX_WORKDIR: workdir,
          ...policy.env,
        },
      },
    )
    stdout = result.stdout ?? ''
    // The lane ends by tape design (a control send quits the product) or by
    // the ceiling; ptydrive's own cutoff at --seconds is the timeout signal.
    timedOut =
      result.signal === 'SIGTERM' ||
      result.signal === 'SIGKILL' ||
      (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ||
      (Date.now() - started) / 1000 >= effectiveTimeoutSec
    spawnErrored = !timedOut && result.status !== 0 && stdout.trim() === ''
  } else if (agentCmd) {
    const result = spawnSync('bash', ['-c', agentCmd], {
      cwd: workdir,
      encoding: 'utf8',
      timeout: effectiveTimeoutSec * 1000,
      maxBuffer: 64 * 1024 * 1024, // §4.14: NEVER the 1 MiB default
      env: { ...process.env, HELIX_TASK_ID: task.id, HELIX_POLICY_ID: policy.id, HELIX_WORKDIR: workdir },
    })
    stdout = result.stdout ?? ''
    timedOut =
      result.signal === 'SIGTERM' ||
      result.signal === 'SIGKILL' ||
      (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
    spawnErrored = !timedOut && result.status !== 0
  } else {
    const result = spawnSync(
      'node',
      launchArgs(policy, brief, resuming ? resuming.sessionId : undefined),
      {
        cwd: workdir,
        encoding: 'utf8',
        timeout: effectiveTimeoutSec * 1000,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          MERCURY_CONFIG_DIR: configHome,
          // BOTH effort wires: Mercury reads its registered spelling; the
          // agentCmd adapter arm is the external product reading its
          // own env contract.
          MERCURY_EFFORT_LEVEL: policy.effort,
          CLAUDE_CODE_EFFORT_LEVEL: policy.effort,
          MERCURY_EVOLUTION_LEDGER: '0',
          ...policy.env,
        },
      },
    )
    stdout = result.stdout ?? ''
    timedOut =
      result.signal === 'SIGTERM' ||
      result.signal === 'SIGKILL' ||
      (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
    spawnErrored = !timedOut && result.status !== 0 && stdout.trim() === ''
  }
  const wallSeconds = Math.round((Date.now() - started) / 1000)

  const lastLine = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(lastLine) as Record<string, unknown>
  } catch {
    parsed = {}
  }
  const resultText = typeof parsed.result === 'string' ? parsed.result : ''
  const isError = Boolean(parsed.is_error) || spawnErrored

  const verdict = gradeTask(task, workdir, resultText, Date.now, { baseSha })
  const interrupted = timedOut && interruptArmed
  const status: HelixRunStatus = interrupted
    ? 'interrupted'
    : timedOut
      ? 'incomplete'
      : verdict.accepted
        ? 'accepted'
        : isError
          ? 'indeterminate'
          : 'rejected'

  const usage = (parsed.usage ?? {}) as Record<string, number>
  // An interrupted run never prints its final JSON — its session id is
  // FOUND under the config home, not parsed.
  // Interrupted AND interactive runs never print a final JSON — their
  // session ids are FOUND under the config home.
  const sessionId =
    typeof parsed.session_id === 'string'
      ? parsed.session_id
      : (interrupted || options.interactive) && !agentCmd
        ? (findLatestSession(configHome, workdir, started) ?? undefined)
        : undefined
  const mined = sessionId ? mineTranscript(configHome, sessionId) : {}

  // H4 §9: the independent completion evaluation — the mechanical grader
  // FIRST; the reviewer's typed tail (reviewer-armed policies) can never
  // override it; disagreements are recorded for the closure report.
  const reviewer = policy.reviewerArmed ? parseReviewResult(resultText) : null
  const completion = evaluateMissionCompletion({
    grader: verdict.accepted ? 'pass' : 'fail',
    undeclaredEffectDivergence: 0,
    semanticRequired: false,
    reviewer,
    implementerClaimedSuccess: CLAIM_PATTERN.test(resultText),
  })
  const row: HelixRunRow = {
    ...base,
    status,
    accepted: verdict.accepted,
    graderComponents: verdict.components,
    changedPaths: verdict.changedPaths,
    isError,
    timedOut,
    numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : undefined,
    durationMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : undefined,
    durationApiMs: typeof parsed.duration_api_ms === 'number' ? parsed.duration_api_ms : undefined,
    wallSeconds,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    sessionId,
    ...mined,
    incorrectClaim: !isError && !timedOut && !verdict.accepted && CLAIM_PATTERN.test(resultText),
    resultChars: resultText.length,
    resultText: resultText.slice(0, 4000),
    ...(interrupted || options.keepWorkdir ? { workdir } : {}),
    ...(interrupted
      ? { runPhase: 'interrupted' as const, interruptedAfterSec: interruptSec }
      : {}),
    ...(resuming
      ? { runPhase: 'resumed' as const, resumedFromSessionId: resuming.sessionId }
      : {}),
    ...(options.interactive
      ? {
          runMode: 'interactive-pty' as const,
          attentionEvents: options.interactive.tape.map(s => ({
            atMs: s.atMs,
            kind: s.kind,
            chars: s.text.length,
          })),
        }
      : {}),
    ...(reviewer
      ? {
          reviewerVerdict: reviewer.verdict,
          completionState: completion.state,
          completionDecidedBy: completion.decidedBy,
          reviewerDisagreesWithGrader:
            (reviewer.verdict === 'accept') !== verdict.accepted,
        }
      : {}),
    ...extras,
  }
  emit(row, options.outFile)
  // An interrupted run's workdir is its continuity — never reaped; a
  // resumed run owns no scratch of its own (it ran in the kept one).
  if (!options.keepWorkdir && !interrupted && scratch !== '') {
    rmSync(scratch, { recursive: true, force: true })
  }
  return row
}

function emit(row: HelixRunRow, outFile?: string): void {
  const line = JSON.stringify(row)
  if (outFile) {
    mkdirSync(resolve(outFile, '..'), { recursive: true })
    appendFileSync(outFile, line + '\n', 'utf8')
  }
  console.log(line)
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const args = process.argv.slice(2)
  const get = (flag: string): string | undefined => {
    const at = args.indexOf(flag)
    return at >= 0 ? args[at + 1] : undefined
  }
  const taskId = get('--task')
  const policyId = get('--policy')
  if (!taskId || !policyId) {
    console.error('usage: runner.ts --task <id> --policy <id|selected> [--run N] [--out FILE]')
    process.exit(2)
  }
  const baseOptions = {
    outFile: get('--out'),
    runIndex: Number(get('--run') ?? 1),
    root: get('--root'),
    configHome: get('--config-home'),
  }
  let row: HelixRunRow
  if (policyId === 'selected') {
    // The H3 measured-selector arm: the family fingerprint drives the SAME
    // pure selector the product consults; the decision + mapping are
    // RECORDED on the row; the VERIFIED outcome mints a mission history row.
    const { resolveSelectedArm } = await import('./selectedPolicy.js')
    const { taskFingerprint } = await import('./selectedPolicy.js')
    const resolution = await resolveSelectedArm(taskById(taskId))
    row = runTask(taskId, resolution.executedAs, {
      ...baseOptions,
      rowExtras: {
        policyId: 'selected',
        policyDigest: resolution.decision.profileDigest,
        selectedProfile: resolution.decision.profile.id,
        selectionSource: resolution.decision.source,
        selectionReasons: resolution.decision.reasonCodes,
        executedAs: resolution.executedAs,
        ...(resolution.mappingNote ? { mappingNote: resolution.mappingNote } : {}),
      },
    })
    if (row.status === 'accepted' || row.status === 'rejected') {
      const { recordMissionOutcome } = await import('../../../src/substrate/routerOutcomeStore.js')
      const fp = taskFingerprint(taskById(taskId))
      await recordMissionOutcome({
        profileId: resolution.decision.profile.id,
        taskShape: fp.shape,
        ambiguity: fp.ambiguityBand,
        coupling: fp.couplingBand,
        accepted: row.status === 'accepted',
        epoch: resolution.decision.epoch,
        modelClass: resolution.executedAs === 'specialist-sol' ? 'gpt' : 'opus',
      })
    }
  } else {
    row = runTask(taskId, policyId, baseOptions)
  }
  process.exit(row.status === 'accepted' || row.status === 'not-applicable' ? 0 : 1)
}
