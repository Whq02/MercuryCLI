
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
  | 'lint'
  | 'check'
  | 'read-back'

export interface EvidenceRecord {
  command: string
  ok: boolean
  scope: VerificationScope
  coverage: string
  ranAt: number
  treeDigest: string | null
  seq: number
  gateId?: string
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

interface OwnerVerificationState {
  mutationSeq: number
  lastMutationAt: number | null
  sessionRecords: EvidenceRecord[]
  persistedLoaded: boolean
  pendingReadBack: Set<string>
  pendingUnknownMutation: boolean
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

function effectiveOwner(owner?: OwnerKey): OwnerKey {
  return owner ?? processMainOwner()
}

const subscribers = new Set<() => void>()

function notify(): void {
  for (const cb of subscribers) {
    try {
      cb()
    } catch {
    }
  }
}

export function subscribeVerification(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

export function _resetVerificationStateForTesting(): void {
  ownerStates.clearAllForShutdown()
  digestCache.clear()
}

export function disposeVerificationOwner(owner: OwnerKey): void {
  ownerStates.dispose(owner)
}

export function _verificationOwnerCountForTesting(): number {
  return ownerStates.size
}

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
    execFileSync(gitExe(), ['read-tree', 'HEAD'], { windowsHide: true, cwd, env, stdio: 'pipe', timeout: 30_000 })
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
    let raw: string
    try {
      raw = readFileSync(evidencePath(cwd), 'utf8')
    } catch {
      raw = readFileSync(workspaceEvidencePath(cwd), 'utf8')
    }
    const parsed = JSON.parse(raw) as { schema?: number; records?: EvidenceRecord[] }
    if (parsed.schema === EVIDENCE_SCHEMA && Array.isArray(parsed.records)) {
      state.sessionRecords = parsed.records.slice(-MAX_RECORDS).map(r => ({ ...r, seq: 0 }))
    }
  } catch {
  }
}

function persist(cwd: string, state: OwnerVerificationState): void {
  try {
    const payload = JSON.stringify({ schema: EVIDENCE_SCHEMA, records: state.sessionRecords.slice(-MAX_RECORDS) }, null, 2)
    durableAtomicPublishSync(evidencePath(cwd), payload)
    if (workspaceEvidenceOptIn()) {
      durableAtomicPublishSync(workspaceEvidencePath(cwd), payload)
    }
  } catch {
  }
}

const MUTATION_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

export function isMutationToolCall(toolName: string, _input: unknown): boolean {
  return MUTATION_TOOLS.has(toolName)
}

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
    digestReceipted?: boolean
  },
): void {
  const state = ownerStates.get(effectiveOwner(owner))
  state.mutationSeq++
  state.lastMutationAt = Date.now()
  if (changedPaths && changedPaths.length > 0) {
    if (!opts?.digestReceipted) {
      for (const p of changedPaths) state.pendingReadBack.add(canonicalEvidencePath(p))
    }
  } else {
    state.pendingUnknownMutation = true
  }
  state.evidenceDemands = 0
  if (cwd !== undefined) digestCache.delete(cwd)
  else digestCache.clear()
  if (cwd !== undefined) verifiableCache.delete(cwd)
  else verifiableCache.clear()
  notify()
}

export function verifyEvidenceEnabled(): boolean {
  return flagEnv('MERCURY_VERIFY_EVIDENCE') !== '0'
}

export function observeCompletedToolCall(
  toolName: string,
  input: unknown,
  ok: boolean,
  cwd: string,
  owner?: OwnerKey,
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
    if (ok && toolName === 'Read') {
      const inp = input as { file_path?: unknown; offset?: unknown; limit?: unknown } | undefined
      if (typeof inp?.file_path === 'string' && inp.offset === undefined && inp.limit === undefined) {
        noteReadBack(cwd, inp.file_path, owner)
      }
      return
    }
    if (toolName === 'Bash' || toolName === 'PowerShell') {
      if (lifecycle === 'launch') return
      const command = String((input as { command?: unknown } | undefined)?.command ?? '')
      const cls = classifyVerificationCommand(command, cwd)
      if (cls) recordEvidence(cwd, { command, ok, ...cls }, owner)
    }
  } catch {
  }
}


const verifiableCache = new Map<string, { verdict: boolean; at: number }>()
const VERIFIABLE_TTL_MS = 60_000
const VERIFIABLE_NEGATIVE_TTL_MS = 5_000

export function workspaceVerifiable(cwd: string, owner?: OwnerKey): boolean {
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
      }
    }
  } catch {
    verdict = false
  }
  verifiableCache.set(cwd, { verdict, at: Date.now() })
  return verdict
}

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

const EMPTY_PATH_SET: ReadonlySet<string> = new Set()

export function demandedReadBackPaths(cwd: string, owner?: OwnerKey): ReadonlySet<string> {
  const state = ownerStates.peek(effectiveOwner(owner))
  if (!state || state.pendingReadBack.size === 0) return EMPTY_PATH_SET
  if (workspaceVerifiable(cwd, owner)) return EMPTY_PATH_SET
  return new Set(state.pendingReadBack)
}

export function noteEvidenceDemandIssued(owner?: OwnerKey): void {
  const state = ownerStates.get(effectiveOwner(owner))
  state.evidenceDemands++
}

export function evidenceDemandCount(owner?: OwnerKey): number {
  return ownerStates.peek(effectiveOwner(owner))?.evidenceDemands ?? 0
}


export function stripQuotedShellArgs(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
}

export function leadingShellCommandToken(segment: string): string {
  const tok = segment.trim().split(/\s+/)[0] ?? ''
  return tok.replace(/^.*[\\/]/, '').toLowerCase()
}

export const NOOP_COMMAND_HEADS: ReadonlySet<string> = new Set([
  'echo', 'printf', 'true', 'false', ':', 'cat', 'ls', 'pwd', 'test', '[',
])

export type ShellChainOp = '&&' | 'pipe' | 'or' | 'break'
export interface ShellCommandSegment {
  text: string
  opBefore: ShellChainOp | 'start'
}

export function splitShellControlOps(command: string): ShellCommandSegment[] {
  const bare = stripQuotedShellArgs(command)
    .replace(/\d*>&\d*/g, '>')
    .replace(/&>>?/g, '>')
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

export function pipefailActiveBefore(
  segments: readonly ShellCommandSegment[],
  i: number,
): boolean {
  for (let j = 0; j < i; j++) {
    if (/\bset\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*o\s+pipefail\b/.test(segments[j]!.text)) return true
  }
  return false
}

export function projectVerifyPattern(): RegExp | null {
  const raw = flagEnv('MERCURY_VERIFY_PATTERN')
  if (!raw) return null
  try {
    return new RegExp(raw, 'i')
  } catch {
    return null
  }
}

function verbScope(verb: string): VerificationScope {
  const v = verb.toLowerCase()
  if (v === 'test') return 'test'
  if (v === 'typecheck') return 'typecheck'
  if (v === 'build') return 'build'
  if (v === 'lint') return 'lint'
  return 'check'
}

const GENERIC_VERBS = 'test|build|typecheck|lint|check|validate|verify|ci'

const NPM_VERB_RE = new RegExp(
  `\\b(npm|yarn|pnpm)\\s+(?:(?:--prefix|-w|--workspace|-C|--dir|--cwd|cwd|--filter|-F)(?:[=\\s]\\S+)?\\s+)?(?:workspace\\s+\\S+\\s+)?(?:run\\s+)?(${GENERIC_VERBS})(?::\\S+)?\\b`,
  'i',
)
const MAKE_VERB_RE = new RegExp(`\\bmake\\s+(${GENERIC_VERBS})\\b`, 'i')
const JUST_VERB_RE = new RegExp(`\\bjust\\s+(${GENERIC_VERBS})\\b`, 'i')

export interface VerifyClassification {
  scope: VerificationScope
  coverage: string
  gateId?: string
  minRuns?: number
}

export function classifyVerifySegment(
  segment: string,
  cwd?: string,
): VerifyClassification | null {
  const c = segment.trim()
  if (!c || NOOP_COMMAND_HEADS.has(leadingShellCommandToken(c))) return null
  if (cwd !== undefined) {
    const declared = matchDeclaredGate(c, cwd)
    if (declared) return declared
  }
  if (/run-all-suites\.sh/.test(c)) {
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
    return { scope: 'fast', coverage: 'verify:fast (slice rung)' }
  }
  if (/bun run verify\b/.test(c)) return { scope: 'full-gate', coverage: 'full gate (bun run verify)' }
  if (/bun run artifact:smoke\b/.test(c)) return { scope: 'artifact-smoke', coverage: 'isolated artifact smoke' }
  if (/bun run build\.ts|bun run build\b/.test(c)) return { scope: 'build', coverage: 'real artifact build' }
  if (/\bbun\s+(run\s+)?test\b|\bvitest\b(?! --version)/.test(c)) return { scope: 'test', coverage: 'test run' }
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
  const script = c.match(/^\s*(?:bash|sh)\s+(\S*(?:test|check|verify|gate|suite|ci|lint)\S*)/i)
    ?? c.match(/^\s*(\.\/\S*(?:test|check|verify|gate|suite|ci|lint)\S*)/i)
  if (script?.[1]) return { scope: 'check', coverage: `project script ${script[1]}` }
  const extra = projectVerifyPattern()
  if (extra?.test(c)) return { scope: 'check', coverage: 'project verify pattern (MERCURY_VERIFY_PATTERN)' }
  return null
}

export function isVerifySegment(segment: string, cwd?: string): boolean {
  return classifyVerifySegment(stripQuotedShellArgs(segment), cwd) !== null
}

const SAFE_TAIL_HEADS = new Set(['git', 'echo', 'printf', 'true', ':'])

function safeTailSegment(segment: string): boolean {
  if (/(^|\s)>>?\s/.test(segment) && !/>{1,2}\s*['"]?\/(?:dev|proc)\//.test(segment)) {
    return false
  }
  return SAFE_TAIL_HEADS.has(leadingShellCommandToken(segment))
}

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
      if (seg.opBefore === 'or') continue outer
      if (j < i && /^\s*cd\s+['"]?[/~]/.test(seg.text)) continue outer
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
    if (!classifyVerifySegment(segments[j]!.text) && !safeTailSegment(segments[j]!.text)) {
      return false
    }
  }
  return true
}

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
    }
  }
  notify()
}

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
  }
}

export function evidenceRecordsFor(owner?: OwnerKey): readonly EvidenceRecord[] {
  const state = ownerStates.peek(effectiveOwner(owner))
  return state ? [...state.sessionRecords] : []
}

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
