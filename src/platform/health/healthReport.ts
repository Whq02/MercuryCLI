
import { isReadOnlyDiagnostic } from '../logs/diagnosticReadOnly.js'
import { projectHomeLeftovers, projectHomeStore } from '../storage/projectHomeStores.js'
import { MERCURY_PROJECT_DIR } from '../settings/projectConfig.js'
import { homeDirectory, isHomeDirectory, projectScopePathspec, USER_ROOT_NAMES } from '../files/projectBoundary.js'
import { findGitRoot, type GitRepoState } from '../git/git.js'
import { settleChildRun } from '../../integrations/ide/childSettle.js'
import { gitArgs, gitArgsAsync } from '../git/spawnArgs.js'
import { endProcessTree, strikeProcessGroupNow } from '../processes/processGroup.js'
import { subprocessEnv } from '../processes/subprocessEnv.js'
import { projectLocalPath } from '../project-local/paths.js'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { nodeRuntimeProjection } from '../node-runtime/nodePolicy.js'
import { readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve as resolvePath, sep } from 'node:path'
import { GLYPH } from '../../screen/theme/glyphs.js'
import { pidAlive } from '../processes/pidAlive.js'
import { publishAtomic } from '../substrate/fileStore.js'
import { flagEnabled, flagEnv } from '../substrate/flagRegistry.js'
import { getCwd } from '../files/cwd.js'
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
import { getUserSpecifiedModelSetting } from '../../models/catalogue/engineModel.js'
import { computedDefault } from '../../models/catalogue/computedDefault.js'
import { gitSnapshot } from '../../screen/cockpit/gitSnapshot.js'
import { healthFixEnabled } from './healthFix.js'
import { sleep } from '../async/sleep.js'
import { logError } from '../logs/errorLog.js'
import { passedOver } from '../errors/passedOver.js'
import { withDeadline } from '../async/deadline.js'
import { heldFileRetriesApply } from '../host-os/files.js'
import { childGetsOwnProcessGroup, processTreeEndMethod } from '../host-os/processes.js'
import { homeRepoRemovalCommands } from '../host-os/words.js'
import { sleepSync } from '../async/timers.js'

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
  } catch (error) {
    passedOver(error)
    return false
  }
}

function sweepTreeScratch(): void {
  const method = processTreeEndMethod()
  for (const child of treeScratchGits) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) continue
    if (method === 'win32-taskkill') void endProcessTree(child, 'SIGKILL')
    else strikeProcessGroupNow(child)
  }
  const giveUpAt = Date.now() + TREE_SCRATCH_RELEASE_MS
  for (const dir of [...treeScratchDirs]) {
    while (!removeTreeScratch(dir) && Date.now() < giveUpAt) {
      sleepSync(TREE_SCRATCH_RETRY_MS)
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
      const ownGroup = childGetsOwnProcessGroup()
      const child = execFile(
        'git',
        argv,
        { windowsHide: true, cwd: cwdDir, env, ...(ownGroup ? { detached: true, timeout: 15_000, ...(signal ? { signal } : {}) } : {}) },
        (err, stdout) => {
          treeScratchGits.delete(child)
          resolvePromise(err ? null : stdout.trim())
        },
      )
      treeScratchGits.add(child)
      if (!ownGroup) void settleChildRun(child, { timeoutMs: 15_000, ...(signal ? { signal } : {}) })
    })
  }
  try {
    if (signal?.aborted) return null
    if ((await run(['read-tree', 'HEAD'])) === null) return null
    if ((await run(['add', '-A', ...projectScopePathspec(cwdDir)])) === null) return null
    const tree = await run(['write-tree', '--missing-ok'])
    return tree && tree.length > 0 ? tree : null
  } catch (error) {
    passedOver(error)
    return null
  } finally {
    if (!removeTreeScratch(idxDir) && heldFileRetriesApply()) {
      const giveUpAt = Date.now() + TREE_SCRATCH_RELEASE_MS
      while (treeScratchDirs.has(idxDir) && Date.now() < giveUpAt) {
        await sleep(TREE_SCRATCH_RETRY_MS)
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
  return homeRepoRemovalCommands(inside, platform)
}

const QUIT_FIRST_WORDS = 'quit every Mercury window and its background process (sign out and back in on Windows if unsure)'

function errorBrief(error: unknown): string {
  return (error instanceof Error && error.message ? error.message : String(error)).slice(0, 120)
}

function isAbsenceCode(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function mercuryHoldersOf(repo: string): Promise<{ runners: string[]; indexLockAgeS: number | null; objectsInFlight: number; unread: string[] }> {
  const runners: string[] = []
  const unread: string[] = []
  const noteUnread = (entry: string): void => {
    if (!unread.includes(entry)) unread.push(entry)
  }
  try {
    const { readSessionWorkers } = await import('../../daemon/concourse-workers/concourseWorkers.js')
    for (const rec of Object.values(readSessionWorkers())) {
      if (rec.endedAt !== undefined || rec.pid === undefined || !pidAlive(rec.pid)) continue
      let ws: string
      try {
        ws = realpathSync(rec.workspaceId)
      } catch (error) {
        if (isAbsenceCode(error)) passedOver(error)
        else noteUnread(`live sessions: ${errorBrief(error)}`)
        continue
      }
      if (ws !== repo && !ws.startsWith(repo + sep)) continue
      if (findGitRoot(ws) !== repo) continue
      const warm = (rec as { warm?: boolean }).warm === true
      runners.push(`${rec.runnerId}${warm ? ' (warm)' : ''} pid ${rec.pid}`)
    }
  } catch (error) {
    noteUnread(`live sessions: ${errorBrief(error)}`)
  }
  let indexLockAgeS: number | null = null
  try {
    indexLockAgeS = Math.max(0, Math.round((Date.now() - statSync(join(repo, '.git', 'index.lock')).mtimeMs) / 1000))
  } catch (error) {
    indexLockAgeS = null
    if (!isAbsenceCode(error)) noteUnread(`.git/index.lock: ${errorBrief(error)}`)
  }
  let objectsInFlight = 0
  try {
    objectsInFlight = readdirSync(join(repo, '.git', 'objects')).filter(n => /^tmp_obj_|^tmpobj/i.test(n)).length
  } catch (error) {
    objectsInFlight = 0
    if (!isAbsenceCode(error)) noteUnread(`.git/objects: ${errorBrief(error)}`)
  }
  return { runners, indexLockAgeS, objectsInFlight, unread }
}

function holdersWords(h: { runners: string[]; indexLockAgeS: number | null; objectsInFlight: number; unread: string[] }): string {
  const parts: string[] = []
  if (h.runners.length > 0) parts.push(`${h.runners.length} live session${h.runners.length === 1 ? '' : 's'} rooted here (${h.runners.join(', ')})`)
  if (h.indexLockAgeS !== null) parts.push(`a git writer holds .git/index.lock (${h.indexLockAgeS} s old)`)
  if (h.objectsInFlight > 0) parts.push(`${h.objectsInFlight} object${h.objectsInFlight === 1 ? '' : 's'} being written under .git/objects`)
  if (h.unread.length === 0) return parts.length === 0 ? 'no Mercury process holds it now' : `held by Mercury now: ${parts.join(' · ')}`
  const missing = h.unread.join('; ')
  return parts.length === 0
    ? `could not check whether Mercury holds it now (${missing})`
    : `held by Mercury now: ${parts.join(' · ')}; could not check remaining holders (${missing})`
}

export async function projectEstateCheck(): Promise<CheckResult> {
  const root = healthStateRoot()
  const leftovers = projectHomeLeftovers(root)
  if (leftovers.length === 0) {
    return { status: 'ok', evidence: `${MERCURY_PROJECT_DIR} holds shared configuration only — every machine-local store lives under the config home`, probe: 'functional' }
  }
  let tracked: string[] = []
  let gitCheckError: string | null = null
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { stdout } = await promisify(execFile)('git', ['ls-files', '-z', '--', ...leftovers], { cwd: root, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 })
    const files = stdout.split('\0').filter(f => f !== '')
    tracked = leftovers.filter(dir => files.some(f => f === dir || f.startsWith(`${dir}/`)))
  } catch (error) {
    tracked = []
    if (findGitRoot(root) !== null) gitCheckError = errorBrief(error)
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
        : gitCheckError !== null
          ? `delete the folder copies when you are done with them (could not check whether git tracks them (${gitCheckError}) — check with git ls-files before deleting)`
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
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    names = []
  }
  for (const name of names) {
    const lower = name.toLowerCase()
    if (USER_ROOT_NAMES.some(n => n.toLowerCase() === lower) || lower.startsWith('onedrive')) candidates.push(join(home, name))
  }
  const repositories = candidates.filter(dir => {
    try {
      return statSync(join(dir, '.git')).isDirectory()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        passedOver(error)
        return false
      }
      throw error
    }
  })
  if (repositories.length === 0) {
    return { status: 'ok', evidence: `no git repository at ${home} or its user folders`, probe: 'functional' }
  }
  const { FORK_BASE_COMMIT_SUBJECT } = await import('../../daemon/concourse-workers/concourseWorktrees.js')
  const facts = await Promise.all(
    repositories.map(async dir => {
      let created = 'creation date unknown'
      try {
        const st = statSync(join(dir, '.git'))
        const at = st.birthtimeMs > 0 ? st.birthtime : st.ctime
        created = `.git created ${at.toISOString().slice(0, 10)}`
      } catch (error) {
        passedOver(error)
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
    const { getProjectRoot } = require('../../boot/process-state/processState.js') as typeof import('../../boot/process-state/processState.js')
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
}

interface SectionSpec {
  id: string
  title: string
  checks: Array<CheckSpec>
}

export interface HealthSectionRows {
  id: string
  title: string
  checks: (context: HealthContext) => CheckSpec[] | Promise<CheckSpec[]>
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

export const SHELL_READS = Object.freeze({
  outputLimits: () => import('../shell/outputLimits.js'),
  engineSession: () => import('../shell/engineSession.js'),
  engineArm: () => import('../shell/shellEngineArm.js'),
  shellRecord: () => import('../shell/shellRecord.js'),
})


export function unresolvedDefaultRow(): string | null {
  if (getUserSpecifiedModelSetting() !== null) return null
  const decision = computedDefault()
  return decision.source === 'keyless' && decision.considered.length > 0 ? decision.row : null
}

export async function tensorFoldHealthChecks(): Promise<CheckSpec[]> {
  let rows: import('../../models/roads/local/tensorfoldHealth.js').TensorFoldHealthChecks
  let labels: typeof import('../../models/roads/local/tensorfoldHealth.js')
  try {
    labels = await import('../../models/roads/local/tensorfoldHealth.js')
    rows = await labels.readTensorFoldHealth()
  } catch (error) {
    return [{ id: 'tensorfold', label: 'TensorFold', run: () => { throw error } }]
  }
  const specs: CheckSpec[] = []
  const { tensorfold, support, helper } = rows
  if (tensorfold !== undefined) specs.push({ id: 'tensorfold', label: labels.TENSORFOLD_HEALTH_LABEL, run: () => tensorfold })
  if (support !== undefined) specs.push({ id: 'tensorfold-support', label: labels.TENSORFOLD_SUPPORT_LABEL, run: () => ({ status: 'info' as const, evidence: support }) })
  if (helper !== undefined) specs.push({ id: 'helper-model', label: labels.HELPER_HEALTH_LABEL, run: () => helper })
  return specs
}

export function ocrReadinessCheck(reads?: Parameters<typeof import('../../tools/kit/ocr.js').resolveOcrEngine>[0]): CheckSpec {
  return {
    id: 'iface-ocr',
    label: 'OCR',
    depth: 'fast',
    probe: 'configuration',
    timeoutMs: 11_000,
    run: async () => {
      const { resolveOcrEngine } = await import('../../tools/kit/ocr.js')
      const engine = await resolveOcrEngine(reads)
      return engine.kind === 'unavailable'
        ? { status: 'info', evidence: `unavailable — ${engine.message}`, fix: engine.message }
        : { status: 'ok', evidence: engine.name, detail: `Languages: ${engine.languages.join(', ')}` }
    },
  }
}

export function browserReadinessCheck(reads?: import('../../integrations/browser/browserResolver.js').BrowserResolverReads): CheckSpec {
  return {
    id: 'iface-browser',
    label: 'Browser',
    depth: 'fast',
    probe: 'configuration',
    run: async () => {
      const { describeBrowserReadiness } = await import('../../integrations/browser/browserResolver.js')
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
      const { describeAnthropicClientContract } = await import('../../models/sign-in/oauth/oauth.js')
      const { clientContractRecordWords } = await import('../../engine/requests/clientContractLearned.js')
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
        require('../../models/roads/anthropic/modelRefusal.js') as typeof import('../../models/roads/anthropic/modelRefusal.js')
      const { renderModelName } = require('../../models/catalogue/engineModel.js') as typeof import('../../models/catalogue/engineModel.js')
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
  const skills = require('../../integrations/skills/loadSkillsDir.js') as typeof import('../../integrations/skills/loadSkillsDir.js')
  await skills.getSkillDirCommands(cwd)
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
}

export async function healthContext(): Promise<HealthContext> {
  const cwd = getCwd()

  const git = await gitSnapshot({ fresh: true })
  const repo = git.state === 'live' ? git.data.git : null
  const head: CertHead = repo
    ? { sha: repo.commitHash, branch: repo.branchName, dirty: !repo.isClean }
    : { sha: null, branch: null, dirty: null }

  const version =
    typeof MACRO !== 'undefined' && typeof MACRO.VERSION === 'string' ? MACRO.VERSION : 'dev'
  return { cwd, version, git, repo, head }
}

export async function runHealthReport(opts?: RunHealthReportOptions, list?: readonly HealthSectionRows[]): Promise<HealthCertificate> {
  const t0 = Date.now()
  const depth = opts?.depth ?? 'fast'
  const context = await healthContext()
  const { head, version } = context
  const listed = list ?? (await import('./sections.js')).HEALTH_SECTIONS
  const specs: SectionSpec[] = []
  for (const section of listed) specs.push({ id: section.id, title: section.title, checks: await section.checks(context) })

  const work: Array<{ spec: CheckSpec; sectionId: string; sectionTitle: string; slot: number }> = []
  const resultSlots: Array<HealthCheck | null> = []
  for (const section of specs) {
    for (const c of section.checks) {
      if ((c.depth ?? 'fast') === 'deep' && depth !== 'deep') continue
      work.push({ spec: c, sectionId: section.id, sectionTitle: section.title, slot: work.length })
      resultSlots.push(null)
    }
  }

  let done = 0
  const runOne = async (item: (typeof work)[number]): Promise<void> => {
    const { spec } = item
    const startedAt = Date.now()
    const timeoutMs = spec.timeoutMs ?? ((spec.depth ?? 'fast') === 'deep' ? 60_000 : 10_000)
    let result: CheckResult
    const controller = new AbortController()
    try {
      if (opts?.signal?.aborted) throw new Error('health run cancelled')
      result = await withDeadline(
        Promise.resolve(spec.run({ signal: controller.signal })),
        timeoutMs,
        () => {
          const error = new Error(`check timed out after ${timeoutMs}ms`)
          controller.abort(error)
          throw error
        },
        {
          signal: opts?.signal,
          onAbort: () => {
            const reason = opts?.signal?.reason ?? new Error('health run cancelled')
            controller.abort(reason)
            throw reason instanceof Error ? reason : new Error('aborted')
          },
          unref: true,
        },
      )
    } catch (e: unknown) {
      result = {
        status: 'unknown',
        evidence: `probe threw: ${e instanceof Error && e.message ? e.message.slice(0, 140) : 'error'} — no evidence either way`,
      }
    } finally {
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
    done++
    try {
      opts?.onProgress?.({
        check,
        sectionId: item.sectionId,
        sectionTitle: item.sectionTitle,
        done,
        total: work.length,
      })
    } catch (error) {
      passedOver(error)
    }
  }

  for (const rowsDepth of ['fast', 'deep'] as const) {
    const queue = work.filter(item => (item.spec.depth ?? 'fast') === rowsDepth)
    const worker = async (): Promise<void> => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await runOne(item)
    }
    await Promise.all(Array.from({ length: HEALTH_CONCURRENCY }, worker))
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
    } catch (err) {
      logError(new Error(`the health cert summary could not be saved to ${lastCertPath()}, so the health views keep the older one: ${err instanceof Error ? err.message : String(err)}`))
    }
  }
  if (!isReadOnlyDiagnostic()) {
    try {
      const { runLifecycleVerbOpportunity } = await import('../housekeeping/backgroundHousekeeping.js')
      await runLifecycleVerbOpportunity('health')
    } catch (error) { passedOver(error) }
  }
  return cert
}
