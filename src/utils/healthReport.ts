
import { isReadOnlyDiagnostic } from './diagnosticReadOnly.js'
import { projectHomeLeftovers, projectHomeStore } from './projectHomeStores.js'
import { MERCURY_PROJECT_DIR } from './projectConfig.js'
import { homeDirectory, isHomeDirectory, projectScopePathspec, USER_ROOT_NAMES } from './projectBoundary.js'
import { findGitRoot, type GitRepoState } from './git.js'
import { settleChildRun } from './childSettle.js'
import { gitArgs, gitArgsAsync } from './git/spawnArgs.js'
import { endProcessTree, strikeProcessGroupNow } from './processGroup.js'
import { subprocessEnv } from './subprocessEnv.js'
import { projectLocalPath } from '../services/projectLocal/paths.js'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { nodeRuntimeProjection } from './runtime/nodePolicy.js'
import { readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve as resolvePath, sep } from 'node:path'
import { GLYPH } from '../components/mercury-ui/glyphs.js'
import { pidAlive } from './pidAlive.js'
import { publishAtomic } from '../substrate/fileStore.js'
import { flagEnabled, flagEnv } from '../substrate/flagRegistry.js'
import { getCwd } from './cwd.js'
import {
  carryDeepReadings,
  decodeLastCertSummary,
  flattenChecks,
  formatAge,
  summarizeCert,
  verdictFromStatuses,
  type CertHead,
  type HealthCertificate,
  type HealthCheck,
  type HealthSection,
  type HealthStatus,
  type LastCertSummary,
} from './healthCertCore.js'
import { getUserSpecifiedModelSetting } from './model/model.js'
import { computedDefault } from './model/computedDefault.js'
import { gitSnapshot } from './cockpit/gitSnapshot.js'
import { healthFixEnabled } from './healthFix.js'

const treeScratchDirs = new Set<string>()
const treeScratchGits = new Set<ChildProcess>()
let treeScratchSweepArmed = false
const TREE_SCRATCH_RELEASE_MS = 10_000
const TREE_SCRATCH_RETRY_MS = 50

function removeTreeScratch(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true })
    treeScratchDirs.delete(dir)
    return true
  } catch {
    return false
  }
}

function sweepTreeScratch(): void {
  const windows = process.platform === 'win32'
  for (const child of treeScratchGits) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) continue
    if (windows) void endProcessTree(child, 'SIGKILL')
    else strikeProcessGroupNow(child)
  }
  const giveUpAt = Date.now() + TREE_SCRATCH_RELEASE_MS
  for (const dir of [...treeScratchDirs]) {
    while (!removeTreeScratch(dir) && Date.now() < giveUpAt) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TREE_SCRATCH_RETRY_MS)
    }
  }
  treeScratchDirs.clear()
}

export async function computeWorkingTreeSha(cwdDir: string, opts?: { signal?: AbortSignal }): Promise<string | null> {
  const { mkdirSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const idxDir = mkdtempSync(join(tmpdir(), 'gate-tree-'))
  treeScratchDirs.add(idxDir)
  if (!treeScratchSweepArmed) {
    treeScratchSweepArmed = true
    process.once('exit', sweepTreeScratch)
  }
  const signal = opts?.signal
  const idx = join(idxDir, 'index')
  const objects = join(idxDir, 'objects')
  mkdirSync(objects, { recursive: true })
  const repoObjects = await new Promise<string | null>(resolve => {
    execFile(
      'git',
      gitArgs(['rev-parse', '--git-path', 'objects'], cwdDir),
      { windowsHide: true, cwd: cwdDir, env: { ...subprocessEnv() }, timeout: 15_000, ...(signal ? { signal } : {}) },
      (err, stdout) => resolve(err ? null : stdout.trim()),
    )
  })
  const env = {
    ...subprocessEnv(),
    GIT_INDEX_FILE: idx,
    ...(repoObjects
      ? { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: resolvePath(cwdDir, repoObjects) }
      : {}),
  }
  const run = async (args: string[]): Promise<string | null> => {
    const argv = await gitArgsAsync(args, cwdDir)
    return new Promise(resolvePromise => {
      const windows = process.platform === 'win32'
      const child = execFile(
        'git',
        argv,
        { windowsHide: true, cwd: cwdDir, env, ...(windows ? {} : { detached: true, timeout: 15_000, ...(signal ? { signal } : {}) }) },
        (err, stdout) => {
          treeScratchGits.delete(child)
          resolvePromise(err ? null : stdout.trim())
        },
      )
      treeScratchGits.add(child)
      if (windows) void settleChildRun(child, { timeoutMs: 15_000, ...(signal ? { signal } : {}) })
    })
  }
  try {
    if (signal?.aborted) return null
    if ((await run(['read-tree', 'HEAD'])) === null) return null
    if ((await run(['add', '-A', ...projectScopePathspec(cwdDir)])) === null) return null
    const tree = await run(['write-tree', '--missing-ok'])
    return tree && tree.length > 0 ? tree : null
  } catch {
    return null
  } finally {
    if (!removeTreeScratch(idxDir) && process.platform === 'win32') {
      const giveUpAt = Date.now() + TREE_SCRATCH_RELEASE_MS
      while (treeScratchDirs.has(idxDir) && Date.now() < giveUpAt) {
        await new Promise<void>(resume => setTimeout(resume, TREE_SCRATCH_RETRY_MS))
        removeTreeScratch(idxDir)
      }
    }
  }
}

function gitLogSubjects(dir: string, limit: number): Promise<string[] | null> {
  return new Promise(resolve => {
    execFile(
      'git',
      gitArgs(['-C', dir, 'log', `--max-count=${limit}`, '--format=%s'], dir),
      { windowsHide: true, env: { ...subprocessEnv() }, timeout: 10_000 },
      (err, stdout) => resolve(err ? null : stdout.split('\n').filter(line => line !== '')),
    )
  })
}

export function homeRepositoryRemovalWords(dir: string, platform: NodeJS.Platform = process.platform): { inspect: string; remove: string } {
  const inside = isHomeDirectory(dir) ? [] : [basename(dir)]
  if (platform === 'win32') {
    const segments = ['$env:USERPROFILE', ...inside.map(s => `'${s}'`)]
    const folder = inside.length === 0 ? '$env:USERPROFILE' : `([IO.Path]::Combine(${segments.join(', ')}))`
    return {
      inspect: `git -C ${folder} log --oneline`,
      remove: `Remove-Item -Recurse -Force ([IO.Path]::Combine(${[...segments, "'.git'"].join(', ')}))`,
    }
  }
  const folder = inside.length === 0 ? '"$HOME"' : `"$HOME/${inside.join('/')}"`
  return { inspect: `git -C ${folder} log --oneline`, remove: `rm -rf ${folder.slice(0, -1)}/.git"` }
}

const QUIT_FIRST_WORDS = 'quit every Mercury window and its background process (sign out and back in on Windows if unsure)'

async function mercuryHoldersOf(repo: string): Promise<{ runners: string[]; indexLockAgeS: number | null; objectsInFlight: number }> {
  const runners: string[] = []
  try {
    const { readSessionWorkers } = await import('../daemon/concourseWorkers.js')
    for (const rec of Object.values(readSessionWorkers())) {
      if (rec.endedAt !== undefined || rec.pid === undefined || !pidAlive(rec.pid)) continue
      let ws: string
      try {
        ws = realpathSync(rec.workspaceId)
      } catch {
        continue
      }
      if (ws !== repo && !ws.startsWith(repo + sep)) continue
      if (findGitRoot(ws) !== repo) continue
      const warm = (rec as { warm?: boolean }).warm === true
      runners.push(`${rec.runnerId}${warm ? ' (warm)' : ''} pid ${rec.pid}`)
    }
  } catch {
  }
  let indexLockAgeS: number | null = null
  try {
    indexLockAgeS = Math.max(0, Math.round((Date.now() - statSync(join(repo, '.git', 'index.lock')).mtimeMs) / 1000))
  } catch {
    indexLockAgeS = null
  }
  let objectsInFlight = 0
  try {
    objectsInFlight = readdirSync(join(repo, '.git', 'objects')).filter(n => /^tmp_obj_|^tmpobj/i.test(n)).length
  } catch {
    objectsInFlight = 0
  }
  return { runners, indexLockAgeS, objectsInFlight }
}

function holdersWords(h: { runners: string[]; indexLockAgeS: number | null; objectsInFlight: number }): string {
  const parts: string[] = []
  if (h.runners.length > 0) parts.push(`${h.runners.length} live session${h.runners.length === 1 ? '' : 's'} rooted here (${h.runners.join(', ')})`)
  if (h.indexLockAgeS !== null) parts.push(`a git writer holds .git/index.lock (${h.indexLockAgeS} s old)`)
  if (h.objectsInFlight > 0) parts.push(`${h.objectsInFlight} object${h.objectsInFlight === 1 ? '' : 's'} being written under .git/objects`)
  return parts.length === 0 ? 'no Mercury process holds it now' : `held by Mercury now: ${parts.join(' · ')}`
}

export async function projectEstateCheck(): Promise<CheckResult> {
  const root = healthStateRoot()
  const leftovers = projectHomeLeftovers(root)
  if (leftovers.length === 0) {
    return { status: 'ok', evidence: `${MERCURY_PROJECT_DIR} holds shared configuration only — every machine-local store lives under the config home`, probe: 'functional' }
  }
  let tracked: string[] = []
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { stdout } = await promisify(execFile)('git', ['ls-files', '-z', '--', ...leftovers], { cwd: root, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 })
    const files = stdout.split('\0').filter(f => f !== '')
    tracked = leftovers.filter(dir => files.some(f => f === dir || f.startsWith(`${dir}/`)))
  } catch {
    tracked = []
  }
  const named = leftovers.map(dir => `${dir}${tracked.includes(dir) ? ' (tracked by git)' : ''}`).join(' · ')
  return {
    status: 'warn',
    evidence: `machine-local stores still standing in the project folder: ${named}`,
    detail:
      'each was read once and migrated to the config home on its first touch; the project folder keeps its copy (Mercury never deletes it, and never writes an ignore rule)',
    fix:
      tracked.length > 0
        ? `to stop committing them: git rm -r --cached ${tracked.map(dir => JSON.stringify(dir)).join(' ')} — then delete the folder copies when you are done with them`
        : 'delete the folder copies when you are done with them (they are not tracked by git)',
    probe: 'functional',
  }
}

export async function homeRepositoryCheck(): Promise<CheckResult> {
  const home = homeDirectory()
  const candidates: string[] = [home]
  let names: string[] = []
  try {
    names = readdirSync(home)
  } catch {
    names = []
  }
  for (const name of names) {
    const lower = name.toLowerCase()
    if (USER_ROOT_NAMES.some(n => n.toLowerCase() === lower) || lower.startsWith('onedrive')) candidates.push(join(home, name))
  }
  const repositories = candidates.filter(dir => {
    try {
      return statSync(join(dir, '.git')).isDirectory()
    } catch {
      return false
    }
  })
  if (repositories.length === 0) {
    return { status: 'ok', evidence: `no git repository at ${home} or its user folders`, probe: 'functional' }
  }
  const { FORK_BASE_COMMIT_SUBJECT } = await import('../daemon/concourseWorktrees.js')
  const facts = await Promise.all(
    repositories.map(async dir => {
      let created = 'creation date unknown'
      try {
        const st = statSync(join(dir, '.git'))
        const at = st.birthtimeMs > 0 ? st.birthtime : st.ctime
        created = `.git created ${at.toISOString().slice(0, 10)}`
      } catch {
      }
      const subjects = await gitLogSubjects(dir, 20)
      const madeByMercury = subjects !== null && subjects.length === 1 && subjects[0] === FORK_BASE_COMMIT_SUBJECT
      const startedByMercury = subjects !== null && subjects.includes(FORK_BASE_COMMIT_SUBJECT)
      const who =
        subjects === null
          ? 'history unreadable'
          : madeByMercury
            ? 'made by Mercury (its base commit is the only commit)'
            : startedByMercury
              ? `started by Mercury, ${subjects.length - 1}${subjects.length >= 20 ? '+' : ''} commits since`
              : `not Mercury's (${subjects.length}${subjects.length >= 20 ? '+' : ''} commits, none is Mercury's base commit)`
      const words = homeRepositoryRemovalWords(dir)
      const holders = holdersWords(await mercuryHoldersOf(dir))
      const fix = madeByMercury
        ? `${QUIT_FIRST_WORDS}, then run ${words.inspect} (only Mercury's base commit should appear), then remove the repository: ${words.remove}`
        : `Mercury keys every project beneath it as one: memory and project settings mix, and a forked worktree is a worktree of the home — keep it if it is yours; to remove it: ${QUIT_FIRST_WORDS}, check ${words.inspect}, then: ${words.remove}`
      return { evidence: `${dir} is a git repository (${created}; ${who}; ${holders})`, fix }
    }),
  )
  return {
    status: 'fail',
    evidence: facts.map(f => f.evidence).join(' · '),
    detail:
      'every folder beneath it without its own .git resolves to this repository, so repository-wide probes walk the whole profile; Mercury bounds its own probes to the launch folder and removes nothing here — remove it only with Mercury quit, or the deletion races the objects a live writer is still writing',
    fix: facts.map(f => f.fix).join(' · '),
    probe: 'functional',
  }
}

export function runRemedyCmd(
  cmd: string,
  args: string[],
  cwdDir: string,
  timeoutMs: number,
): Promise<{ status: number | null; tail: string }> {
  return new Promise(resolve => {
    let tail = ''
    const push = (chunk: unknown): void => {
      tail = (tail + String(chunk)).slice(-400)
    }
    try {
      const child = spawn(cmd, args, { windowsHide: true, cwd: cwdDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...subprocessEnv() } })
      child.stdout?.on('data', push)
      child.stderr?.on('data', push)
      void settleChildRun(child, { timeoutMs }).then(settlement => {
        if (settlement.spawnError !== undefined) {
          resolve({ status: null, tail: `spawn error: ${settlement.spawnError}` })
          return
        }
        if (settlement.timedOut) {
          resolve({ status: null, tail: `${tail}\n(the remedy timed out after ${Math.round(timeoutMs / 1000)}s — its process tree was ended)`.slice(-400) })
          return
        }
        resolve({ status: settlement.code, tail })
      })
    } catch (e) {
      resolve({ status: null, tail: `spawn threw: ${e instanceof Error ? e.message : String(e)}` })
    }
  })
}

export type {
  CertVerdict,
  HealthCertificate,
  HealthCheck,
  HealthSection,
  HealthStatus,
} from './healthCertCore.js'
export { countByStatus, flattenChecks, nextActions } from './healthCertCore.js'

export const HEALTH_STATUS_META: Record<
  HealthStatus,
  { glyph: string; tone: 'ok' | 'warn' | 'fail' | 'stale' | 'unknown' | 'neutral' }
> = {
  ok: { glyph: GLYPH.check, tone: 'ok' },
  warn: { glyph: GLYPH.warn, tone: 'warn' },
  fail: { glyph: GLYPH.fail, tone: 'fail' },
  stale: { glyph: GLYPH.drifting, tone: 'stale' },
  unknown: { glyph: GLYPH.read, tone: 'unknown' },
  off: { glyph: GLYPH.idle, tone: 'neutral' },
  info: { glyph: GLYPH.idle, tone: 'neutral' },
}

export function healthCertEnabled(): boolean {
  return flagEnabled('MERCURY_HEALTH_CERT')
}

export function healthStateRoot(): string {
  return flagEnv('MERCURY_HEALTH_STATE_DIR') || getProjectRootSafe()
}

function getProjectRootSafe(): string {
  try {
    const { getProjectRoot } = require('../bootstrap/state.js') as typeof import('../bootstrap/state.js')
    const root = getProjectRoot()
    return typeof root === 'string' && root.length > 0 ? root : getCwd()
  } catch {
    return getCwd()
  }
}

export function lastCertPath(): string {
  return join(projectHomeStore(healthStateRoot(), 'health'), 'last-cert.json')
}

export function gateVerdictPath(): string {
  return join(projectLocalPath(healthStateRoot(), 'gate'), 'verdict.json')
}


type CheckResult = Omit<HealthCheck, 'id' | 'label'>
type CheckFn = (probeCtx?: { signal?: AbortSignal }) => Promise<CheckResult> | CheckResult

export interface CheckSpec {
  id: string
  label: string
  run: CheckFn
  depth?: 'fast' | 'deep'
  probe?: 'functional' | 'configuration'
  timeoutMs?: number
  dependsOn?: string[]
}

interface SectionSpec {
  id: string
  title: string
  checks: Array<CheckSpec>
}

export interface RunHealthReportOptions {
  depth?: 'fast' | 'deep'
  signal?: AbortSignal
  onProgress?: (event: {
    check: HealthCheck
    sectionId: string
    sectionTitle: string
    done: number
    total: number
  }) => void
}

const HEALTH_CONCURRENCY = 4

export function flagAsSet(env: string): string {
  return `${env}=${flagEnv(env)?.trim() || '0'}`
}

export const SHELL_READS = {
  outputLimits: () => import('./shell/outputLimits.js'),
  engineSession: () => import('./shell/engineSession.js'),
  engineArm: () => import('./shell/shellEngineArm.js'),
  windowsRoad: () => import('./shell/windowsShellRoad.js'),
}


export function unresolvedDefaultRow(): string | null {
  try {
    if (getUserSpecifiedModelSetting() !== null) return null
    const decision = computedDefault()
    return decision.source === 'keyless' && decision.considered.length > 0 ? decision.row : null
  } catch {
    return null
  }
}

async function tensorFoldHealthChecks(): Promise<CheckSpec[]> {
  let rows: import('../services/providers/local/tensorfoldHealth.js').TensorFoldHealthChecks
  let labels: typeof import('../services/providers/local/tensorfoldHealth.js')
  try {
    labels = await import('../services/providers/local/tensorfoldHealth.js')
    rows = await labels.readTensorFoldHealth()
  } catch {
    return []
  }
  const specs: CheckSpec[] = []
  const { tensorfold, support, helper } = rows
  if (tensorfold !== undefined) specs.push({ id: 'tensorfold', label: labels.TENSORFOLD_HEALTH_LABEL, run: () => tensorfold })
  if (support !== undefined) specs.push({ id: 'tensorfold-support', label: labels.TENSORFOLD_SUPPORT_LABEL, run: () => ({ status: 'info' as const, evidence: support }) })
  if (helper !== undefined) specs.push({ id: 'helper-model', label: labels.HELPER_HEALTH_LABEL, run: () => helper })
  return specs
}

export function ocrReadinessCheck(reads?: Parameters<typeof import('./ocr.js').resolveOcrEngine>[0]): CheckSpec {
  return {
    id: 'iface-ocr',
    label: 'OCR',
    depth: 'fast',
    probe: 'configuration',
    timeoutMs: 11_000,
    run: async () => {
      const { resolveOcrEngine } = await import('./ocr.js')
      const engine = await resolveOcrEngine(reads)
      return engine.kind === 'unavailable'
        ? { status: 'info', evidence: `unavailable — ${engine.message}`, fix: engine.message }
        : { status: 'ok', evidence: engine.name, detail: `Languages: ${engine.languages.join(', ')}` }
    },
  }
}

export function browserReadinessCheck(reads?: import('../services/browser/browserResolver.js').BrowserResolverReads): CheckSpec {
  return {
    id: 'iface-browser',
    label: 'Browser',
    depth: 'fast',
    probe: 'configuration',
    run: async () => {
      const { describeBrowserReadiness } = await import('../services/browser/browserResolver.js')
      const facts = describeBrowserReadiness(reads)
      return { status: facts.ready ? 'ok' : 'info', evidence: facts.line, detail: facts.detail, ...(facts.fix !== undefined ? { fix: facts.fix } : {}) }
    },
  }
}

export function clientContractCheck(): CheckSpec {
  return {
    id: 'client-contract',
    label: 'Client contract',
    run: async () => {
      const { describeAnthropicClientContract } = await import('../constants/oauth.js')
      const { clientContractRecordWords } = await import('../services/api/clientContractLearned.js')
      const contract = describeAnthropicClientContract()
      const source =
        contract.source === 'override'
          ? 'MERCURY_ANTHROPIC_CLIENT_CONTRACT override'
          : contract.source === 'learned'
            ? `learned ${contract.asOf} from the registry`
            : 'constant · MERCURY_ANTHROPIC_CLIENT_CONTRACT=<version> overrides'
      const record = await clientContractRecordWords(contract, formatAge)
      if (contract.ignoredOverride !== undefined) {
        return {
          status: 'warn',
          evidence: `subscription door presents cc_version ${contract.presented} · ${source}${record} — MERCURY_ANTHROPIC_CLIENT_CONTRACT=${contract.ignoredOverride} ignored: not a three-part version`,
          fix: 'set MERCURY_ANTHROPIC_CLIENT_CONTRACT to a three-part version such as 2.1.280, or unset it',
        }
      }
      return {
        status: 'ok',
        evidence: `subscription door presents cc_version ${contract.presented} · ${source}${record}`,
      }
    },
  }
}

export function modelRefusalsCheck(): CheckSpec {
  return {
    id: 'model-refusals',
    label: 'Refused models',
    run: () => {
      const { standingModelRefusals, modelRefusalFix, modelRefusalHealthStatus, forgetModelRefusals } =
        require('../services/providers/anthropic/modelRefusal.js') as typeof import('../services/providers/anthropic/modelRefusal.js')
      const { renderModelName } = require('./model/model.js') as typeof import('./model/model.js')
      const refusals = standingModelRefusals()
      if (refusals.length === 0) return { status: 'info', evidence: 'no model refused on any door in this session' }
      const now = Date.now()
      const kinds = { 'contract-floor': 'minimum client version', tier: 'subscription tier', 'not-served': 'not served' }
      const status = refusals.some(refusal => modelRefusalHealthStatus(refusal, now) === 'warn') ? 'warn' : 'info'
      return {
        status,
        evidence: refusals.map(refusal => `${renderModelName(refusal.id)} · ${refusal.door} · ${kinds[refusal.kind]} · seen ${formatAge(now - refusal.seenAtMs)}`).join('\n'),
        detail: `${refusals.map(refusal => refusal.words).join('\n')}${status === 'info' ? '\nRefused model ids older than an hour are kept for reference only.' : ''}`,
        fix: [...new Set(refusals.map(refusal => `${modelRefusalFix(refusal)}.`))].join('\n'),
        ...(status === 'warn' && healthFixEnabled()
          ? {
              remedy: {
                plan: `forget the ${refusals.length} recorded model refusal${refusals.length === 1 ? '' : 's'} (derived evidence under the credential home; a refusal that recurs is recorded again)`,
                class: 'safe' as const,
                apply: async () => {
                  const removed = forgetModelRefusals()
                  return { ok: true, note: `${removed} record${removed === 1 ? '' : 's'} removed` }
                },
                verify: async () => {
                  const left = standingModelRefusals().length
                  return left === 0 ? { ok: true, note: 'no model refusal stands' } : { ok: false, note: `${left} refusal record(s) still stand` }
                },
              },
            }
          : {}),
      }
    },
  }
}

export async function skillsRefusedEvidence(cwd: string): Promise<{ status: 'ok' | 'warn'; evidence: string; fix?: string }> {
  const skills = require('../skills/loadSkillsDir.js') as typeof import('../skills/loadSkillsDir.js')
  await skills.getSkillDirCommands(cwd).catch(() => [])
  const refusals = skills.getSkillLoadRefusals()
  if (refusals.length === 0) return { status: 'ok', evidence: 'every skill file on disk loaded' }
  const rows = refusals.map(refusal => `${relativeToCwd(cwd, refusal.path)} (${refusal.source}): ${refusal.error}`)
  return {
    status: 'warn',
    evidence: `${refusals.length} skill file${refusals.length === 1 ? '' : 's'} refused — ${rows.join(' · ')}`,
    fix: 'Fix the named frontmatter (YAML between the --- fences) and save; the catalogue reloads on the change.',
  }
}

export function relativeToCwd(cwd: string, filePath: string): string {
  return filePath.startsWith(cwd) ? filePath.slice(cwd.length).replace(/^[\\/]/, '') : filePath
}

export interface HealthContext {
  cwd: string
  version: string
  git: Awaited<ReturnType<typeof gitSnapshot>>
  repo: GitRepoState | null
  head: CertHead
  tensorFoldChecks: CheckSpec[]
  probes: typeof import('./healthDeepProbes.js') | null
}

export async function healthContext(depth: 'fast' | 'deep' = 'fast'): Promise<HealthContext> {
  const cwd = getCwd()

  const git = await gitSnapshot({ fresh: true })
  const repo = git.state === 'live' ? git.data.git : null
  const head: CertHead = repo
    ? { sha: repo.commitHash, branch: repo.branchName, dirty: !repo.isClean }
    : { sha: null, branch: null, dirty: null }

  const version =
    typeof MACRO !== 'undefined' && typeof MACRO.VERSION === 'string' ? MACRO.VERSION : 'dev'
  const tensorFoldChecks = await tensorFoldHealthChecks()
  const probes = depth === 'deep' ? await import('./healthDeepProbes.js') : null
  return { cwd, version, git, repo, head, tensorFoldChecks, probes }
}

export async function runHealthReport(opts?: RunHealthReportOptions): Promise<HealthCertificate> {
  const t0 = Date.now()
  const depth = opts?.depth ?? 'fast'
  const context = await healthContext(depth)
  const { head, version } = context
  const { HEALTH_SECTIONS } = await import('./health/sections.js')
  const specs: SectionSpec[] = HEALTH_SECTIONS.map(section => ({ id: section.id, title: section.title, checks: section.checks(context) }))

  const work: Array<{ spec: CheckSpec; sectionId: string; sectionTitle: string; slot: number }> = []
  const resultSlots: Array<HealthCheck | null> = []
  for (const section of specs) {
    for (const c of section.checks) {
      if ((c.depth ?? 'fast') === 'deep' && depth !== 'deep') continue
      work.push({ spec: c, sectionId: section.id, sectionTitle: section.title, slot: work.length })
      resultSlots.push(null)
    }
  }

  const settled = new Set<string>()
  let done = 0
  const runOne = async (item: (typeof work)[number]): Promise<void> => {
    const { spec } = item
    const startedAt = Date.now()
    const timeoutMs = spec.timeoutMs ?? ((spec.depth ?? 'fast') === 'deep' ? 60_000 : 10_000)
    let result: CheckResult
    const controller = new AbortController()
    const onCallerAbort = (): void =>
      controller.abort(opts?.signal?.reason ?? new Error('health run cancelled'))
    opts?.signal?.addEventListener('abort', onCallerAbort, { once: true })
    const deadline = setTimeout(
      () => controller.abort(new Error(`check timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    ;(deadline as { unref?: () => void }).unref?.()
    try {
      if (opts?.signal?.aborted) throw new Error('health run cancelled')
      result = await Promise.race([
        Promise.resolve(spec.run({ signal: controller.signal })),
        new Promise<never>((_, rej) => {
          controller.signal.addEventListener(
            'abort',
            () => rej(controller.signal.reason instanceof Error ? controller.signal.reason : new Error('aborted')),
            { once: true },
          )
        }),
      ])
    } catch (e: unknown) {
      result = {
        status: 'unknown',
        evidence: `probe threw: ${e instanceof Error && e.message ? e.message.slice(0, 140) : 'error'} — no evidence either way`,
      }
    } finally {
      clearTimeout(deadline)
      opts?.signal?.removeEventListener('abort', onCallerAbort)
      if (!controller.signal.aborted) controller.abort(new Error('check settled'))
    }
    const check: HealthCheck = {
      id: spec.id,
      label: spec.label,
      probe: spec.probe ?? 'configuration',
      depth: spec.depth ?? 'fast',
      durationMs: Date.now() - startedAt,
      evidenceAt: Date.now(),
      ...result,
    }
    resultSlots[item.slot] = check
    settled.add(spec.id)
    done++
    try {
      opts?.onProgress?.({
        check,
        sectionId: item.sectionId,
        sectionTitle: item.sectionTitle,
        done,
        total: work.length,
      })
    } catch {
    }
  }

  const queue = [...work]
  const running: Promise<void>[] = []
  while (queue.length > 0 || running.length > 0) {
    let launched = false
    for (let i = 0; i < queue.length && running.length < HEALTH_CONCURRENCY; i++) {
      const item = queue[i]!
      const deps = item.spec.dependsOn ?? []
      if (deps.every(d => settled.has(d))) {
        queue.splice(i, 1)
        i--
        const p = runOne(item).then(() => {
          running.splice(running.indexOf(p), 1)
        })
        running.push(p)
        launched = true
      }
    }
    if (running.length > 0) {
      await Promise.race(running)
    } else if (!launched && queue.length > 0) {
      const item = queue.shift()!
      resultSlots[item.slot] = {
        id: item.spec.id,
        label: item.spec.label,
        status: 'unknown',
        evidence: `unsatisfiable dependsOn: ${(item.spec.dependsOn ?? []).join(', ')}`,
        probe: item.spec.probe ?? 'configuration',
        depth: item.spec.depth ?? 'fast',
      }
      settled.add(item.spec.id)
      done++
    }
  }

  const sections: HealthSection[] = []
  for (const spec of specs) {
    const checks: HealthCheck[] = []
    for (const c of spec.checks) {
      const found = resultSlots.find(r => r?.id === c.id)
      if (found) checks.push(found)
    }
    if (checks.length > 0) sections.push({ id: spec.id, title: spec.title, checks })
  }

  const cert: HealthCertificate = {
    verdict: verdictFromStatuses(flattenChecks({ sections }).map(c => c.status)),
    sections,
    ranAt: new Date().toISOString(),
    head,
    version,
    durationMs: Date.now() - t0,
    depth,
    nodeRuntime: nodeRuntimeProjection(process.versions.node),
  }
  return cert
}

export async function runAndRecordHealthReport(opts?: RunHealthReportOptions): Promise<HealthCertificate> {
  const cert = await runHealthReport(opts)
  if (healthCertEnabled()) {
    try {
      let previous: LastCertSummary | null = null
      try {
        previous = decodeLastCertSummary(JSON.parse(readFileSync(lastCertPath(), 'utf8')))
      } catch {
        previous = null
      }
      const summary = carryDeepReadings(summarizeCert(cert), previous, new Set(flattenChecks(cert).map(c => c.id)))
      await publishAtomic(
        lastCertPath(),
        JSON.stringify({ ...summary, _v: 1 }, null, 2),
      )
    } catch {
    }
  }
  if (!isReadOnlyDiagnostic()) {
    try {
      const { runLifecycleVerbOpportunity } = await import('./backgroundHousekeeping.js')
      await runLifecycleVerbOpportunity('health')
    } catch {}
  }
  return cert
}
