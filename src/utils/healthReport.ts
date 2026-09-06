
import { getHistoryFlushHealth, historyEverFlushedThisProcess } from '../history.js'
import { readBootAttemptResidue } from '../substrate/bootBeacon.js'
import { adoptiveProjectPath } from './projectStoreAdoption.js'
import { projectHomeLeftovers, projectHomeStore } from './projectHomeStores.js'
import { MERCURY_PROJECT_DIR } from './projectConfig.js'
import { homeDirectory, isHomeDirectory, projectScopePathspec, USER_ROOT_NAMES } from './projectBoundary.js'
import { findGitRoot, gitProbeNote } from './git.js'
import { settleChildRun } from './childSettle.js'
import { subprocessEnv } from './subprocessEnv.js'
import { adoptiveProjectLocalPath } from '../services/projectLocal/paths.js'
import { workflowRunsRoot } from '../tools/WorkflowTool/runManifest.js'
import { execFile, spawn } from 'node:child_process'
import chalk from 'chalk'
import { NODE_FLOOR_REASON, NODE_SUPPORT, nodeRuntimeProjection } from './runtime/nodePolicy.js'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile, rename } from 'node:fs/promises'
import { cpus, homedir, loadavg } from 'node:os'
import { deviceHeadroom } from './cockpit/deviceHeadroom.js'
import { basename, delimiter, dirname, join, relative, resolve as resolvePath, sep } from 'node:path'
import { whichSync } from './which.js'
import { artifactIdentityLine, describeArtifactIdentity } from './artifactIdentity.js'
import { GLYPH, branchChip } from '../components/mercury-ui/glyphs.js'
import { crashReportDir } from './crashReport.js'
import { getAuthConfigHomeDir, getMercuryHome } from './envUtils.js'
import { classifyHarnessHome, harnessArtifactPath, type HarnessHomeReport } from './knownAgentClis.js'
import { pidAlive } from './pidAlive.js'
import { listExperienceCards, experienceCardsEnabled } from '../memdir/experienceCards.js'
import {
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
} from '../memdir/memdir.js'
import { getAutoMemPath } from '../memdir/paths.js'
import { isAwaySummaryEnabled } from './cockpit/awaySummary.js'
import { isMercuryCompactKeepTailEnabled } from '../services/compact/verbatimTail.js'
import { publishAtomic } from '../substrate/fileStore.js'
import { FLAG_REGISTRY, flagEnabled, flagEnv } from '../substrate/flagRegistry.js'
import { realEnvPin } from '../substrate/startupMenu.js'
import { isRunOrphaned, listWorkflowRunsDetailed } from '../tools/WorkflowTool/runManifest.js'
import { getAnthropicApiKeyWithSource, getAuthTokenSource } from './auth.js'
import { buildRouterModelSnapshot } from './router/modelRegistry.js'
import { binaryName, isMercurySubstrateProfileOn } from './config.js'
import { getCwd } from './cwd.js'
import {
  countByStatus,
  decodeGateVerdict,
  flattenChecks,
  formatAge,
  interpretGateVerdict,
  sha7,
  summarizeCert,
  verdictFromStatuses,
  type CertHead,
  type HealthCertificate,
  type HealthCheck,
  type HealthSection,
  type HealthStatus,
} from './healthCertCore.js'
import { isInvocationTraceEnabled } from './observability/invocationTrace.js'
import { mercuryLspEnabled } from '../services/lsp/mercuryLsp.js'
import { probeBuiltinTsServer } from '../services/lsp/builtinServers.js'
import {
  compileDbRemedy,
  mercuryLspCppEnabled,
  probeBuiltinClangd,
  probeCompileDb,
} from '../services/lsp/clangdLane.js'
import {
  probeGodotEditorReachable,
  probeGodotLane,
} from '../services/lsp/godotLane.js'
import {
  getInitializationStatus,
  getLspServerManager,
} from '../services/lsp/manager.js'
import { listCapabilityKills } from './permissions/capabilityGate.js'
import { getMainLoopModel, parseUserSpecifiedModel, renderModelChip } from './model/model.js'
import {
  describeFrontierDecision,
  frontierOperatorDecision,
} from './model/frontierPolicy.js'
import { computedDefault, describeComputedDefault } from './model/computedDefault.js'
import { providerDisplayName } from '../services/providers/routeLaw.js'
import {
  getInstructionBundle,
  getInstructionCompositionState,
} from '../services/instructions/engine.js'
import { readPromptProvenance } from './cockpit/promptProvenance.js'
import { getSettingsWithAllErrors } from './settings/allErrors.js'
import { getRipgrepStatus } from './ripgrep.js'
import {
  CHALK_BOOSTED_FOR_MERCURY,
  CHALK_CLAMPED_FOR_TMUX,
  CHALK_DISABLED_FOR_NO_COLOR,
} from '../ink/colorize.js'
import { getLiveContextUsage } from './cockpit/contextUsageLive.js'
import { ctxForecastEnabled } from './cockpit/ctxForecast.js'
import { daemonSnapshot } from './cockpit/daemonSnapshot.js'
import { daemonDir } from '../daemon/controlSocket.js'
import type { DaemonSignInViewV1 } from '../daemon/protocol.js'
import { getGlobalMercuryFile } from './env.js'
import { getMacOsKeychainStorageServiceName } from './secureStorage/macOsKeychainHelpers.js'
import { fleetGauge } from './cockpit/fleetGauge.js'
import { gitSnapshot } from './cockpit/gitSnapshot.js'
import { mcpGauge } from './cockpit/mcpGauge.js'
import { substrateSnapshot } from './cockpit/substrateSnapshot.js'
import { SandboxManager } from './sandbox/sandbox-adapter.js'
import { describeUntrustedMcpHardening, getMcpPolicyRejects } from '../services/mcp/toolPolicy.js'
import { getEnabledSettingSources } from './settings/constants.js'
import { getSettingsForSource } from './settings/settings.js'
import { summarizeMcpAuthCurrency } from '../services/mcp/auth.js'
import { LATEST_PROTOCOL_VERSION } from '../services/mcp/sdk.js'
import { extensionsHealthRow } from '../extensions/boot.js'
import { healthFixEnabled } from './healthFix.js'
import { assessDeployedAssets } from './healthDeployedAssets.js'
import { getMercuryAppearanceSnapshot } from './profile/appearanceSnapshot.js'
import { isDarkThemeFamily, listUnresolvedTokenRoles, resolveMercuryTokens } from './mercuryTokens.js'
import { oasisBgEnabled } from './cockpit/oasisBg.js'
import { getBuiltInAgents } from '../tools/AgentTool/builtInAgents.js'
import {
  findRoleDefinition,
  getRoleSystemPrompt,
} from './swarm/roleResolver.js'
import {
  getResolvedTeammateMode,
  isInProcessEnabled,
} from './swarm/backends/registry.js'
import { recognizeModelId, unrecognisedModelIdReason } from '../services/providers/idSpaces.js'

export async function computeWorkingTreeSha(cwdDir: string): Promise<string | null> {
  const { mkdirSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const idxDir = mkdtempSync(join(tmpdir(), 'gate-tree-'))
  const idx = join(idxDir, 'index')
  const objects = join(idxDir, 'objects')
  mkdirSync(objects, { recursive: true })
  const repoObjects = await new Promise<string | null>(resolve => {
    execFile(
      'git',
      ['rev-parse', '--git-path', 'objects'],
      { windowsHide: true, cwd: cwdDir, env: { ...subprocessEnv() }, timeout: 15_000 },
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
  const run = (args: string[]): Promise<string | null> =>
    new Promise(resolvePromise => {
      execFile(
        'git',
        args,
        { windowsHide: true, cwd: cwdDir, env, timeout: 15_000 },
        (err, stdout) => resolvePromise(err ? null : stdout.trim()),
      )
    })
  try {
    if ((await run(['read-tree', 'HEAD'])) === null) return null
    if ((await run(['add', '-A', ...projectScopePathspec(cwdDir)])) === null) return null
    const tree = await run(['write-tree', '--missing-ok'])
    return tree && tree.length > 0 ? tree : null
  } catch {
    return null
  } finally {
    try {
      rmSync(idxDir, { recursive: true, force: true })
    } catch {
    }
  }
}

function gitLogSubjects(dir: string, limit: number): Promise<string[] | null> {
  return new Promise(resolve => {
    execFile(
      'git',
      ['-C', dir, 'log', `--max-count=${limit}`, '--format=%s'],
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
    const { readSessionWorkers } = await import('../daemon/concourseSupervisor.js')
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
        ? `${QUIT_FIRST_WORDS}, then run ${words.inspect} — only Mercury's base commit should be listed — then remove the repository: ${words.remove}`
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

function runRemedyCmd(
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
import {
  MERCURY_DOCTRINE,
  mercuryDoctrineEnabled,
} from '../prompt/mercuryContract.js'

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
  return flagEnabled('MERCURY_DOCTOR_CERT')
}

const MB = 1024 * 1024
const mb = (bytes: number) => `${(bytes / MB).toFixed(0)}MB`

export function healthStateRoot(): string {
  return flagEnv('MERCURY_DOCTOR_STATE_DIR') || getProjectRootSafe()
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
  return join(projectHomeStore(healthStateRoot(), 'doctor'), 'last-cert.json')
}

export function gateVerdictPath(): string {
  return join(adoptiveProjectPath(healthStateRoot(), 'gate'), 'verdict.json')
}

function readTsVersion(tsPath: string): string | null {
  try {
    const pkgPath = join(dirname(dirname(tsPath)), 'package.json')
    if (!existsSync(pkgPath)) return null
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}

function execGit(args: string[], cwd: string, timeoutMs = 1500): Promise<string | null> {
  return new Promise(resolve => {
    try {
      execFile('git', args, { windowsHide: true, cwd, timeout: timeoutMs, env: { ...subprocessEnv() } }, (err, stdout) => {
        resolve(err ? null : stdout.trim())
      })
    } catch {
      resolve(null)
    }
  })
}


type CheckResult = Omit<HealthCheck, 'id' | 'label'>
type CheckFn = (probeCtx?: { signal?: AbortSignal }) => Promise<CheckResult> | CheckResult

interface CheckSpec {
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


const PROVIDER_AUTH_PRESENTATION: Record<string, { label: string; signIn: string }> = {
  anthropic: { label: 'Anthropic', signIn: 'Run /logins (or export ANTHROPIC_API_KEY)' },
  openai: {
    label: 'OpenAI',
    signIn: 'Connect via /logins (browser or device code)',
  },
  zai: { label: 'Z.AI', signIn: 'Add a Z.AI API key via /logins zai, or export ZAI_API_KEY' },
  moonshot: {
    label: 'Moonshot',
    signIn: 'Sign in via /logins moonshot (Kimi, or an API key), or export MOONSHOT_API_KEY',
  },
  deepseek: {
    label: 'DeepSeek',
    signIn: 'Add a DeepSeek API key via /logins deepseek, or export DEEPSEEK_API_KEY',
  },
  'openai-compat': {
    label: 'Custom endpoint',
    signIn: 'Set MERCURY_COMPAT_BASE_URL (key optional — /router key compat)',
  },
}

function routedAuthFamily(): string {
  try {
    const { declaredRouteOf } = require('../services/providers/routeLaw.js') as typeof import('../services/providers/routeLaw.js')
    return declaredRouteOf(getMainLoopModel()) ?? 'anthropic'
  } catch {
    return 'anthropic'
  }
}

function editOutcomeHealthChecks(): CheckSpec[] {
  try {
    const { editOutcomeLedgerEnabled } =
      require('../services/changeTransaction/editOutcomeLedger.js') as typeof import('../services/changeTransaction/editOutcomeLedger.js')
    if (!editOutcomeLedgerEnabled()) return []
  } catch {
    return []
  }
  return [
    {
      id: 'edit-outcomes',
      label: 'Edit outcomes',
      run: async () => {
        const { editOutcomeHealthRows } = await import('../services/changeTransaction/editOutcomeLedger.js')
        const { processMainOwner } = await import('../services/run/resolveOwner.js')
        const rows = editOutcomeHealthRows(processMainOwner())
        if (rows.length === 0) return { status: 'ok', evidence: 'no edit attempts this session' }
        return {
          status: 'info',
          evidence: rows
            .map(
              row =>
                `${row.model}: ${row.attempts} attempt(s), ${row.applied} applied${row.topFailure !== null ? `, top failure ${row.topFailure} ×${row.topFailureCount}` : ''}`,
            )
            .join(' · '),
        }
      },
    },
  ]
}

function providerAuthChecks(): CheckSpec[] {
  const snap = buildRouterModelSnapshot()
  const routedFamily = routedAuthFamily()
  return snap.providers.map((provider): CheckSpec => {
    const meta = PROVIDER_AUTH_PRESENTATION[provider.id] ?? {
      label: provider.id,
      signIn: 'Connect an account for this provider (see /capabilities)',
    }
    if (provider.id === 'anthropic') {
      return {
        id: 'auth-anthropic',
        label: meta.label,
        run: () => {
          const { anthropicCredentialPresence } =
            require('../services/providers/providerUsage.js') as typeof import('../services/providers/providerUsage.js')
          const presence = anthropicCredentialPresence()
          if (!presence.credentialed) {
            if (routedFamily !== 'anthropic') {
              return {
                status: 'info' as const,
                evidence: `absent — no bearer token or API key (session routes to ${routedFamily})`,
                fix: `${meta.signIn}.`,
              }
            }
            return {
              status: 'fail' as const,
              evidence:
                'absent — no bearer token or API key from the owning resolvers (getAuthTokenSource + getAnthropicApiKeyWithSource)',
              fix: `${meta.signIn} — no turn can run without it.`,
            }
          }
          if (presence.expired) {
            return {
              status: 'warn' as const,
              evidence: `${presence.credentialLabel ?? 'claude.ai sign-in'} — sign-in EXPIRED (dead or spent refresh token; no network probe)`,
              fix: 'Anthropic sign-in expired — /logins reconnects.',
            }
          }
          const tok = getAuthTokenSource()
          if (tok.hasToken) {
            return {
              status: 'ok' as const,
              evidence: `bearer token via ${tok.source} (present — validity untested: no network probe by design)`,
            }
          }
          const key = getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true })
          return {
            status: 'ok' as const,
            evidence: `${key.source && key.source !== 'none' ? `API key via ${key.source}` : presence.credentialLabel} (present — validity untested: no network probe by design)`,
          }
        },
      }
    }
    return {
      id: `auth-${provider.id}`,
      label: meta.label,
      run: () => {
        const account = provider.description.account
        if (account.kind === 'none') {
          if (provider.id === routedFamily) {
            return {
              status: 'fail' as const,
              evidence: `absent — ${account.label} (the session routes to ${routedFamily}; no turn can run without it)`,
              fix: `${meta.signIn} — no turn can run without it.`,
            }
          }
          return {
            status: 'info' as const,
            evidence: `absent — ${account.label}${provider.reason ? ` (${provider.reason})` : ''}`,
            fix: `${meta.signIn}.`,
          }
        }
        return {
          status: 'ok' as const,
          evidence: `${account.kind} — ${account.label} (present — validity untested: no network probe by design)`,
        }
      },
    }
  })
}

function providerUsageChecks(): CheckSpec[] {
  let owner: typeof import('../services/providers/providerUsage.js')
  let presences: ReturnType<typeof owner.providerFamilyPresences>
  try {
    owner = require('../services/providers/providerUsage.js') as typeof import('../services/providers/providerUsage.js')
    presences = owner.providerFamilyPresences()
  } catch {
    return []
  }
  const { providerDisplayName } = require('../services/providers/routeLaw.js') as typeof import('../services/providers/routeLaw.js')
  return presences
    .filter(presence => presence.credentialed)
    .map((presence): CheckSpec => ({
      id: `usage-${presence.id}`,
      label: `${providerDisplayName(presence.id)} usage`,
      run: () => ({
        status: 'info' as const,
        evidence: owner.usageSummaryWords(owner.usageForProvider(presence.id)),
      }),
    }))
}

function webSearchDoorCheck(): CheckSpec {
  return {
    id: 'web-search-door',
    label: 'Web search',
    run: () => {
      const { liveSearchDoorReads, resolveSearchDoorPlan, nativeSearchFamilyOf, searchDoorFact } =
        require('../services/search/searchDoor.js') as typeof import('../services/search/searchDoor.js')
      const model = getMainLoopModel()
      const plan = resolveSearchDoorPlan(liveSearchDoorReads())
      if (plan.doors.length === 0 && nativeSearchFamilyOf(model) === undefined) {
        return {
          status: 'info' as const,
          evidence: `no door opens for ${model} — ${plan.closed.join('; ')}`,
          fix: '/router key brave (or tavily) stores a search key; unset MERCURY_SEARCH_KEYLESS to allow keyless search.',
        }
      }
      return { status: 'ok' as const, evidence: `${model}: ${searchDoorFact(model)}` }
    },
  }
}

function extraCaCertsCheck(): CheckSpec {
  return {
    id: 'extra-ca-certs',
    label: 'Extra CA bundle',
    run: () => {
      const { getExtraCaCertsOutcome } = require('./caCerts.js') as typeof import('./caCerts.js')
      const outcome = getExtraCaCertsOutcome()
      if (outcome === null) return { status: 'ok' as const, evidence: 'NODE_EXTRA_CA_CERTS unset — the runtime trust store alone' }
      if (outcome.loaded) return { status: 'ok' as const, evidence: `${outcome.path} read and appended to the bundled roots` }
      return {
        status: 'fail' as const,
        evidence: `${outcome.path} could not be read (${outcome.error ?? 'unreadable'}) — the bundled roots alone are in use; behind TLS interception every request will fail verification`,
        fix: 'Put the bundle back at that path (or point NODE_EXTRA_CA_CERTS at the file that exists) and restart; the variable itself is already set.',
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

function relativeToCwd(cwd: string, filePath: string): string {
  return filePath.startsWith(cwd) ? filePath.slice(cwd.length).replace(/^[\\/]/, '') : filePath
}

function skillsRefusedCheck(): CheckSpec {
  return {
    id: 'skills-refused',
    label: 'Skill files',
    run: () => skillsRefusedEvidence(getCwd()),
  }
}

export async function runHealthReport(opts?: RunHealthReportOptions): Promise<HealthCertificate> {
  const t0 = Date.now()
  const cwd = getCwd()

  const git = await gitSnapshot({ fresh: true })
  const repo = git.state === 'live' ? git.data.git : null
  const head: CertHead = repo
    ? { sha: repo.commitHash, branch: repo.branchName, dirty: !repo.isClean }
    : { sha: null, branch: null, dirty: null }

  const version =
    typeof MACRO !== 'undefined' && typeof MACRO.VERSION === 'string' ? MACRO.VERSION : 'dev'

  const specs: SectionSpec[] = [
    {
      id: 'identity',
      title: 'IDENTITY',
      checks: [
        {
          id: 'build-identity',
          label: 'Mercury build',
          run: async () => {
            const identity = describeArtifactIdentity(version)
            const profile = isMercurySubstrateProfileOn()
            const [{ resolveSplashAsset }, { runningBundlePayloadDir }] = await Promise.all([
              import('../substrate/directSplash.js'),
              import('../services/privateChannel/vendoredRuntime.js'),
            ])
            const splash = resolveSplashAsset({ bundleDir: runningBundlePayloadDir(), home: getMercuryHome() })
            const splashWords =
              splash === null
                ? 'splash asset absent (a direct start boots plain)'
                : `splash asset ${splash.rung === 'payload' ? 'beside the bundle' : splash.rung === 'home' ? 'in the config home' : 'in the source tree'}`
            return {
              status: 'ok',
              evidence: `${artifactIdentityLine(identity)} · substrate profile ${profile ? 'on' : 'off'} · ${splashWords}`,
            }
          },
        },
        {
          id: 'client-contract',
          label: 'Client contract',
          run: async () => {
            const { describeAnthropicClientContract } = await import('../constants/oauth.js')
            const contract = describeAnthropicClientContract()
            const source =
              contract.source === 'override'
                ? 'MERCURY_ANTHROPIC_CLIENT_CONTRACT override'
                : 'built-in constant · MERCURY_ANTHROPIC_CLIENT_CONTRACT=<version> overrides'
            if (contract.ignoredOverride !== undefined) {
              return {
                status: 'warn',
                evidence: `subscription door presents cc_version ${contract.presented} (${source}) — MERCURY_ANTHROPIC_CLIENT_CONTRACT=${contract.ignoredOverride} ignored: not a three-part version`,
                fix: 'set MERCURY_ANTHROPIC_CLIENT_CONTRACT to a three-part version such as 2.1.257, or unset it',
              }
            }
            return {
              status: 'ok',
              evidence: `subscription door presents cc_version ${contract.presented} (${source})`,
            }
          },
        },
        {
          id: 'install-provenance',
          label: 'Install provenance',
          run: async () => {
            const { resolveInstallProvenance, provenanceGuidance, provenanceLine } = await import(
              '../services/privateChannel/installProvenance.js'
            )
            const p = resolveInstallProvenance()
            if (p.kind === 'unknown' || p.disagreements.length > 0) {
              return {
                status: 'warn',
                evidence: `${provenanceLine(p)} — ${p.evidence.join(' · ')}`,
                fix: provenanceGuidance(p),
              }
            }
            return {
              status: 'ok',
              evidence: `${provenanceLine(p)} · ${provenanceGuidance(p)}`,
            }
          },
        },
        {
          id: 'artifact-signature',
          label: 'Artifact signature',
          run: async () => {
            const { resolveInstallProvenance } = await import('../services/privateChannel/installProvenance.js')
            const { artifactSignatureCheck } = await import('../services/privateChannel/artifactVerify.js')
            return artifactSignatureCheck(resolveInstallProvenance(), 'fast')
          },
        },
        {
          id: 'artifact-signature-payload',
          label: 'Payload signature',
          depth: 'deep',
          probe: 'functional',
          timeoutMs: 30_000,
          run: async () => {
            const { resolveInstallProvenance } = await import('../services/privateChannel/installProvenance.js')
            const { artifactSignatureCheck } = await import('../services/privateChannel/artifactVerify.js')
            return artifactSignatureCheck(resolveInstallProvenance(), 'deep')
          },
        },
        {
          id: 'wrapper',
          label: 'Mercury doctrine',
          run: () => {
            if (!mercuryDoctrineEnabled()) {
              return {
                status: 'off',
                evidence: 'MERCURY_WRAPPER_APPEND=0 — the doctrine layer is off this session by choice',
              }
            }
            return {
              status: 'ok',
              evidence: `doctrine on — built-in source, ${MERCURY_DOCTRINE.length} chars`,
            }
          },
        },
        {
          id: 'build-fresh',
          label: 'Running build',
          run: async () => {
            const entry = process.argv[1]
            if (!entry || !existsSync(entry)) {
              return {
                status: 'unknown',
                evidence: `entry bundle not statable (argv[1]=${entry ?? 'unset'})`,
              }
            }
            const entryMtime = statSync(entry).mtimeMs
            const root = dirname(dirname(entry))
            if (!existsSync(join(root, 'build.ts')) || !existsSync(join(root, 'src'))) {
              return {
                status: 'info',
                evidence: `running ${basename(entry)} from an installed location (no source checkout above it) — build freshness n/a`,
              }
            }
            const stampPath = join(dirname(entry), '.build-tree')
            if (existsSync(stampPath)) {
              try {
                const stamped = (await readFile(stampPath, 'utf8')).trim()
                const current = await computeWorkingTreeSha(root)
                if (stamped.length > 0 && current !== null && stamped === current) {
                  return {
                    status: 'ok',
                    evidence: `bundle content-bound — built from exactly this source tree (${stamped.slice(0, 7)})`,
                  }
                }
              } catch {
              }
            }
            const ct = await execGit(['log', '-1', '--format=%ct', '--', 'src', 'build.ts'], root)
            const commitSec = ct ? Number.parseInt(ct, 10) : Number.NaN
            if (!Number.isFinite(commitSec)) {
              return {
                status: 'unknown',
                evidence: `source checkout at ${root} but the last-src-commit probe returned nothing`,
              }
            }
            const commitMs = commitSec * 1000
            if (entryMtime < commitMs) {
              const bun = process.env.BUN || join(homedir(), '.bun', 'bin', 'bun')
              return {
                status: 'stale',
                evidence: `bundle built ${formatAge(Date.now() - entryMtime)}, but src/ last changed ${formatAge(Date.now() - commitMs)} (committed) — the running build predates the source`,
                fix: 'Rebuild: bun run build.ts (then relaunch).',
                ...(healthFixEnabled()
                  ? {
                      remedy: {
                        plan: `rebuild dist (${bun} run build.ts in ${root}, ~40s) — this session keeps the old bundle until relaunch`,
                        class: 'safe' as const,
                        apply: async () => {
                          const res = await runRemedyCmd(bun, ['run', 'build.ts'], root, 5 * 60_000)
                          return res.status === 0
                            ? { ok: true, note: 'build.ts exited 0' }
                            : { ok: false, note: `build exited ${res.status}: ${res.tail.slice(-200)}` }
                        },
                        verify: async () => {
                          const stamp = join(dirname(entry), '.build-tree')
                          if (existsSync(stamp)) {
                            const stamped = (await readFile(stamp, 'utf8')).trim()
                            const current = await computeWorkingTreeSha(root)
                            if (stamped && current && stamped === current) {
                              return { ok: true, note: 'rebuilt bundle is content-bound to this source tree — relaunch to run it' }
                            }
                          }
                          const fresh = statSync(entry).mtimeMs
                          return fresh >= commitMs
                            ? { ok: true, note: `bundle now newer than the last src commit (rebuilt ${formatAge(Date.now() - fresh)}) — relaunch to run it` }
                            : { ok: false, note: 'bundle still predates the last src commit' }
                        },
                      },
                    }
                  : {}),
              }
            }
            return {
              status: 'ok',
              evidence: `bundle (${formatAge(Date.now() - entryMtime)}) is newer than the last committed src change (${formatAge(Date.now() - commitMs)})`,
            }
          },
        },
        {
          id: 'deployed-assets',
          label: 'Deployed assets',
          run: async () => {
            const entry = process.argv[1]
            const root = entry ? dirname(dirname(entry)) : null
            if (
              !root ||
              !existsSync(join(root, 'build.ts')) ||
              !existsSync(join(root, 'scripts', 'ops', 'launcher-mercury.sh'))
            ) {
              return {
                status: 'info',
                evidence: 'no source checkout above the running bundle — deployed-asset drift n/a',
              }
            }
            const home = getMercuryHome()
            const a = assessDeployedAssets(root, home)
            return {
              status: a.status,
              evidence: a.evidence,
              ...(a.fix ? { fix: a.fix } : {}),
              ...(healthFixEnabled() && a.drifted.length > 0
                ? {
                    remedy: {
                      plan: `redeploy ${a.drifted.map(d => d.label).join(' + ')} (${a.drifted.map(d => d.redeploy).join(' && ')} in ${root})`,
                      class: 'safe' as const,
                      apply: async () => {
                        for (const d of a.drifted) {
                          const argv = d.redeploy.split(' ')
                          const res = await runRemedyCmd(argv[0]!, argv.slice(1), root, 60_000)
                          if (res.status !== 0) {
                            return { ok: false, note: `${d.label} redeploy exited ${res.status}: ${res.tail.slice(-200)}` }
                          }
                        }
                        return { ok: true, note: 'redeploy script(s) exited 0' }
                      },
                      verify: async () => {
                        const after = assessDeployedAssets(root, home)
                        return after.drifted.length === 0
                          ? { ok: true, note: 'deployed copies byte-match the repo canon' }
                          : { ok: false, note: `still drifted: ${after.drifted.map(d => d.label).join(', ')}` }
                      },
                    },
                  }
                : {}),
            }
          },
        },
      ],
    },
    {
      id: 'proofs',
      title: 'PROOFS',
      checks: [
        {
          id: 'gate',
          label: 'Green gate',
          run: async () => {
            let verdictRaw: unknown = null
            try {
              verdictRaw = JSON.parse(await readFile(gateVerdictPath(), 'utf8'))
            } catch {
              verdictRaw = null
            }
            const verdict = decodeGateVerdict(verdictRaw)
            if (!existsSync(join(cwd, 'scripts', 'run-all-suites.sh'))) {
              return {
                status: 'info',
                evidence:
                  verdict === null
                    ? 'no proof-suite gate in this project (scripts/run-all-suites.sh absent)'
                    : 'a gate verdict artifact exists but this project has NO gate (scripts/run-all-suites.sh absent) — project-authored data is not certified as Mercury evidence',
              }
            }
            const currentTree = await computeWorkingTreeSha(cwd)
            const interpreted = interpretGateVerdict(
              verdict,
              { sha: head.sha, dirty: head.dirty, treeSha: currentTree },
              Date.now(),
            )
            const fixable =
              interpreted.status === 'stale' || interpreted.status === 'fail' || interpreted.status === 'warn'
            return {
              ...interpreted,
              ...(fixable && healthFixEnabled() && existsSync(join(cwd, 'scripts', 'run-all-suites.sh'))
                ? {
                    remedy: {
                      plan: 'run the full proof-suite gate (bash scripts/run-all-suites.sh, ~7 min) and re-read the verdict artifact',
                      class: 'safe' as const,
                      apply: async () => {
                        const res = await runRemedyCmd('bash', ['scripts/run-all-suites.sh'], cwd, 20 * 60_000)
                        return res.status === 0
                          ? { ok: true, note: 'gate exited 0 (all suites green)' }
                          : { ok: false, note: `gate exited ${res.status}: ${res.tail.slice(-200)}` }
                      },
                      verify: async () => {
                        try {
                          const raw = JSON.parse(await readFile(gateVerdictPath(), 'utf8'))
                          const v = interpretGateVerdict(
                            decodeGateVerdict(raw),
                            { sha: head.sha, dirty: head.dirty, treeSha: await computeWorkingTreeSha(cwd) },
                            Date.now(),
                          )
                          return v.status === 'ok'
                            ? { ok: true, note: v.evidence }
                            : { ok: false, note: `verdict still ${v.status}: ${v.evidence.slice(0, 140)}` }
                        } catch {
                          return { ok: false, note: 'verdict artifact unreadable after the run' }
                        }
                      },
                    },
                  }
                : {}),
            }
          },
        },
        {
          id: 'verification',
          label: 'Mutation evidence',
          run: async () => {
            try {
              const { verificationSummary } = await import('./verification/verificationState.js')
              const s = verificationSummary(cwd)
              const evidenceLine = s.lastEvidence
                ? `${s.detail} · last: ${s.lastEvidence.command.slice(0, 90)}`
                : s.detail
              switch (s.state) {
                case 'verified':
                  return { status: 'ok', evidence: evidenceLine }
                case 'failed':
                  return { status: 'fail', evidence: evidenceLine, fix: 'Fix the failure, then re-run the failing check or `bash scripts/run-all-suites.sh`.' }
                case 'stale':
                  return { status: 'stale', evidence: evidenceLine, fix: 'Re-run `bun run verify:fast`, or `bash scripts/run-all-suites.sh` for the release-level verdict.' }
                default:
                  return { status: 'info', evidence: evidenceLine }
              }
            } catch (e) {
              return { status: 'unknown', evidence: `verification state unreadable: ${String(e).slice(0, 120)}` }
            }
          },
        },
        {
          id: 'project-gates',
          label: 'Project gates',
          run: async () => {
            try {
              const { loadDeclaredGates } = await import('./verification/projectGates.js')
              const { workspaceVerifiable } = await import('./verification/verificationState.js')
              const declared = loadDeclaredGates(cwd)
              const godot = existsSync(join(cwd, 'project.godot'))
              const verifiable = workspaceVerifiable(cwd)
              const parts: string[] = []
              if (declared.length > 0) {
                parts.push(
                  `${declared.length} declared gate(s): ${declared
                    .map(g => (g.minRuns > 1 ? `${g.id}(soak ${g.minRuns})` : g.id))
                    .slice(0, 6)
                    .join(' · ')}`,
                )
              }
              if (godot) parts.push('Godot project (headless scene/parse gates recognized)')
              if (parts.length === 0) {
                return {
                  status: 'info',
                  evidence: verifiable
                    ? 'no declared gates — recognized machinery is command-family based (package.json scripts, suites, Make…)'
                    : 'no verification machinery discovered here (read-back is the evidence class)',
                }
              }
              return { status: 'ok', evidence: parts.join(' · ') }
            } catch (e) {
              return { status: 'unknown', evidence: `gate registry unreadable: ${String(e).slice(0, 120)}` }
            }
          },
        },
        {
          id: 'renders',
          label: 'Render-verify',
          run: async () => {
            const { renderTuiCheckoutRoot, renderTuiRuntime } = await import('../services/mcp/renderTuiTool.js')
            const root =
              renderTuiCheckoutRoot() ?? (existsSync(join(cwd, 'scripts', 'ui', 'render-tui.ts')) ? cwd : null)
            if (root === null) {
              return {
                status: 'info',
                evidence:
                  'not the harness source repo (scripts/ui/render-tui.ts absent beside this build and under the cwd) — render-verify n/a here; the render_tui tool answers unavailable',
              }
            }
            const vshot = join(root, 'scripts', 'ui', 'vshot.py')
            const runtime = renderTuiRuntime()
            const runtimeWords = 'bun' in runtime ? `bun at ${runtime.bun}` : runtime.missing
            const python = whichSync('python3') ?? whichSync('python')
            if (process.platform === 'win32') {
              return {
                status: 'info',
                evidence: `Windows source checkout — the POSIX render pipeline (vshot.py) does not run here${python ? ` (python present: ${python})` : ''}`,
                fix: 'Capture UI frames via scripts/winreg locally, or the hosted windows-ui workflow.',
              }
            }
            if (!python) {
              return {
                status: 'warn',
                evidence: `render-tui.ts ${existsSync(vshot) ? '+ vshot.py ' : ''}present at ${root} but no python on PATH — UI claims cannot be render-verified`,
                fix: 'Install Python 3, or point MERCURY_PYTHON at one — the PTY renderer needs it.',
              }
            }
            if ('missing' in runtime) {
              return {
                status: 'warn',
                evidence: `render pipeline present at ${root} · python at ${python} · ${runtime.missing} — the render_tui tool answers unavailable until bun is found`,
                fix: 'Install bun (~/.bun/bin/bun), put it on PATH, or point BUN at one — the render script runs under it.',
              }
            }
            return {
              status: 'ok',
              evidence: `render pipeline present at ${root} (render-tui.ts${existsSync(vshot) ? ' + vshot.py' : ''}) · python at ${python} · ${runtimeWords}`,
            }
          },
        },
      ],
    },
    {
      id: 'git',
      title: 'GIT',
      checks: [
        {
          id: 'git',
          label: 'Working tree',
          run: () => {
            if (git.state === 'unavailable' || repo === null) {
              return {
                status: 'info',
                evidence: git.reason ?? 'not a git repository',
              }
            }
            if (git.state !== 'live') {
              return {
                status: 'unknown',
                evidence: git.reason ?? 'git probe failed',
              }
            }
            const parts = [
              `${branchChip(repo.branchName)} @ ${sha7(repo.commitHash)}`,
              repo.isClean ? 'clean' : 'uncommitted changes',
            ]
            if (repo.unpushedCount > 0) parts.push(`${repo.unpushedCount} unpushed`)
            else if (repo.remoteUrl === null) parts.push('no remote configured')
            else if (!repo.isHeadOnRemote) parts.push('no upstream for this branch')
            const note = gitProbeNote()
            if (note !== null) return { status: 'warn', evidence: `${parts.join(' · ')} · ${note}` }
            return { status: 'ok', evidence: parts.join(' · ') + ' (getGitState)' }
          },
        },
        {
          id: 'home-repository',
          label: 'Home repository',
          probe: 'functional',
          run: () => homeRepositoryCheck(),
        },
        {
          id: 'project-estate',
          label: 'Project estate',
          probe: 'functional',
          run: () => projectEstateCheck(),
        },
      ],
    },
    {
      id: 'crew',
      title: 'CREW & DAEMONS',
      checks: [
        {
          id: 'config-home',
          label: 'Config home',
          run: () => {
            
            const home = getMercuryHome()
            const source = process.env.MERCURY_CONFIG_DIR
              ? 'explicit MERCURY_CONFIG_DIR'
              : process.env.MERCURY_HOME
                ? 'MERCURY_HOME'
                : 'Mercury default home resolution'
            const problems: string[] = []
            const svc = getMacOsKeychainStorageServiceName()
            const authHome = getAuthConfigHomeDir()
            if (!/-[0-9a-f]{8}$/.test(svc)) {
              problems.push(`keychain service '${svc}' is UN-suffixed for the auth home ${authHome} — credential identity split`)
            }
            const globalFile = getGlobalMercuryFile()
            if (!globalFile.startsWith(home)) {
              problems.push(`global config ${globalFile} lives OUTSIDE the resolved home — config identity split`)
            }
            const dDir = daemonDir()
            if (!flagEnv('MERCURY_DAEMON_DIR') && !dDir.startsWith(home)) {
              problems.push(`daemon dir ${dDir} outside the resolved home — daemon-plane split`)
            }
            if (!crashReportDir().startsWith(home)) {
              problems.push(`crash dir ${crashReportDir()} outside the resolved home — forensics split`)
            }
            if (problems.length > 0) {
              return { status: 'fail', evidence: problems.join(' · '), fix: 'The config home resolved two ways — report this with `mercury doctor --json`.' }
            }
            const slotNote = authHome !== home ? ` · auth scope slotted → ${authHome}` : ''
            const daemonNote = flagEnv('MERCURY_DAEMON_DIR')
              ? ` · daemon plane OVERRIDDEN → ${dDir} (MERCURY_DAEMON_DIR)`
              : ' · global config + daemon plane inside the home'
            return { status: 'ok', evidence: `${home} via ${source} · keychain …${svc.slice(-12)}${slotNote}${daemonNote}` }
          },
        },
        {
          id: 'transcript-store',
          label: 'Transcript store',
          run: async () => {
            const { getProjectsDir } = await import('./sessionStorage/paths.js')
            const { statSync, accessSync, readdirSync, constants } = await import('node:fs')
            const dir = getProjectsDir()
            let st: import('node:fs').Stats
            try {
              st = statSync(dir)
            } catch {
              return { status: 'ok' as const, evidence: `${dir} not yet created — the first session creates it` }
            }
            if (!st.isDirectory()) {
              return {
                status: 'fail' as const,
                evidence: `${dir} exists but is not a directory — session transcripts cannot be stored or resumed`,
                fix: 'Move or remove the file at <config-home>/projects so Mercury can recreate the transcript store.',
              }
            }
            try {
              accessSync(dir, constants.W_OK)
            } catch {
              return {
                status: 'fail' as const,
                evidence: `${dir} is not writable — new session transcripts cannot be recorded`,
                fix: 'Fix permissions on <config-home>/projects (check ownership and antivirus holds).',
              }
            }
            let projectCount = 0
            try {
              projectCount = readdirSync(dir).length
            } catch {
            }
            return { status: 'ok' as const, evidence: `${dir} · ${projectCount} project dir(s), writable` }
          },
        },
        {
          id: 'config-writes',
          label: 'Config writes',
          run: async () => {
            const { getConfigLocklessFallbackCount } = await import('./config/globalConfig.js')
            const n = getConfigLocklessFallbackCount()
            if (n === 0) {
              return {
                status: 'ok' as const,
                evidence: 'serialized under the config lock — 0 lockless fallbacks this session',
              }
            }
            return {
              status: 'warn' as const,
              evidence: `${n} config write(s) fell back to LOCKLESS this session — the lock could not be taken, and concurrent writes can race`,
              fix: 'Another instance may hold the config lock, or the lock directory cannot be created — check <config-home> permissions and other running Mercury processes.',
            }
          },
        },
        {
          id: 'scratch-leases',
          label: 'Scratch leases',
          run: async () => {
            const { listScratchLeftovers } = await import('./scratchLeases.js')
            const leftovers = listScratchLeftovers()
            if (leftovers.length === 0) {
              return { status: 'ok', evidence: 'no leftover scratch leases for this project' }
            }
            const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)}MB`
            const total = leftovers.reduce((a, l) => a + l.sizeBytes, 0)
            const rows = leftovers
              .slice(0, 5)
              .map(l => `${l.owner.kind}:${l.owner.id.slice(0, 12)} ${mb(l.sizeBytes)} ${l.root} (${l.recovery})`)
            return {
              status: 'warn',
              evidence: `${leftovers.length} leftover lease(s), ${mb(total)} total · ${rows.join(' · ')}`,
              fix: 'Delete exactly the named lease paths — never a broad /tmp sweep.',
            }
          },
        },
        {
          id: 'isolation',
          label: 'Store isolation',
          run: async () => {
            const home = getMercuryHome()
            const expectedVersion =
              typeof MACRO !== 'undefined' && typeof MACRO.VERSION === 'string' ? MACRO.VERSION : undefined
            let report: HarnessHomeReport
            try {
              report = await classifyHarnessHome(home, { expectedVersion })
            } catch {
              return { status: 'unknown', evidence: 'isolation probe read failed' }
            }
            if (report.foreign.length > 0) {
              const writers = [
                ...new Set(report.foreign.map(a => a.tool?.displayName ?? 'an unrecognized tool')),
              ]
              const archiveDest = join(
                home,
                'archive',
                `foreign-harness-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
              )
              return {
                status: 'warn',
                evidence: `foreign harness artifacts in ${home}: ${report.foreign.map(a => a.evidence).join(' · ')}`,
                fix: `${writers.join(' + ')} wrote harness-state into the Mercury home (a shell exported CLAUDE_CONFIG_DIR/MERCURY_CONFIG_DIR while another tool ran). Move or remove the foreign records.`,
                ...(healthFixEnabled()
                  ? {
                      remedy: {
                        plan: `move the foreign records to ${archiveDest} (reversible archive, nothing deleted)`,
                        class: 'safe' as const,
                        apply: async () => {
                          try {
                            await mkdir(archiveDest, { recursive: true })
                            const fresh = await classifyHarnessHome(home, { expectedVersion })
                            let movedCount = 0
                            for (const artifact of fresh.foreign) {
                              const src = harnessArtifactPath(home, artifact.rel)
                              const moved = await rename(src, join(archiveDest, artifact.rel.replace(/\//g, '_'))).then(
                                () => true,
                                () => false,
                              )
                              if (moved) movedCount++
                            }
                            return movedCount > 0
                              ? { ok: true, note: `archived ${movedCount} foreign record(s) → ${archiveDest}` }
                              : { ok: false, note: 'no foreign records matched at apply time (already clean?)' }
                          } catch (e) {
                            return { ok: false, note: `archive failed: ${e}` }
                          }
                        },
                        verify: async () => {
                          const after = await classifyHarnessHome(home, { expectedVersion })
                          return after.foreign.length === 0
                            ? { ok: true, note: 'no foreign-harness artifacts remain' }
                            : { ok: false, note: `still foreign: ${after.foreign.map(a => a.rel).join(', ')}` }
                        },
                      },
                    }
                  : {}),
              }
            }
            const staleNote =
              report.oursStale.length > 0 ? ` · ${report.oursStale.map(a => a.evidence).join(' · ')}` : ''
            return { status: 'ok', evidence: `no foreign-harness artifacts in ${home}${staleNote}` }
          },
        },
        {
          id: 'daemon-sign-ins',
          label: 'Daemon sign-in view',
          run: async () => {
            const d = daemonSnapshot()
            if (d.state !== 'live') {
              return { status: 'off', evidence: `no live daemon to compare with — ${d.reason}`, link: '/daemon' }
            }
            const { daemonControlRpc, restartDaemonWords } = await import('../daemon/controlSocket.js')
            const { compareSignInViews, composeSignInView, summarizeSignInView } = await import('../daemon/signInView.js')
            const reply = (await daemonControlRpc({ op: 'signIns' } as never, { timeoutMs: 3000 })) as
              | { ok: true; view: DaemonSignInViewV1 }
              | { ok: false; code?: string; error?: string }
            const restart = restartDaemonWords(binaryName())
            if (!reply.ok) {
              return {
                status: 'warn',
                evidence: `the daemon did not answer signIns (${reply.code ?? '?'}${reply.error ? `: ${reply.error}` : ''}) — a daemon of an older build`,
                fix: `${restart} — the successor answers the sign-in verb.`,
                link: '/daemon',
              }
            }
            const mine = composeSignInView()
            const gaps = compareSignInViews(mine, reply.view)
            const sameEstate = reply.view.home === mine.home && reply.view.store === mine.store
            const where = `daemon read ${reply.view.store} in ${reply.view.home}; this process reads ${mine.store} in ${mine.home}`
            if (gaps.length === 0 && sameEstate) {
              return { status: 'ok', evidence: `daemon and client agree — ${summarizeSignInView(reply.view)} · ${where}`, link: '/daemon' }
            }
            const named = gaps.map(g => `${g.family}: client ${g.client} vs daemon ${g.daemon}`).join('; ')
            const lists = `daemon: [${summarizeSignInView(reply.view)}] · client: [${summarizeSignInView(mine)}]`
            return {
              status: 'fail',
              evidence: `daemon ≠ client${named !== '' ? ` — ${named}` : ' — different home or store'} · ${lists} · ${where}`,
              fix: `${restart} — a restarted daemon reads the estate this screen reads; a gap that stands means the two run on different homes, stores or env keys (the evidence names both).`,
              link: '/daemon',
            }
          },
        },
        {
          id: 'daemon',
          label: 'Scheduler daemon',
          run: async () => {
            const d = daemonSnapshot()
            if (d.state === 'live') {
              const { daemonHandshakeEvidence, handshakeDaemon } = await import('../daemon/handshake.js')
              const hs = await handshakeDaemon({ timeoutMs: 1000 })
              const evidence = `supervisor.json: ${d.reason} · ${daemonHandshakeEvidence(hs)}`
              if (hs.line !== null) return { status: 'warn', evidence, fix: hs.line, link: '/daemon' }
              return { status: 'ok', evidence, link: '/daemon' }
            }
            let receipt = ''
            try {
              const { reconcileDaemonRecords } = await import('../daemon/reconcileRecords.js')
              const rec = await reconcileDaemonRecords()
              if (rec.state === 'reconciled' && rec.cleaned.length > 0) {
                receipt = `reconciled stale records: removed ${rec.cleaned.join(', ')}${
                  rec.deadPid != null ? ` (pid ${rec.deadPid} gone)` : ''
                }`
              }
            } catch {
            }
            if (d.state === 'unavailable') {
              if (receipt) {
                return { status: 'ok', evidence: `${receipt} · daemon off (opt-in)`, link: '/daemon' }
              }
              return {
                status: 'warn',
                evidence: `supervisor.json: ${d.reason}`,
                fix: `Run \`${binaryName()} daemon\` to restart, or clear the stale record.`,
                link: '/daemon',
              }
            }
            return {
              status: 'off',
              evidence: `no supervisor record — ${d.reason}${receipt ? ` · ${receipt}` : ''}`,
              link: '/daemon',
            }
          },
        },
        {
          id: 'history',
          label: 'Prompt history appends',
          run: () => {
            const h = getHistoryFlushHealth()
            const storePath = join(getMercuryHome(), 'history.jsonl')
            try {
              if (existsSync(storePath) && statSync(storePath).isDirectory()) {
                return {
                  status: 'warn',
                  evidence: 'history.jsonl is a DIRECTORY — no append can land; the per-process counters cannot see this from a one-shot run',
                  fix: 'Remove the directory at <config-home>/history.jsonl (prompts recorded elsewhere are unaffected).',
                }
              }
            } catch {
            }
            if (h.streak >= 3) {
              return {
                status: 'warn',
                evidence: `history.jsonl flush failing — streak ${h.streak}, ${h.pending} pending: ${h.lastFailure?.message ?? 'unknown'}`,
                fix: 'Prompts are safe in memory this session. Check permissions or antivirus holds on <config-home>/history.jsonl.',
              }
            }
            const historyPath = join(getMercuryHome(), 'history.jsonl')
            try {
              if (existsSync(historyPath) && statSync(historyPath).isDirectory()) {
                return {
                  status: 'fail',
                  evidence: 'history.jsonl is a DIRECTORY — every append fails',
                  fix: 'Remove the directory at <config-home>/history.jsonl; the next prompt recreates the file.',
                }
              }
            } catch {  }
            const lockDir = join(getMercuryHome(), 'history.jsonl.lock')
            if (existsSync(lockDir)) {
              let ageMs: number | null = null
              try {
                ageMs = Date.now() - statSync(lockDir).mtimeMs
              } catch {  }
              if (ageMs !== null && ageMs > 30_000) {
                return {
                  status: 'warn',
                  evidence: `history.jsonl.lock is ${Math.round(ageMs / 1000)}s old — it should have self-cleared by now`,
                  fix: 'If it persists with no other Mercury process running, delete the lock dir.',
                }
              }
            }
            return {
              status: 'ok',
              evidence:
                h.pending === 0
                  ? h.lastFailure === null && h.streak === 0 && !historyEverFlushedThisProcess()
                    ? 'no append attempted this run · store path writable-shaped'
                    : 'appends healthy'
                  : `${h.pending} pending (flush scheduled)`,
            }
          },
        },
        {
          id: 'boot-beacon',
          label: 'Boots complete',
          run: () => {
            const residue = readBootAttemptResidue()
            if (residue && residue.count >= 3) {
              return {
                status: 'warn',
                evidence: `${residue.count} enter-screen handoff(s) since the last completed boot — latest ${formatAge(Date.now() - residue.lastTs)}`,
                fix: '`mercury update --rollback` returns to the previous version; `MERCURY_SPLASH=off mercury` boots without the enter screen. Include `mercury health --json` when reporting.',
              }
            }
            return {
              status: 'ok',
              evidence: residue
                ? `${residue.count} pending attempt(s) (a boot may be in flight or was cancelled mid-handoff)`
                : 'no pending attempts',
            }
          },
        },
        {
          id: 'launch-spine',
          label: 'Boot milestones',
          run: async () => {
            const { lastBootReachedInputLive, lastInteractiveBootSpine } = await import(
              '../substrate/launchMilestones.js'
            )
            const reached = lastBootReachedInputLive()
            if (reached === null) return { status: 'off', evidence: 'no interactive boot recorded yet' }
            const RANK: Record<string, number> = { 'runtime-entry': 0, 'route-ready': 1, 'first-frame': 2, 'input-live': 3 }
            const lastRungs = lastInteractiveBootSpine().map(r => r.milestone).filter(m => m in RANK)
            const spine = lastRungs.join(' → ')
            const ranks = lastRungs.map(m => RANK[m] ?? -1)
            const inOrder = ranks.every((r, i) => r >= 0 && (i === 0 || r > ranks[i - 1]!))
            if (reached && !inOrder) {
              return {
                status: 'warn',
                evidence: `last boot's spine fired OUT OF ORDER: ${spine}`,
                fix: 'The rungs must fire runtime-entry → route-ready → first-frame → input-live; an inverted spine means a stamp moved — include `mercury health --json` when reporting.',
              }
            }
            return reached
              ? { status: 'ok', evidence: `last boot: ${spine}` }
              : {
                  status: 'warn',
                  evidence: `last boot's spine truncated: ${spine || '(empty)'} — the process never reached input-live`,
                  fix: 'A boot that exits 0 before input is live is a launcher defect — include `mercury health --json` when reporting.',
                }
          },
        },
        {
          id: 'invocation-record',
          label: 'Invocation record',
          run: async () => {
            const { readInvocationRecords } = await import('../substrate/invocationRecord.js')
            const rows = readInvocationRecords()
            const last = rows[rows.length - 1]
            if (!last) return { status: 'off', evidence: 'no invocation recorded yet' }
            return {
              status: 'ok',
              evidence: `${last.platform} · ${last.shellHint} · tty in/out/err ${last.stdinTTY ? 'y' : 'n'}/${last.stdoutTTY ? 'y' : 'n'}/${last.stderrTTY ? 'y' : 'n'}${last.termProgram ? ` · ${last.termProgram}` : ''} (${rows.length} recorded)`,
            }
          },
        },
        {
          id: 'invocation-trace',
          label: 'Trace appends',
          run: async () => {
            const { getTraceFlushHealth, getInvocationTracePath, isInvocationTraceEnabled } =
              await import('./observability/invocationTrace.js')
            if (!isInvocationTraceEnabled()) {
              return { status: 'off', evidence: 'tracing off (MERCURY_TRACE/substrate profile)' }
            }
            const t = getTraceFlushHealth()
            if (t.streak >= 3) {
              return {
                status: 'warn',
                evidence: `mercury-trace.jsonl flush failing — streak ${t.streak}, ${t.pending} pending${t.dropped > 0 ? `, ${t.dropped} dropped at the buffer cap` : ''}: ${t.lastFailure?.message ?? 'unknown'}`,
                fix: 'Check permissions/AV holds on <config-home>/mercury-trace.jsonl; records keep buffering (bounded) until appends recover.',
              }
            }
            let ageNote = 'no records this session yet'
            if (t.lastWriteOkAt !== null) {
              ageNote = `last write ${Math.max(0, Math.round((Date.now() - t.lastWriteOkAt) / 1000))}s ago`
            } else {
              try {
                const mtime = statSync(getInvocationTracePath()).mtimeMs
                ageNote = `last write ${Math.max(0, Math.round((Date.now() - mtime) / 1000))}s ago (prior session)`
              } catch {
              }
            }
            return {
              status: 'ok',
              evidence:
                t.pending === 0
                  ? `appends healthy · ${ageNote}`
                  : `${t.pending} pending (flush scheduled) · ${ageNote}`,
            }
          },
        },
        {
          id: 'cache-clock',
          label: 'Usage metering',
          run: async () => {
            const { cacheClockSnapshot, getCacheClockFlushHealth } = await import(
              './cache/cacheClock.js'
            )
            const snap = cacheClockSnapshot()
            if (!snap.engaged) {
              return { status: 'off', evidence: 'clock not engaged this session' }
            }
            const c = getCacheClockFlushHealth()
            if (c.streak >= 3) {
              return {
                status: 'warn',
                evidence: `session rollup writes failing — streak ${c.streak}: ${c.lastFailure?.message ?? 'unknown'}`,
                fix: 'Check the project store (projects/<key>/cache-clock/sessions) for permissions/AV holds; metering state is safe in memory and rewrites whole on the next flush.',
              }
            }
            const age =
              c.lastRollupOkAt !== null
                ? `last rollup ${Math.max(0, Math.round((Date.now() - c.lastRollupOkAt) / 1000))}s ago`
                : 'no rollup written yet (flushes at 3 requests, then on cadence)'
            return { status: 'ok', evidence: `ttl ${snap.ttl ?? '?'} (${snap.cls ?? '?'}) · ${age}` }
          },
        },
        {
          id: 'activity',
          label: 'Activity counts',
          run: async () => {
            const { getHeadlessActivity } = await import('./activityLedger.js')
            const { getGlobalConfig } = await import('./config/globalConfig.js')
            const a = getHeadlessActivity()
            const startups = getGlobalConfig().numStartups ?? 0
            const last = a.lastAt > 0 ? `last headless ${new Date(a.lastAt).toISOString()} (${a.lastKind})` : 'no headless activity recorded'
            const verbs = Object.values(a.verbs ?? {}).reduce((sum, n) => sum + n, 0)
            return {
              status: 'ok',
              evidence: `interactive boots ${startups} · print ${a.print} · sdk ${a.sdk} · verbs ${verbs} · ${last}`,
            }
          },
        },
        {
          id: 'pid-lock-release',
          label: 'Lock releases',
          run: async () => {
            const { pidLockReleaseHealth } = await import('../substrate/pidLock.js')
            const h = pidLockReleaseHealth()
            if (h.notRemoved.count > 0) {
              const last = h.notRemoved.last
              return {
                status: 'warn',
                evidence: `${h.notRemoved.count} lock release(s) settled ${last?.outcome ?? 'non-removed'} this session${last ? ` — last: ${last.path} (${last.fsCode ?? 'unknown'}, ${last.attempts} attempts)` : ''}`,
                fix: 'A deferred lock is reclaimed by the next boot reconcile once its owner dies; persistent failures name a permissions/AV hold on the lock path.',
              }
            }
            const retried =
              h.retriedSuccesses.count > 0
                ? `releases healthy (${h.retriedSuccesses.count} saved by the bounded retry)`
                : 'releases healthy'
            return { status: 'ok', evidence: retried }
          },
        },
        {
          id: 'permission-posture',
          label: 'Permission posture',
          run: async () => {
            const { getCurrentProjectConfig } = await import('./config/projectConfig.js')
            const { flagEnv } = await import('../substrate/flagRegistry.js')
            const { isEnvTruthy } = await import('./envUtils.js')
            const posture = getCurrentProjectConfig().permissionPosture
            const envArmedNow = isEnvTruthy(flagEnv('MERCURY_SKIP_PERMISSIONS'))
            if (!posture) {
              if (envArmedNow) {
                return {
                  status: 'warn',
                  evidence:
                    'bypass is armed by the skip-permissions env row but NO posture record exists yet',
                  fix: 'Open Mercury interactively once — the boot records its permission composition.',
                }
              }
              return { status: 'ok', evidence: 'standard permissions (no bypass posture recorded)' }
            }
            const trust = posture.trustDialogAccepted ? 'trust dialog accepted' : 'trust dialog NOT accepted'
            if (posture.mode === 'bypass') {
              const armed =
                posture.armedBy === 'env-standing-consent'
                  ? 'armed by the skip-permissions env row (standing consent)'
                  : posture.armedBy === 'cli-flag'
                    ? 'armed by the CLI flag'
                    : 'armed by the session permission mode'
              const dialog =
                posture.consentDialog === 'suppressed-by-standing-consent'
                  ? 'consent dialog suppressed by settings'
                  : 'consent dialog shown and accepted'
              return { status: 'ok', evidence: `bypass — ${armed} · ${dialog} · ${trust}` }
            }
            return { status: 'ok', evidence: `standard permissions · ${trust}` }
          },
        },
        {
          id: 'lifecycle-collection',
          label: 'State cleanup',
          run: async () => {
            const { getLifecycleHealth } = await import('../substrate/stateLifecycle.js')
            const { statSync: statSentinel } = await import('node:fs')
            const { join: joinPath } = await import('node:path')
            const { getMercuryHome: homeDir } = await import('./envUtils.js')
            let sentinelAge: string
            try {
              const mtime = statSentinel(joinPath(homeDir(), '.last-cleanup')).mtimeMs
              const days = (Date.now() - mtime) / 86_400_000
              sentinelAge = days < 2 ? `last complete sweep ${Math.round(days * 24)}h ago` : `last complete sweep ${Math.round(days)}d ago`
            } catch {
              sentinelAge = 'no complete sweep recorded yet'
            }
            const pass = getLifecycleHealth()
            if (pass && pass.cycleFailures > 0) {
              const firstFailure = pass.receipts.flatMap(r => r.failures.map(f => `${r.id}: ${f.path}${f.code ? ` (${f.code})` : ''}`))[0]
              return {
                status: 'warn',
                evidence: `collection failing — ${pass.cycleFailures} failure(s) this cycle${firstFailure ? `; first: ${firstFailure}` : ''} · ${sentinelAge}`,
                fix: 'Check permissions/AV holds on the named path; the sentinel is withheld until a cycle completes clean, so the sweep keeps retrying on its cadence.',
              }
            }
            const passNote = pass
              ? `last pass removed ${pass.removed}, ${pass.cycleComplete ? 'cycle complete' : 'cursor mid-cycle'}`
              : 'no pass this session'
            return { status: 'ok', evidence: `${passNote} · ${sentinelAge}` }
          },
        },
        {
          id: 'image-decode',
          label: 'Inline image decode',
          run: async () => {
            const { detectImageProtocol } = await import(
              '../services/visual/imageDisplay.js'
            )
            const tier = detectImageProtocol()
            try {
              await import('sharp')
              return {
                status: 'ok',
                evidence: `native decode available · detected tier: ${tier}`,
              }
            } catch (e) {
              return {
                status: 'warn',
                evidence: `images render as file links on this install — native decode unavailable (${(e as Error)?.message?.slice(0, 120) ?? 'import failed'}); detected tier: ${tier}`,
                fix: 'Reinstall via `mercury update` to restore the bundled image binding; iTerm2, WezTerm and kitty render PNGs natively regardless.',
              }
            }
          },
        },
        {
          id: 'agent-definitions',
          label: 'Agent definitions',
          run: async () => {
            const { existsSync, readdirSync } = await import('node:fs')
            const { join } = await import('node:path')
            const { getMercuryHome } = await import('./envUtils.js')
            const { adoptiveProjectPath } = await import('./projectStoreAdoption.js')
            const { getOriginalCwd } = await import('../bootstrap/state.js')
            const userDir = join(getMercuryHome(), 'agents')
            let projectDir = ''
            try {
              projectDir = adoptiveProjectPath(getOriginalCwd(), 'agents')
            } catch {
            }
            const countMd = (dir: string): number | null => {
              try {
                if (!dir || !existsSync(dir)) return null
                return readdirSync(dir).filter(f => f.endsWith('.md')).length
              } catch {
                return null
              }
            }
            const user = countMd(userDir)
            const project = countMd(projectDir)
            const parts = [
              user === null ? 'user dir absent' : `user ${user} .md file(s)`,
              project === null ? 'project dir absent' : `project ${project} .md file(s)`,
            ]
            return {
              status: 'info',
              evidence: `${parts.join(' · ')} — files on disk; a nameless .md is a reference document, so the loaded roster (mercury agents) can be smaller`,
            }
          },
        },
        {
          id: 'team-rosters',
          label: 'Agent group roster cwds',
          run: async () => {
            const { existsSync, readdirSync, readFileSync } = await import('node:fs')
            const { join } = await import('node:path')
            const { getMercuryHome } = await import('./envUtils.js')
            const teamsDir = join(getMercuryHome(), 'teams')
            if (!existsSync(teamsDir)) {
              return { status: 'off' as const, evidence: 'no teams directory — nothing spawns' }
            }
            const dead: string[] = []
            let teams = 0
            for (const team of readdirSync(teamsDir)) {
              const cfg = join(teamsDir, team, 'config.json')
              if (!existsSync(cfg)) continue
              teams++
              try {
                const parsed = JSON.parse(readFileSync(cfg, 'utf8')) as {
                  members?: { agentId?: string; cwd?: string }[]
                }
                for (const m of parsed.members ?? []) {
                  if (m.cwd && !existsSync(m.cwd)) dead.push(`${team}/${m.agentId ?? '?'} → ${m.cwd}`)
                }
              } catch {
                dead.push(`${team}: config.json unreadable`)
              }
            }
            if (dead.length === 0) {
              return {
                status: 'ok' as const,
                evidence: `${teams} team roster(s) — every member cwd exists`,
              }
            }
            return {
              status: 'warn' as const,
              evidence: `${dead.length} roster member(s) point at a DEAD cwd: ${dead.slice(0, 3).join(' · ')}${dead.length > 3 ? ' · …' : ''}`,
              fix: 'Fix the cwd or archive the team directory — spawn paths refuse dead-cwd rosters.',
            }
          },
        },
        {
          id: 'fleet',
          label: 'Coordination',
          run: async () => {
            const fleet = await fleetGauge()
            if (fleet.state === 'off') {
              return { status: 'off', evidence: fleet.reason ?? 'not in a team — solo session' }
            }
            if (fleet.state !== 'live') {
              return { status: 'unknown', evidence: fleet.reason ?? 'coordination read failed' }
            }
            const live = fleet.data.health.filter(a => a.state !== 'idle').length
            const conflicts = fleet.data.conflicts.length
            const evidence = `team "${fleet.data.teamName}" · ${fleet.data.health.length} agents · ${live} active · ${fleet.data.leases.length} leases · ${conflicts} conflicts`
            if (conflicts > 0) {
              return {
                status: 'warn',
                evidence,
                fix: 'Resolve the conflicting leases in /fleet before the agents collide.',
                link: '/fleet',
              }
            }
            return { status: 'ok', evidence, link: '/fleet' }
          },
        },
        {
          id: 'seats',
          label: 'Seats',
          run: async () => {
            const { seatCeilingFacts, seatCeilingValueWords, seatCostWarning } = await import('../services/switchboard/capacityCheck.js')
            const { liveCeilingFacts, composeGovernorCeilings, composeProvenance } = await import('../services/capacity/composeCeilings.js')
            const { seatNarrowingWords } = await import('../services/capacity/seatWords.js')
            const facts = seatCeilingFacts()
            const live = liveCeilingFacts(null)
            const composed = composeGovernorCeilings(live)
            const provenance = composeProvenance(live, composed)
            const narrowed = seatNarrowingWords(provenance.narrowing)
            const warning = seatCostWarning(facts)
            const lanes = `${composed.delegationLanes} delegated lane${composed.delegationLanes === 1 ? '' : 's'} for the crew`
            return {
              status: narrowed !== null || warning !== null ? 'info' : 'ok',
              evidence: `${seatCeilingValueWords(facts)} · ${facts.readingSentence} · ${lanes}${narrowed !== null ? ` — ${narrowed}` : ' (the seats)'}`,
              detail: `Sessions, sub-agents and workflow agents all run under this one number; a seat is held only while a model call is in flight, and a call past the ceiling waits with its row saying so.${warning !== null ? ` ${warning}.` : ''} Setting: ${facts.lever}.`,
            }
          },
        },
        {
          id: 'spawn-switches',
          label: 'Sub-agents & workflows',
          run: async () => {
            const { spawnSwitchFacts, spawnSwitchLine } = await import('../services/switchboard/spawnSwitches.js')
            const { getFocusedSessionConnector, hasFocusedSession } = await import('../services/engine-connector/focusedConnector.js')
            const focused = hasFocusedSession()
            const facts = focused ? getFocusedSessionConnector().spawnSwitches() : spawnSwitchFacts()
            const scope = focused ? 'the focused session' : 'this process — the next session is born with these'
            const anyOff = !facts.subagents.on || !facts.workflows.on
            return {
              status: anyOff ? 'info' : 'ok',
              evidence: `${spawnSwitchLine('subagents', facts.subagents)} · ${spawnSwitchLine('workflows', facts.workflows)} — ${scope}`,
              detail: 'Flip a running session with /subagents on|off and /workflows on|off (at its next turn boundary); the boot menu\'s Agents section sets the next session\'s default. Off: the Agent or Workflow tool is absent from the roster and every spawn road answers one receipt.',
              link: '/bootmenu',
            }
          },
        },
        {
          id: 'workflows',
          label: 'Workflows',
          run: async () => {
            if (!flagEnabled('MERCURY_WORKFLOWS')) {
              return { status: 'off', evidence: 'MERCURY_WORKFLOWS=0 — the workflow engine is disabled' }
            }
            const { rows: runs, unreadable } = await listWorkflowRunsDetailed(cwd)
            if (runs.length === 0) {
              return {
                status: 'ok',
                evidence: `engine on · no runs recorded under ${relative(getCwd(), workflowRunsRoot(getCwd()))}`,
                link: '/workflows',
              }
            }
            const now = Date.now()
            const orphans = runs.filter(r => isRunOrphaned(r, r.mtimeMs, now, p => pidAlive(p)))
            const running = runs.filter(
              r => (r.status === 'running' || r.status === 'paused') && !orphans.includes(r),
            )
            const evidence = `${runs.length} run manifests · ${running.length} running · ${orphans.length} orphaned${
              unreadable > 0 ? ` · ${unreadable} UNREADABLE (partial listing)` : ''
            }`
            if (unreadable > 0) {
              return {
                status: 'warn',
                evidence,
                fix: 'Some run manifests could not be read (fd limits/permissions) — counts above are lower bounds.',
                link: '/workflows',
              }
            }
            if (orphans.length > 0) {
              return {
                status: 'warn',
                evidence,
                fix: 'Inspect the orphaned runs in /workflows (kill/resume) — they will never finish on their own.',
                link: '/workflows',
              }
            }
            return { status: 'ok', evidence, link: '/workflows' }
          },
        },
      ],
    },
    {
      id: 'memory',
      title: 'MEMORY & CONTEXT',
      checks: [
        {
          id: 'memory',
          label: 'Memory index',
          run: async () => {
            const memPath = getAutoMemPath()
            const indexPath = join(memPath, ENTRYPOINT_NAME)
            if (!existsSync(indexPath)) {
              return {
                status: 'info',
                evidence: `no ${ENTRYPOINT_NAME} yet at ${memPath} — memory starts on first save`,
              }
            }
            const raw = readFileSync(indexPath, 'utf8')
            const lines = raw.split('\n').length
            const bytes = Buffer.byteLength(raw, 'utf8')
            const linePct = Math.round((lines / MAX_ENTRYPOINT_LINES) * 100)
            const cards = experienceCardsEnabled() ? await listExperienceCards(memPath) : []
            const candidates = cards.filter(c => !c.meta.approved).length
            const recall = flagEnv('MERCURY_RELEVANT_RECALL') === '1' ? 'on' : 'off'
            const evidence = `${ENTRYPOINT_NAME} ${lines}/${MAX_ENTRYPOINT_LINES} lines · ${(bytes / 1000).toFixed(1)}/${(MAX_ENTRYPOINT_BYTES / 1000).toFixed(0)}KB · cards ${cards.length - candidates} approved · ${candidates} candidate · recall ${recall}`
            if (lines > MAX_ENTRYPOINT_LINES || bytes > MAX_ENTRYPOINT_BYTES) {
              return {
                status: 'warn',
                evidence,
                fix: `The index EXCEEDS its injection cap — everything past ${MAX_ENTRYPOINT_LINES} lines/${(MAX_ENTRYPOINT_BYTES / 1000).toFixed(0)}KB is silently not loaded. Compact ${ENTRYPOINT_NAME}.`,
              }
            }
            if (linePct >= 90 || bytes >= MAX_ENTRYPOINT_BYTES * 0.9) {
              return {
                status: 'warn',
                evidence,
                fix: `The index is at ${Math.max(linePct, Math.round((bytes / MAX_ENTRYPOINT_BYTES) * 100))}% of its injection cap — compact ${ENTRYPOINT_NAME} before pointers start dropping.`,
              }
            }
            if (candidates > 0) {
              return {
                status: 'info',
                evidence,
                fix: 'Review + promote candidate cards with /cards (p to promote).',
                link: '/cards',
              }
            }
            return { status: 'ok', evidence }
          },
        },
        {
          id: 'memory-verbs',
          label: 'Memory verbs',
          run: async () => {
            const { memoryVerbsEnabled, memoryVerbsWhyNot } = await import('../memdir/memoryVerbs.js')
            const { mnemeStatus } = await import('../memdir/mnemeMaintenance.js')
            if (!memoryVerbsEnabled()) {
              return {
                status: 'off',
                evidence: `Retain/Recall/Reflect/Correct absent — ${memoryVerbsWhyNot() ?? 'unknown'}`,
              }
            }
            const status = mnemeStatus()
            return {
              status: 'ok',
              evidence: `Retain/Recall/Reflect/Correct live · buffer ${status.buffered} · ${status.topicCount} topic doc(s) · ${status.entryCount} entr(ies)`,
            }
          },
        },
        {
          id: 'context',
          label: 'Context & resume',
          run: () => {
            const usage = getLiveContextUsage()
            const arms = [
              `keep-tail ${isMercuryCompactKeepTailEnabled() ? 'on' : 'off'}`,
              `away-summary ${isAwaySummaryEnabled() ? 'on' : 'off'}`,
              `carry-forward ${flagEnabled('MERCURY_CARRY_FORWARD') ? 'on' : 'off'}`,
              `forecast ${ctxForecastEnabled() ? 'on' : 'off'}`,
            ].join(' · ')
            if (usage.usedPct === null) {
              return {
                status: 'info',
                evidence: `no context sample published yet this session · resume arms: ${arms}`,
              }
            }
            const compactAt = usage.compactAtPct
            const evidence = `context ${usage.usedPct.toFixed(0)}% of ${Math.round(usage.window / 1000)}k${compactAt !== null ? ` · autocompact at ${compactAt}%` : ''} · ${arms}`
            if (compactAt !== null && usage.usedPct >= compactAt - 5) {
              return {
                status: 'warn',
                evidence,
                fix: 'Autocompact is imminent — bank anything load-bearing (todo/memory) before the squeeze.',
              }
            }
            return { status: 'ok', evidence }
          },
        },
        {
          id: 'preserved-thinking',
          label: 'Preserved thinking',
          run: async () => {
            const { preservedThinkingHealth, readThinkingDropLedger } = await import(
              '../services/providers/anthropic/thinkingBinding.js'
            )
            return preservedThinkingHealth(readThinkingDropLedger())
          },
        },
      ],
    },
    {
      id: 'settings',
      title: 'SETTINGS & FLAGS',
      checks: [
        {
          id: 'settings',
          label: 'Settings',
          run: () => {
            const { errors } = getSettingsWithAllErrors()
            let sourcesLine = 'sources unreadable'
            try {
              sourcesLine = `sources: ${getEnabledSettingSources().join(' + ')}`
            } catch {
            }
            let lockLine = ''
            try {
              const lock = getSettingsForSource('policySettings')?.strictExtensionOnlyCustomization
              if (lock === true) lockLine = ' · managed extension-only lock: ALL surfaces'
              else if (Array.isArray(lock) && lock.length > 0) lockLine = ` · managed extension-only lock: ${lock.join(', ')}`
            } catch {
            }
            if (errors.length === 0) {
              return {
                status: 'ok',
                evidence: `${sourcesLine}${lockLine} · 0 validation errors (getSettingsWithAllErrors)`,
              }
            }
            const first = errors[0]
            const firstLine = first
              ? [first.file, first.path, first.message].filter(Boolean).join(' · ')
              : 'unreadable'
            return {
              status: 'warn',
              evidence: `${errors.length} settings validation error(s) — first: ${firstLine.slice(0, 120)}`,
              fix: 'Fix the named settings file; run /health again for the refreshed list.',
            }
          },
        },
        {
          id: 'env-limits',
          label: 'Env output limits',
          run: async () => {
            const { validateBoundedIntEnvVar } = await import('./envValidation.js')
            const { BASH_MAX_OUTPUT_DEFAULT, BASH_MAX_OUTPUT_UPPER_LIMIT } = await import(
              './shell/outputLimits.js'
            )
            const { TASK_MAX_OUTPUT_DEFAULT, TASK_MAX_OUTPUT_UPPER_LIMIT } = await import(
              './task/outputFormatting.js'
            )
            const rows: Array<[string, number, number]> = [
              ['BASH_MAX_OUTPUT_LENGTH', BASH_MAX_OUTPUT_DEFAULT, BASH_MAX_OUTPUT_UPPER_LIMIT],
              ['TASK_MAX_OUTPUT_LENGTH', TASK_MAX_OUTPUT_DEFAULT, TASK_MAX_OUTPUT_UPPER_LIMIT],
            ]
            const findings: string[] = []
            for (const [name, def, cap] of rows) {
              const r = validateBoundedIntEnvVar(name, process.env[name], def, cap)
              if (r.status !== 'valid' && r.message) findings.push(`${name}: ${r.message}`)
            }
            if (findings.length === 0) {
              return { status: 'ok', evidence: 'output-limit env rows unset or within bounds' }
            }
            return { status: 'warn', evidence: findings.join(' · ').slice(0, 200) }
          },
        },
        {
          id: 'keybindings',
          label: 'Keybindings',
          run: async () => {
            const { loadKeybindingsSyncWithWarnings } = await import('../keybindings/loadUserBindings.js')
            const warnings = loadKeybindingsSyncWithWarnings().warnings
            if (warnings.length === 0) {
              return { status: 'ok', evidence: 'no keybinding-file warnings this session' }
            }
            return {
              status: 'warn',
              evidence: `${warnings.length} keybinding warning(s) — first: ${String(
                (warnings[0] as { message?: string })?.message ?? 'unreadable',
              ).slice(0, 140)}`,
              fix: 'Fix the named binding in the keybindings settings file.',
            }
          },
        },
        {
          id: 'model',
          label: 'Model pins',
          run: () => {
            const session = getMainLoopModel()
            let pin: string | undefined
            try {
              const settings = getSettingsWithAllErrors().settings as { model?: unknown }
              pin = typeof settings?.model === 'string' ? settings.model : undefined
            } catch {
              pin = undefined
            }
            if (recognizeModelId(session).kind === 'unrecognised') {
              return {
                status: 'warn',
                evidence: `session model ${session}${pin && pin !== session ? ` · settings pin ${pin}` : ''} — ${unrecognisedModelIdReason(session)}`,
                fix: 'No connected provider family declares this model id. Pick a model from /model, or route it through a custom endpoint that knows the id.',
              }
            }
            if (!pin) {
              return { status: 'ok', evidence: `session model ${session} · no settings pin` }
            }
            let pinResolved = pin
            try {
              pinResolved = parseUserSpecifiedModel(pin)
            } catch {
            }
            if (pinResolved === session) {
              return {
                status: 'ok',
                evidence:
                  pin === session
                    ? `session model ${session} = settings pin`
                    : `session model ${session} = settings pin '${pin}' (resolved)`,
              }
            }
            return {
              status: 'info',
              evidence: `session model ${session} · settings pin ${pin}${pinResolved !== pin ? ` (resolves to ${pinResolved})` : ''} — the live session overrides the pin`,
              detail:
                'The settings pin is not the live session model — agents and workflows inherit the session. Pass model: explicitly where drift matters.',
            }
          },
        },
        {
          id: 'frontier',
          label: 'Default model',
          run: () => {
            const decision = computedDefault()
            const firstParty = frontierOperatorDecision()
            const order = firstParty.candidates
              .map(c => `${c.family}@${c.rank} ${c.eligible ? 'eligible' : c.code}`)
              .join(' · ')
            return {
              status: 'info' as const,
              evidence:
                decision.source === 'keyless'
                  ? describeComputedDefault(decision, providerDisplayName)
                  : `fresh-session default ${renderModelChip(decision.setting)} · ${describeComputedDefault(decision, providerDisplayName)}`,
              detail: `first-party gating: ${describeFrontierDecision(firstParty)} — candidates: ${order}`,
              link: '/model',
            }
          },
        },
        {
          id: 'instruction-profile',
          label: 'Instruction profile',
          run: async () => {
            const bundle = await getInstructionBundle()
            const { resolution, adapterId, skippedDuplicates, diagnostics, loadReason } =
              getInstructionCompositionState()
            const requested = `${resolution.requested}${
              resolution.requestedOrigin === 'default'
                ? ''
                : ` (${resolution.requestedOrigin})`
            }`
            const nativeCount = bundle.entries.filter(
              e => e.family === 'native',
            ).length
            const actionableDiagnostics = diagnostics.filter(
              d => d.kind !== 'duplicate-content',
            )
            const notes = [
              resolution.mapped ? `mapped: ${resolution.mapped}` : null,
              skippedDuplicates.length > 0
                ? `${skippedDuplicates.length} identical-content duplicate(s) skipped`
                : null,
              ...actionableDiagnostics.map(
                d => `${d.kind}: ${d.path}${d.parent ? ` (from ${d.parent})` : ''}`,
              ),
            ].filter(Boolean)
            return {
              status: actionableDiagnostics.length > 0
                ? ('warn' as const)
                : ('info' as const),
              evidence:
                `requested ${requested} → resolved ${resolution.resolved} ` +
                `(${adapterId} adapter) · ${bundle.entries.length} source(s)` +
                `${nativeCount > 0 ? ` (${nativeCount} native)` : ''} · ` +
                `digest ${bundle.bundleDigest.slice(0, 12)} · ` +
                `last reload: ${loadReason}` +
                (notes.length > 0 ? ` · ${notes.join(' · ')}` : ''),
              link: '/memory',
            }
          },
        },
        {
          id: 'request-context',
          label: 'Request context',
          run: async () => {
            const provenance = readPromptProvenance()
            const bundle = await getInstructionBundle()
            const instructionChars = bundle.entries.reduce(
              (a, e) => a + e.contentLength,
              0,
            )
            if (provenance === null) {
              return {
                status: 'info' as const,
                evidence:
                  `no composition recorded yet this session · instructions ` +
                  `${bundle.entries.length} source(s) · ${instructionChars} chars`,
                link: '/provenance',
              }
            }
            const OVERSIZED_SECTION_CHARS = 20_000
            const oversized = provenance.sections.filter(
              se => se.cacheClass !== 'turn' && se.chars > OVERSIZED_SECTION_CHARS,
            )
            const dupNames = new Map<string, number>()
            for (const se of provenance.sections) {
              dupNames.set(se.name, (dupNames.get(se.name) ?? 0) + 1)
            }
            const duplicated = [...dupNames.entries()].filter(([, n]) => n > 1)
            const top = [...provenance.sections]
              .sort((a, b) => b.chars - a.chars)
              .slice(0, 3)
              .map(se => `${se.name} ${se.chars}`)
              .join(' · ')
            const notes = [
              ...oversized.map(
                se => `oversized always-loaded section ${se.name} (${se.chars} chars — owner ${se.owner})`,
              ),
              ...duplicated.map(([name, n]) => `duplicate section name ${name} ×${n}`),
              provenance.absent.length > 0
                ? `${provenance.absent.length} registry section(s) absent (composed away)`
                : null,
            ].filter(Boolean)
            return {
              status: oversized.length > 0 || duplicated.length > 0
                ? ('warn' as const)
                : ('info' as const),
              evidence:
                `system prompt ${provenance.totalChars} chars / ${provenance.segmentCount} segments ` +
                `(digest ${provenance.digest}) · instructions ${instructionChars} chars / ` +
                `${bundle.entries.length} source(s) · top: ${top}` +
                (notes.length > 0 ? ` · ${notes.join(' · ')}` : ''),
              link: '/provenance',
            }
          },
        },
        {
          id: 'flags',
          label: 'Env overrides',
          run: () => {
            const present = FLAG_REGISTRY.filter(f => flagEnv(f.env) !== undefined)
            const set = present.filter(f => f.selfStamped !== true)
            const stamped = present.filter(f => f.selfStamped === true)
            const overrides = set.filter(f => realEnvPin(f.env) !== null)
            const bootApplied = set.filter(f => realEnvPin(f.env) === null)
            const shortValue = (f: { env: string }): string => `${f.env}=${String(flagEnv(f.env)).slice(0, 12)}`
            const stampNote =
              (stamped.length > 0 ? ` · self-stamped (not an override): ${stamped.map(shortValue).join(', ')}` : '') +
              (bootApplied.length > 0 ? ` · saved boot defaults (boot-env.json, not an override): ${bootApplied.map(shortValue).join(', ')}` : '')
            if (overrides.length === 0) {
              return {
                status: 'ok',
                evidence: `no env overrides — all ${FLAG_REGISTRY.length} registered flags at their defaults${stampNote}`,
              }
            }
            const show = overrides
              .slice(0, 4)
              .map(f => {
                const value = String(flagEnv(f.env))
                return `${f.env}=${value.length > 12 ? `${value.slice(0, 12)}…` : value}`
              })
              .join(', ')
            return {
              status: 'info',
              evidence: `${overrides.length} flag(s) overridden in env: ${show}${overrides.length > 4 ? ` … +${overrides.length - 4} more` : ''}${stampNote}`,
              detail: overrides.map(f => `${f.env}=${String(flagEnv(f.env)).slice(0, 40)} (${f.kind})`).join(' · '),
              link: '/substrate',
            }
          },
        },
        {
          id: 'kills',
          label: 'Killed tools',
          run: async () => {
            const kills = listCapabilityKills()
            const flat: string[] = []
            let unmatched = 0
            let builtinNamesFolded: Set<string> | null = null
            try {
              const { getAllBaseTools } = await import('../tools.js')
              builtinNamesFolded = new Set(
                getAllBaseTools().flatMap(t => [t.name, ...(t.aliases ?? [])]).map(n => n.toLowerCase()),
              )
            } catch {
              builtinNamesFolded = null
            }
            for (const [agent, tools] of Object.entries(kills)) {
              for (const tool of tools) {
                const spelled = agent === '*' || agent === '' ? tool : `${agent}:${tool}`
                const isWild = tool === '*'
                const isMcpShaped = tool.startsWith('mcp__')
                if (!isWild && !isMcpShaped && builtinNamesFolded && !builtinNamesFolded.has(tool.toLowerCase())) {
                  unmatched++
                  flat.push(`${spelled} (no such builtin — read as an MCP server name)`)
                } else {
                  flat.push(spelled)
                }
              }
            }
            let capRejects: string[] = []
            try {
              const { getAgentCapParseRejects } = await import('./permissions/capabilityGate.js')
              capRejects = getAgentCapParseRejects()
            } catch {
              capRejects = []
            }
            const capClause =
              capRejects.length > 0
                ? ` · agent-cap posture: ${capRejects.length} unreadable part(s) FAIL CLOSED at max-risk=low (${capRejects.slice(0, 3).map(t => JSON.stringify(t)).join(', ')}${capRejects.length > 3 ? '…' : ''})`
                : ''
            const capFix =
              'MERCURY_AGENT_CAP carries part(s) the parser cannot read; each clamps its agent to max-risk=low until fixed. Grammar: agent:max-risk=low|medium|high or agent:deny-cat=exec,net — semicolon-separated.'
            if (flat.length === 0) {
              if (capRejects.length > 0) {
                return {
                  status: 'warn',
                  evidence: `no tools killed (capabilityGate registry empty)${capClause}`,
                  fix: capFix,
                }
              }
              return { status: 'ok', evidence: 'no tools killed (capabilityGate registry empty)' }
            }
            return {
              status: unmatched > 0 || capRejects.length > 0 ? 'warn' : 'info',
              evidence: `${flat.length} killed: ${flat.slice(0, 4).join(', ')}${flat.length > 4 ? '…' : ''}${capClause}`,
              fix:
                unmatched > 0
                  ? 'Operator-armed — clear MERCURY_KILL to restore the listed tools. An entry marked "no such builtin" kills a builtin only if spelled like its name; scope a server kill unambiguously as mcp__<server>.'
                  : capRejects.length > 0
                    ? capFix
                    : 'Operator-armed — clear MERCURY_KILL to restore the listed tools.',
            }
          },
        },
        {
          id: 'wards',
          label: 'Content wards',
          run: async () => {
            const { wardsEnabled, loadProjectWardsWithReport } = await import('./hooks/wardsHook.js')
            const { BUILTIN_WARDS } = await import('./wards/wards.js')
            if (!wardsEnabled()) {
              return { status: 'off', evidence: 'MERCURY_WARDS=0 set — content wards off for this session' }
            }
            const report = loadProjectWardsWithReport(getCwd())
            const evidence = `builtin ${BUILTIN_WARDS.length} · project ${report.rules.length} rule(s)${
              report.problems.length > 0
                ? ` · ${report.problems.length} problem(s): ${report.problems.slice(0, 3).join(' | ')}${report.problems.length > 3 ? '…' : ''}`
                : ''
            }`
            if (report.problems.length > 0) {
              return {
                status: 'warn',
                evidence,
                fix: 'Fix the named entries in .mercury/wards.json — a dropped rule guards nothing, and a salvaged one may not match what you meant. Grammar: [{name, teach, scope: edit|bash, patterns: [regex…], flags?}].',
              }
            }
            return { status: 'ok', evidence }
          },
        },
        {
          id: 'themis',
          label: 'Config integrity',
          run: async () => {
            const { themisLevel } = await import('../substrate/themis/level.js')
            const level = themisLevel()
            if (level === 'off') {
              return {
                status: 'off' as const,
                evidence: 'MERCURY_THEMIS=off — deterministic control plane switched off by this session (the default is enforce; unset the env to re-arm). No blocklist, no audit, no lockfile checks',
              }
            }
            const { lockfileExists, verifyLockfile } = await import('../substrate/themis/integrity.js')
            const { checkDriftBaselines } = await import('../substrate/themis/drift.js')
            const { verifyAllChains } = await import('../substrate/themis/auditChain.js')
            const { themisApprove } = await import('../substrate/themis/boot.js')
            const cwdDir = getCwd()

            const { missionStatusLine: missionLineFn } = await import('../substrate/themis/mission.js')
            const missionEvidence = missionLineFn(cwdDir) ?? 'no tracked mission (/mission start <title> for substantial changes)'
            const gateClaim =
              level === 'warn'
                ? 'blocklist OBSERVING at the execution gate (hits logged, never denied)'
                : 'blocklist ENFORCED at the execution gate (matching calls denied)'
            if (!(await lockfileExists(cwdDir))) {
              return {
                status: 'info' as const,
                evidence: `level=${level} · ${gateClaim} · ${missionEvidence} · no lockfile enrolled yet`,
                fix: `Enroll the config trust anchor: ${binaryName()} themis lock`,
              }
            }
            const lock = await verifyLockfile(cwdDir)
            const drift = await checkDriftBaselines(cwdDir)
            const driftHigh = drift.filter(d => d.severity === 'high')
            const chains = await verifyAllChains()
            const chainsBad = chains.chains.filter(c => !c.verdict.ok)
            const evidence = [
              `level=${level}`,
              gateClaim,
              missionEvidence,
              lock.ok ? `lockfile ok (${lock.checked} files)` : `lockfile ${lock.kind.toUpperCase()}`,
              drift.length > 0 ? `drift ${driftHigh.length} high / ${drift.length} enrolled` : 'no drift baselines',
              `${chains.chains.length} audit chain(s)${chainsBad.length ? `, ${chainsBad.length} TAMPER-flagged` : ' clean'}`,
            ].join(' · ')

            if (lock.ok && driftHigh.length === 0 && chainsBad.length === 0) {
              return { status: 'ok' as const, evidence }
            }
            return {
              status: lock.ok ? ('warn' as const) : ('fail' as const),
              evidence,
              detail: [
                !lock.ok ? lock.detail : null,
                ...driftHigh.map(d => `${d.path} drifted to J=${d.jaccard}`),
                ...chainsBad.map(c => `${basename(c.file)}: ${(c.verdict as { detail?: string }).detail ?? 'tampered'}`),
              ]
                .filter(Boolean)
                .join(' · '),
              fix: chainsBad.length
                ? 'Inspect the flagged audit chain(s) under .mercury/themis/ — tamper evidence is history, not a re-stampable state.'
                : `Review the changed files, then re-stamp: ${binaryName()} themis approve`,
              ...(chainsBad.length === 0
                ? {
                    remedy: {
                      plan: 'Re-stamp the THEMIS lockfile + drift baselines at CURRENT content (accepts the reported change as operator-reviewed).',
                      class: 'destructive' as const,
                      apply: async () => {
                        const r = await themisApprove(cwdDir)
                        return { ok: true, note: `re-stamped ${r.lockPaths.length} lock + ${r.driftPaths.length} drift baseline(s)` }
                      },
                      verify: async () => {
                        const after = await verifyLockfile(cwdDir)
                        return { ok: after.ok, note: after.ok ? `lockfile verifies (${(after as { checked: number }).checked} files)` : after.detail }
                      },
                    },
                  }
                : {}),
            }
          },
        },
        {
          id: 'memory-lifecycle',
          label: 'Memory lifecycle',
          run: async () => {
            const { isAutoMemoryEnabled } = await import('../memdir/paths.js')
            if (!isAutoMemoryEnabled()) {
              return {
                status: 'off' as const,
                evidence: 'auto-memory disabled (settings/env) — no notes, cards, or topic memory this session',
              }
            }
            const { mnemeEnabled } = await import('../memdir/mnemeGates.js')
            if (!mnemeEnabled()) {
              return {
                status: 'info' as const,
                evidence: 'auto-memory ON (notes + cards) · topic memory (MERCURY_MNEME) off — /memory is the front door',
              }
            }
            const { mnemeStatus } = await import('../memdir/mnemeMaintenance.js')
            const st = mnemeStatus()
            const evidence = [
              `topic memory ON: ${st.entryCount} current · ${st.buffered + st.pendingConsuming} recent · ${st.historyCount} history · ${st.topicCount} topics`,
              st.running ? 'maintenance running' : st.due ? `maintenance DUE (${st.dueReason})` : 'maintenance idle',
              st.lastConsolidatedAt ? `last ${st.lastConsolidatedAt.slice(0, 16)}` : 'never consolidated',
            ].join(' · ')
            if (st.degraded.length > 0) {
              return {
                status: 'warn' as const,
                evidence,
                detail: st.degraded.join(' · '),
                fix: 'Run maintenance from /memory (the maintenance row) — it reaps dead locks and recovers stranded observations.',
              }
            }
            return { status: 'ok' as const, evidence }
          },
        },
      ],
    },
    {
      id: 'auth',
      title: 'AUTH',
      checks: [...providerAuthChecks(), ...providerUsageChecks(), webSearchDoorCheck(), extraCaCertsCheck()],
    },
    {
      id: 'interface',
      title: 'INTERFACE',
      checks: [
        {
          id: 'iface-terminal',
          label: 'Terminal profile',
          run: () => {
            const { resolveTerminalProfile } = require('../ink/session/terminalProfile.js') as typeof import('../ink/session/terminalProfile.js')
            const { describeTerminalHandback } = require('./terminalHandback.js') as typeof import('./terminalHandback.js')
            const handback = describeTerminalHandback()
            const p = resolveTerminalProfile()
            const cols = process.stdout.columns ?? 0
            const rows = process.stdout.rows ?? 0
            const color = process.env.NO_COLOR ? 'no-color' : (flagEnv('MERCURY_TRUECOLOR') ?? '1') !== '0' ? 'truecolor' : 'reduced'
            const missing = p.checks.filter(c => !c.ok)
            const detail = [
              ...p.checks.map(c => `${c.ok ? '●' : c.requirement === 'required' ? '✕' : '○'} ${c.label} (${c.requirement}) — ${c.evidence}${c.ok ? '' : ` · ${c.remediation}`}`),
              handback.line,
            ].join('\n')
            if (!process.stdout.isTTY) {
              return {
                status: 'info' as const,
                evidence: `environmental: stdout is piped/redirected — interactive-terminal requirements do not apply to this run (profile v${p.version} facts retained in detail)`,
                detail,
              }
            }
            return {
              status: p.verdict === 'unsupported' ? 'fail' : p.verdict === 'capable' ? 'info' : 'ok',
              evidence: `profile v${p.version} ${p.verdict} · ${cols}x${rows} · ${color}${missing.length ? ` · missing: ${missing.map(c => c.id).join(', ')}` : ''} · hand-back: ${handback.native ? 'native' : 'stop + fg'}`,
              detail,
              ...(p.verdict === 'unsupported'
                ? { fix: missing.find(c => c.requirement === 'required')?.remediation }
                : {}),
            }
          },
        },
        {
          id: 'iface-tokens',
          label: 'Theme tokens',
          run: () => {
            const { THEME_NAMES } = require('./theme.js') as typeof import('./theme.js')
            const { resolveMercuryTokens, listUnresolvedTokenRoles } = require('./mercuryTokens.js') as typeof import('./mercuryTokens.js')
            const { getSessionAccent } = require('../components/mercury-ui/sessionAccent.js') as typeof import('../components/mercury-ui/sessionAccent.js')
            const accent = getSessionAccent()
            const unresolved = THEME_NAMES.flatMap(fam =>
              listUnresolvedTokenRoles(resolveMercuryTokens(fam, accent.accent)).map(p => `${fam}.${p}`),
            )
            return unresolved.length === 0
              ? { status: 'ok', evidence: `${THEME_NAMES.length} families resolve every role · accent ${accent.accent} (${accent.key})` }
              : {
                  status: 'fail',
                  evidence: `${unresolved.length} unresolved role value(s): ${unresolved.slice(0, 3).join(' · ')}`,
                  fix: 'A theme family resolved an empty token — the named role would paint without ink. Report which family; /appearance switches away meanwhile.',
                }
          },
        },
        {
          id: 'iface-baseline',
          label: 'Visual baseline',
          run: () => {
            const { readFileSync: rf, existsSync: ex } = require('node:fs') as typeof import('node:fs')
            const { join: j } = require('node:path') as typeof import('node:path')
            const manifestPath = j(process.cwd(), 'design-system', 'live', 'manifest.json')
            if (!ex(manifestPath)) {
              return { status: 'info', evidence: 'no design-system/live/manifest.json in this project (the Mercury repo carries the baseline)' }
            }
            try {
              const m = JSON.parse(rf(manifestPath, 'utf8')) as { sourceSha?: unknown; entries?: unknown; generatedAt?: unknown }
              const entries = Array.isArray(m.entries) ? m.entries : null
              if (entries === null || entries.length === 0) {
                return {
                  status: 'info',
                  evidence: 'manifest lists no entries — not a certified baseline (regenerate via scripts/ui/generate-visual-baseline.ts)',
                }
              }
              if (typeof m.sourceSha !== 'string' || !/^[0-9a-f]{40}$/.test(m.sourceSha)) {
                return {
                  status: 'warn',
                  evidence: `manifest sourceSha is not a commit sha (${String(m.sourceSha).slice(0, 16)}) — provenance unverifiable`,
                }
              }
              const gridsDir = j(process.cwd(), 'design-system', 'live', 'grids')
              if (!ex(gridsDir)) {
                return {
                  status: 'warn',
                  evidence: `manifest lists ${entries.length} entries but design-system/live/grids is absent — the baseline's frames are not here`,
                }
              }
              const generatedAt = typeof m.generatedAt === 'string' ? m.generatedAt.slice(0, 10) : 'undated'
              return {
                status: 'ok',
                evidence: `${entries.length} entries @ ${m.sourceSha.slice(0, 8)} · ${generatedAt} · check: bun run scripts/ui/generate-visual-baseline.ts --check`,
              }
            } catch {
              return { status: 'fail', evidence: 'manifest unreadable — regenerate via scripts/ui/generate-visual-baseline.ts' }
            }
          },
        },
        {
          id: 'iface-voice',
          label: 'Voice input',
          run: async () => {
            const { describeVoiceReadiness } = await import('../services/voice/voiceSession.js')
            const readiness = describeVoiceReadiness()
            return { status: readiness.ready ? ('ok' as const) : ('info' as const), evidence: readiness.line, detail: readiness.detail }
          },
        },
        {
          id: 'iface-image-processor',
          label: 'Image processor',
          run: async () => {
            const { describeImageProcessor } = await import('../tools/FileReadTool/imageProcessor.js')
            const road = await describeImageProcessor()
            return { status: road.ready ? ('ok' as const) : ('info' as const), evidence: road.line, ...(road.detail ? { detail: road.detail } : {}) }
          },
        },
        {
          id: 'iface-shell-engine',
          label: 'Shell engine',
          run: async () => {
            const { resolveShellEngine } = await import('./shell/engineSession.js')
            const { getInitialSettings } = await import('./settings/settings.js')
            const setting = getInitialSettings().shellEngine ?? 'system'
            const resolved = resolveShellEngine(setting === 'brush' ? 'brush' : 'system')
            if (resolved.engine === 'brush') {
              return {
                status: 'ok' as const,
                evidence: `brush ${resolved.version} (${resolved.platform}, ${resolved.source}) — one persistent process per session, shell state persists between calls`,
                detail: `setting: ${setting}${process.env.MERCURY_SHELL_ENGINE ? ` · env pin MERCURY_SHELL_ENGINE=${process.env.MERCURY_SHELL_ENGINE}` : ''}`,
              }
            }
            const wanted = resolved.requested === 'brush'
            return {
              status: 'info' as const,
              evidence: wanted ? resolved.reason : 'the system shell serves the Bash tool (the default); arm the vendored engine with the Shell engine setting or MERCURY_SHELL_ENGINE=brush',
              ...(wanted ? { fix: 'Fetch the pack: bun run scripts/vendor/fetch-brush.ts, then rebuild.' } : {}),
            }
          },
        },
        {
          id: 'iface-inventory',
          label: 'Interaction inventory',
          run: () => {
            const { existsSync: ex } = require('node:fs') as typeof import('node:fs')
            const { join: j } = require('node:path') as typeof import('node:path')
            const p1 = j(process.cwd(), 'scripts', 'interaction', 'prove-interaction-coverage.ts')
            return ex(p1)
              ? { status: 'ok', evidence: 'interaction-coverage prover present — the inventory gates in the interaction suite' }
              : { status: 'info', evidence: 'not the Mercury repo — the inventory gates in-repo' }
          },
        },
      ],
    },
    {
      id: 'runtime',
      title: 'RUNTIME',
      checks: [
        {
          id: 'version-locks',
          label: 'Version locks',
          run: async () => {
            const { cleanupStaleLocks, getAllLockInfo, isPidBasedLockingEnabled } = await import(
              './nativeInstaller/pidLock.js'
            )
            if (!isPidBasedLockingEnabled()) {
              return { status: 'off', evidence: 'pid-based version locking disabled' }
            }
            const { existsSync } = await import('node:fs')
            const { join } = await import('node:path')
            const { getXDGStateHome } = await import('./xdg.js')
            const nativeLocksDir = join(getXDGStateHome(), 'mercury', 'locks')
            const legacyLocksDir = join(getXDGStateHome(), 'claude', 'locks')
            const locksDir =
              existsSync(nativeLocksDir) || !existsSync(legacyLocksDir) ? nativeLocksDir : legacyLocksDir
            const cleaned = cleanupStaleLocks(locksDir)
            const locks = getAllLockInfo(locksDir)
            return {
              status: 'ok',
              evidence: `${locks.length} live lock(s)${cleaned > 0 ? ` · ${cleaned} stale cleaned` : ''} (${locksDir})`,
            }
          },
        },
        {
          id: 'crash-reports',
          label: 'Crash reports',
          run: async () => {
            const { crashReportDirDisplay, listCrashReports } = await import('./crashReport.js')
            const reports = listCrashReports(3)
            if (reports.length === 0) return { status: 'ok', evidence: 'none recorded' }
            const newest = reports[0]!
            const where = [
              newest.sessionId !== null ? `session ${newest.sessionId.slice(0, 8)}` : null,
              newest.cwd !== null ? `in ${newest.cwd}` : null,
            ]
              .filter((bit): bit is string => bit !== null)
              .join(' ')
            return {
              status: 'info',
              evidence: `${reports.length} recent · newest: ${newest.at} ${newest.origin}${newest.component ? ` in ${newest.component}` : ''} — ${newest.message.slice(0, 60)}${where !== '' ? ` · ${where}` : ''} · ${crashReportDirDisplay()}`,
            }
          },
        },
        ...editOutcomeHealthChecks(),
        {
          id: 'runtime',
          label: 'Node & ripgrep',
          run: async () => {
            const rt = nodeRuntimeProjection(process.versions.node)
            const { runningRuntime } = await import('../services/privateChannel/updateService.js')
            const { runtimeLine } = await import('../services/privateChannel/vendoredRuntime.js')
            const which = runningRuntime()
            const nodePart =
              rt.verdict === 'supported'
                ? `${runtimeLine(which)}${which.source === 'vendored' ? '' : ` · supported — ${rt.label} (${rt.range})`}`
                : `${runtimeLine(which)} ${rt.verdict.toUpperCase()} — supported: ${rt.label} (${rt.range})`
            const rg = getRipgrepStatus()
            const rgPresent = rg.present
            const evidence = `${nodePart} · ripgrep ${rg.mode} @ ${basename(rg.path)} ${rgPresent ? 'present' : 'MISSING'}${rg.working === false ? ' · probe FAILED' : ''}`
            if (rt.verdict !== 'supported') {
              const belowFloor = rt.verdict === 'too-old' && rt.observed?.startsWith(`${NODE_SUPPORT.major}.`)
              return {
                status: 'fail',
                evidence,
                fix: `Install Node ${NODE_SUPPORT.minimum} or newer in the ${NODE_SUPPORT.major}.x line (${NODE_SUPPORT.label}) from https://nodejs.org and retry${belowFloor ? ` — ${NODE_FLOOR_REASON}` : ''}.`,
              }
            }
            if (!rgPresent || rg.working === false) {
              return {
                status: 'fail',
                evidence,
                fix: 'File search will fail — rebuild (`bun run build.ts`) to restore the bundled ripgrep.',
              }
            }
            return { status: 'ok', evidence }
          },
        },
        {
          id: 'shell',
          label: 'Bash tool shell',
          run: async () => {
            const { describeWindowsShellRoad } = await import('./shell/windowsShellRoad.js')
            const shell = describeWindowsShellRoad()
            if (shell.absent) return { status: 'warn', evidence: shell.line, fix: shell.fix }
            return { status: 'ok', evidence: shell.line }
          },
        },
        {
          id: 'eval-kernels',
          label: 'Eval languages',
          run: async () => {
            const { evalEnabled } = await import('../services/eval/contracts.js')
            const { primeEvalAvailability } = await import('../services/eval/interpreters.js')
            const { getCwd } = await import('./cwd.js')
            if (!evalEnabled()) {
              return { status: 'off', evidence: 'MERCURY_EVAL=0 — the Eval tool is out of the catalogue' }
            }
            const rows = await primeEvalAvailability(getCwd())
            const evidence = rows
              .map(row =>
                row.available
                  ? `${row.language} ${row.version ?? 'ok'} @ ${row.interpreterPath ?? '?'}`
                  : `${row.language} UNAVAILABLE (${row.whyNot ?? 'unknown'})`,
              )
              .join(' · ')
            const availableCount = rows.filter(row => row.available).length
            if (availableCount === 0) {
              return {
                status: 'warn',
                evidence,
                fix: 'No eval language is runnable — the tool is hidden. Install python3 ≥3.10 or make a node binary reachable.',
              }
            }
            if (availableCount < rows.length) {
              return { status: 'info', evidence }
            }
            return { status: 'ok', evidence }
          },
        },
        {
          id: 'sandbox',
          label: 'OS Bash sandbox',
          run: () => {
            let enabled = false
            try {
              enabled = SandboxManager.isSandboxingEnabled()
            } catch {
              return { status: 'unknown', evidence: 'sandbox state unreadable' }
            }
            if (enabled) {
              return {
                status: 'ok',
                evidence: 'ON — Bash filesystem + network confined (seatbelt/bubblewrap)',
              }
            }
            const reason = SandboxManager.getSandboxUnavailableReason()
            if (reason) {
              return {
                status: 'warn',
                evidence: reason,
                fix: 'Run /sandbox for details, or unset sandbox.enabled if intentional.',
              }
            }
            return {
              status: 'info',
              evidence: 'off — Bash runs unconfined (no OS filesystem/network boundary)',
              fix: 'Set sandbox.enabled:true in settings.json to confine Bash (macOS seatbelt / Linux bubblewrap).',
            }
          },
        },
        {
          id: 'color',
          label: 'Terminal color',
          run: () => {
            const level = chalk.level
            if (CHALK_DISABLED_FOR_NO_COLOR || level === 0) {
              return {
                status: 'info',
                evidence: `chalk level 0 — no color (${CHALK_DISABLED_FOR_NO_COLOR ? 'NO_COLOR honored' : 'non-TTY output'})`,
              }
            }
            const applied = process.stdout.isTTY === true
            const appliedNote = applied
              ? ''
              : ' · computed from the environment — stdout is not a TTY, this output itself carries no color'
            if (CHALK_CLAMPED_FOR_TMUX) {
              return {
                status: 'info',
                evidence: `chalk level ${level} — clamped for tmux (accent snaps to the 256 cube)${appliedNote}`,
                fix: 'With `terminal-overrides ,*:Tc` in tmux, export MERCURY_TRUECOLOR=1 to keep exact 24-bit.',
              }
            }
            if (level === 3) {
              return {
                status: applied ? 'ok' : 'info',
                evidence: `chalk level 3 — truecolor${CHALK_BOOSTED_FOR_MERCURY ? ' (Mercury-boosted)' : ''} · brand hues exact${appliedNote}`,
              }
            }
            if (level === 1) {
              return {
                status: 'info',
                evidence: `chalk level 1 — basic 16-color ANSI; the brand accent snaps to the nearest of 16${appliedNote}`,
              }
            }
            return {
              status: 'info',
              evidence: `chalk level ${level} — 256-color; the brand accent renders on the nearest cube${appliedNote}`,
            }
          },
        },
        {
          id: 'mcp',
          label: 'MCP policy',
          run: () => {
            const mcp = mcpGauge()
            const policyDesc = mcp.data.mcpPolicyHint
            const policyActive = mcp.data.mcpPolicyActive
            let policyRejects: string[] = []
            try {
              policyRejects = getMcpPolicyRejects()
            } catch {
            }
            const policyRejectFix =
              'MERCURY_MCP_MAX_RISK carries token(s) the parser cannot read (named in the evidence); the unread part keeps the permissive default. Grammar: low|medium|high, plus srv:low per server, comma-separated.'
            if (mcp.state === 'off') {
              return {
                status: policyRejects.length > 0 ? 'warn' : 'off',
                evidence: `no MCP servers configured · policy ${policyDesc} · ${describeUntrustedMcpHardening()}`,
                ...(policyRejects.length > 0 ? { fix: policyRejectFix } : {}),
              }
            }
            if (mcp.state !== 'live') {
              return { status: 'unknown', evidence: mcp.reason ?? 'mcp config unreadable' }
            }
            const hardening = describeUntrustedMcpHardening()
            const KNOWN_NEXT_MCP_REV = '2026-07-28'
            const revBehind =
              new Date().toISOString().slice(0, 10) >= KNOWN_NEXT_MCP_REV &&
              LATEST_PROTOCOL_VERSION < KNOWN_NEXT_MCP_REV
            const revLine = revBehind
              ? `proto ${LATEST_PROTOCOL_VERSION} · rev ${KNOWN_NEXT_MCP_REV} is published — SDK behind`
              : `proto ${LATEST_PROTOCOL_VERSION} (next: ${KNOWN_NEXT_MCP_REV} RC)`
            const auth = summarizeMcpAuthCurrency()
            const authLine =
              auth === null
                ? 'auth unknown'
                : auth.tokens === 0
                  ? 'no oauth tokens'
                  : `auth ${auth.tokens} token(s)${auth.expired > 0 ? ` · ${auth.expired} EXPIRED` : ''}${auth.expiringSoon > 0 ? ` · ${auth.expiringSoon} expiring <30m` : ''}`
            const serverList = mcp.data.servers
              .slice(0, 3)
              .map(s => `${s.name} (${s.state})`)
              .join(', ')
            const evidence = `${mcp.data.servers.length} server(s): ${serverList}${mcp.data.servers.length > 3 ? '…' : ''} · policy ${policyDesc} · ${hardening} · ${revLine} · ${authLine}`
            if (policyRejects.length > 0) {
              return { status: 'warn', evidence, fix: policyRejectFix }
            }
            if (auth !== null && auth.expired > 0) {
              return {
                status: 'warn',
                evidence,
                fix: 'Re-authenticate the expired server(s) via /mcp (tokens refresh on next use; this makes the stale ones visible).',
              }
            }
            if (revBehind) {
              return {
                status: 'warn',
                evidence,
                fix: `The bundled SDK speaks MCP ${LATEST_PROTOCOL_VERSION}; ${KNOWN_NEXT_MCP_REV} is out. Newer servers may refuse — update Mercury when a build ships the migration.`,
              }
            }
            if (!policyActive) {
              return {
                status: 'info',
                evidence,
                fix: 'Tighten if desired: MERCURY_MCP_MAX_RISK=low|medium (or srv:low per server).',
              }
            }
            return { status: 'ok', evidence }
          },
        },
        {
          id: 'extensions',
          label: 'Extensions',
          run: () => {
            const row = extensionsHealthRow()
            if (row.problems.length > 0) {
              return {
                status: 'fail',
                evidence: row.problems.join(' · '),
                fix: 'Fix or remove the record file named under <config home>/extensions; the roster reads empty until then.',
              }
            }
            if (row.status === 'off') return { status: 'off', evidence: 'no extensions installed' }
            if (row.status === 'fail') {
              const brokenIds = row.brokenReasons.map(b => `${b.id} (${b.reason})`).join(', ')
              return {
                status: 'fail',
                evidence: `${row.evidence} — broken: ${brokenIds}`,
                fix: '/extensions shows each reason; a copy whose folder is gone is removed with x.',
                ...(healthFixEnabled() && row.brokenReasons.some(b => b.reason.startsWith('folder missing'))
                  ? {
                      remedy: {
                        plan: `remove the installed record(s) whose folder is gone: ${row.brokenReasons.filter(b => b.reason.startsWith('folder missing')).map(b => b.id).join(', ')}`,
                        class: 'safe' as const,
                        apply: async () => {
                          const { uninstall } = await import('../extensions/install.js')
                          const gone = row.brokenReasons.filter(b => b.reason.startsWith('folder missing'))
                          for (const b of gone) uninstall(b.id, { keepData: true })
                          return { ok: true, note: `${gone.length} record(s) removed (data folders kept)` }
                        },
                        verify: async () => {
                          const rescan = extensionsHealthRow()
                          const remaining = rescan.brokenReasons.filter(b => b.reason.startsWith('folder missing'))
                          return remaining.length === 0 ? { ok: true, note: rescan.evidence } : { ok: false, note: `${remaining.length} record(s) still point at a missing folder` }
                        },
                      },
                    }
                  : {}),
              }
            }
            if (row.status === 'warn') {
              return { status: 'warn', evidence: row.evidence, fix: '/extensions shows each partial extension\'s reasons (a missing binary, an unset env var or option, a dead contribution).' }
            }
            return { status: 'ok', evidence: row.evidence }
          },
        },
        {
          id: 'lsp',
          label: 'IDE-hands (LSP)',
          run: async () => {
            if (!mercuryLspEnabled()) {
              return {
                status: 'off',
                evidence: 'MERCURY_LSP=0 — IDE-hands bridge disabled by flag',
              }
            }
            const probe = probeBuiltinTsServer()
            const tsEvidence = probe.typescriptPath
              ? `typescript@${readTsVersion(probe.typescriptPath) ?? '?'}`
              : 'no workspace typescript'
            const laneSegments: string[] = []
            if (!mercuryLspCppEnabled()) {
              laneSegments.push('cpp lane off (MERCURY_LSP_CPP=0)')
            } else {
              const cpp = probeBuiltinClangd()
              if (!cpp.available || !cpp.clangdPath) {
                laneSegments.push('no clangd')
              } else {
                const db = probeCompileDb()
                laneSegments.push(
                  db.compileDb
                    ? 'clangd ok · compile DB found'
                    : db.cmakeLists
                      ? `clangd ok · ${compileDbRemedy(db)}`
                      : 'clangd ok',
                )
              }
            }
            const godot = probeGodotLane()
            if (!godot.enabled) {
              laneSegments.push('godot lane off (MERCURY_GODOT)')
            } else if (!godot.projectRoot) {
              laneSegments.push('godot armed · no project.godot here')
            } else {
              const reachable = await probeGodotEditorReachable(godot.lspPort)
              laneSegments.push(
                reachable
                  ? `godot editor listening :${godot.lspPort}`
                  : `godot editor NOT listening :${godot.lspPort} — open the project in the Godot editor (or godot --editor --headless; macOS app bundle: <Godot.app>/Contents/MacOS/Godot)`,
              )
            }
            const lanes = laneSegments.join(' · ')
            const init = getInitializationStatus()
            if (init.status === 'failed') {
              return {
                status: 'fail',
                evidence: `manager init failed: ${init.error.message.slice(0, 120)}`,
                fix: 'Check extension language-server configs / MERCURY_LSP_SERVERS JSON; /extensions reload re-inits.',
              }
            }
            if (init.status === 'not-started' || init.status === 'pending') {
              return {
                status: 'info',
                evidence: `bridge armed · ${tsEvidence} · ${lanes} · manager ${init.status} (probe: builtinServers.probeBuiltinTsServer)`,
              }
            }
            const manager = getLspServerManager()
            const servers = manager ? [...manager.getAllServers().values()] : []
            if (servers.length === 0) {
              return {
                status: 'info',
                evidence: `no LSP server source — ${probe.reason ?? tsEvidence}; ${lanes}`,
                fix: 'Add typescript to the workspace, install clangd, provide MERCURY_LSP_SERVERS, or install an extension that contributes a language server.',
              }
            }
            const errored = servers.filter(s => s.state === 'error')
            const roster = servers
              .map(s => `${s.name} ${s.state === 'stopped' ? 'idle' : s.state}`)
              .join(' · ')
            if (errored.length > 0) {
              return {
                status: 'warn',
                evidence: `${roster} — ${errored[0]!.name}: ${errored[0]!.lastError?.message.slice(0, 100) ?? 'error'}`,
                fix: 'Server errored; it restarts on next use up to maxRestarts. MERCURY_LSP_DEBUG=1 for sidecar stderr.',
                link: '/trace',
              }
            }
            return {
              status: 'ok',
              evidence: `${roster} · ${tsEvidence} · ${lanes} · post-edit diagnostics armed (servers lazy-start on first use)`,
              link: '/trace',
            }
          },
        },
        {
          id: 'editor-bridge',
          label: 'Editor bridge',
          run: async () => {
            const { installedEditorExtensions } = await import('./editorExtensionPackage.js')
            const { detectIDEs, getTerminalIdeType, isSupportedTerminal, toIDEDisplayName } = await import('./ide.js')
            const { flagEnv } = await import('../substrate/flagRegistry.js')
            const installed = installedEditorExtensions()
            const advertised = await detectIDEs(true)
            const valid = advertised.filter(ide => ide.isValid)
            const embedded = isSupportedTerminal()
            const port = flagEnv('MERCURY_IDE_PORT')
            const parts = [
              installed.length > 0
                ? `extension installed: ${installed.map(i => `${i.editor} ${i.version}`).join(', ')}`
                : 'extension NOT installed in any VS Code-family editor',
              advertised.length === 0
                ? 'no editor advertising a bridge'
                : `${valid.length} of ${advertised.length} advertising editor(s) match this workspace (${advertised
                    .slice(0, 3)
                    .map(i => `${i.name} :${i.port}`)
                    .join(', ')})`,
              embedded
                ? `terminal: ${toIDEDisplayName(getTerminalIdeType())}${port ? ` · port ${port} advertised` : ' · no port advertised (open a new terminal after installing)'}`
                : 'terminal: not an editor terminal',
              'acp: mercury acp --stdio',
            ]
            const evidence = parts.join(' · ')
            if (valid.length > 0) return { status: 'ok' as const, evidence }
            if (installed.length === 0) {
              return {
                status: 'info' as const,
                evidence,
                fix: 'mercury editor install (installs the extension from this build), then reload the editor window.',
              }
            }
            return {
              status: 'info' as const,
              evidence,
              fix: 'Open this workspace in an editor with the Mercury extension; a terminal opened there carries MERCURY_IDE_PORT and /ide lists it.',
            }
          },
        },
        {
          id: 'vulcan',
          label: 'Godot control (VULCAN)',
          run: async () => {
            const { vulcanEnabled, vulcanLiteMode, vulcanPort } = await import('./vulcan/vulcanGates.js')
            if (!vulcanEnabled()) {
              return {
                status: 'off' as const,
                evidence: 'MERCURY_GODOT_TOOLS unset — the Godot control surface is disabled (arm it in the boot menu, miscellaneous)',
              }
            }
            const { findGodotProjectRoot } = await import('../services/lsp/godotLane.js')
            const root = findGodotProjectRoot()
            const port = vulcanPort()
            const lite = vulcanLiteMode() ? ' · lite subset' : ''
            if (!root) {
              return {
                status: 'info' as const,
                evidence: `armed (port ${port}${lite}) · no project.godot from cwd — the Godot tool stays out of the catalog here`,
              }
            }
            const { vulcanInstallStatus } = await import('../services/vulcan/addonInstaller.js')
            const { probeGodotEditorPresence, presenceNudge } = await import('../services/vulcan/editorPresence.js')
            const s = vulcanInstallStatus(root)
            const presence = await probeGodotEditorPresence(root, port)
            const parts = [
              `project ${root}`,
              s.installed ? `addon installed${s.digestMatch ? '' : s.bundledFiles === 0 ? ' (dev bundle empty)' : ' (DRIFTED from bundle)'}` : 'addon NOT installed',
              s.enabled ? 'addon enabled' : 'addon not enabled',
              presence.reachable ? `bridge up :${port}` : `${presence.words} (:${port} dark)`,
            ]
            if (!s.installed || !s.enabled || !presence.reachable) {
              return {
                status: 'warn' as const,
                evidence: parts.join(' · ') + lite,
                fix: presenceNudge(presence, s),
              }
            }
            return { status: 'ok' as const, evidence: parts.join(' · ') + lite }
          },
        },
        {
          id: 'substrate',
          label: 'Substrate & trace',
          run: () => {
            const s = substrateSnapshot()
            const trace = isInvocationTraceEnabled()
            if (s.state !== 'live') {
              return { status: 'unknown', evidence: s.reason ?? 'substrate gates unreadable' }
            }
            return {
              status: 'info',
              evidence: `${s.data.active}/${s.data.total} capabilities on · trace ${trace ? 'recording' : 'off'}`,
              link: trace ? '/trace' : '/substrate',
            }
          },
        },
        {
          id: 'resources',
          label: 'Device headroom',
          run: async () => {
            const { availableB, source } = await deviceHeadroom()
            const cores = Math.max(1, cpus().length)
            const loadKnown = process.platform !== 'win32'
            const load1 = loadavg()[0] ?? 0
            const perCore = load1 / cores
            const loadText = loadKnown ? `load ${perCore.toFixed(2)}/core` : 'load n/a (win32 has no loadavg)'
            const evidence = `${mb(availableB)} available · ${loadText} (${cores} cores) (${source})`
            const busy = loadKnown ? perCore >= 1.25 : true
            if (availableB < 256 * MB || (availableB < 768 * MB && busy)) {
              return {
                status: 'warn',
                evidence: evidence + ' — headroom is genuinely tight for new agents',
                fix: 'Stop an agent or close memory-heavy apps before starting more.',
              }
            }
            return { status: 'ok', evidence }
          },
        },
      ],
    },
    {
      id: 'durability',
      title: 'DURABILITY',
      checks: [
        {
          id: 'durable-journals',
          label: 'Operation journals',
          run: async () => {
            const { listJournalOperations } = await import('../substrate/operationJournal.js')
            const { teamJournalDir } = await import('./swarm/teamOperations.js')
            const alive = (pid: number): boolean => {
              try {
                process.kill(pid, 0)
                return true
              } catch {
                return false
              }
            }
            let terminal = 0
            let inFlight = 0
            let awaitingRecovery = 0
            for (const dir of [teamJournalDir()]) {
              for (const op of await listJournalOperations(dir)) {
                if (op.state === 'committed' || op.state === 'aborted') terminal++
                else if (alive(op.writerPid)) inFlight++
                else awaitingRecovery++
              }
            }
            const evidence = `${terminal} terminal · ${inFlight} in flight (live writers) · ${awaitingRecovery} interrupted awaiting recovery (teams + daemon journals)`
            if (awaitingRecovery > 0) {
              return {
                status: 'warn' as const,
                evidence,
                fix: 'A process died mid-operation. The next Mercury boot reconciles it; the journal files are the evidence.',
              }
            }
            return { status: 'ok' as const, evidence }
          },
        },
        {
          id: 'store-quarantines',
          label: 'Store quarantines',
          run: async () => {
            const { readStoreRecoveryEvents } = await import('../substrate/storeRecovery.js')
            const events = await readStoreRecoveryEvents()
            const dayAgo = Date.now() - 24 * 60 * 60_000
            const recent = events.filter(e => {
              const t = Date.parse(e.ts)
              return Number.isFinite(t) && t >= dayAgo
            })
            if (recent.length > 0) {
              const last = recent[recent.length - 1]!
              const preservation =
                last.kind === 'read-degrade'
                  ? ', bytes left in place (read-path degrade; the next mutation quarantines them)'
                  : last.quarantinePath
                    ? `, bytes preserved at ${last.quarantinePath}`
                    : ', preservation FAILED (recorded)'
              return {
                status: 'warn' as const,
                evidence: `${recent.length} damaged-store event(s) in the last 24h (${events.length} on the ledger) — latest: ${last.store} (${last.reason})${preservation}`,
                fix: 'A store held unreadable bytes; the runtime kept a quarantined copy and moved on. Recurring events point at disk or crash-loop trouble.',
              }
            }
            return {
              status: 'ok' as const,
              evidence:
                events.length === 0
                  ? 'no damaged-store recoveries on the ledger'
                  : `no events in the last 24h (${events.length} historical on the ledger)`,
            }
          },
        },
        {
          id: 'interview-persistence',
          label: 'Interview settlement',
          run: async () => {
            const { interviewPersistenceHealth } = await import('../services/interview/store.js')
            const h = interviewPersistenceHealth()
            if (h.degradedIdentities > 0 && h.lastDegraded) {
              return {
                status: 'warn' as const,
                evidence: `${h.degradedIdentities} identit${h.degradedIdentities === 1 ? 'y' : 'ies'} with a DEGRADED last settlement (retained for retry) — latest ${h.lastDegraded.sessionId}@g${h.lastDegraded.generation}: ${h.lastDegraded.error}`,
                fix: 'A durable write failed and is retained for retry. Recurring failures point at the config-home filesystem.',
              }
            }
            if (h.pendingIdentities > 0) {
              return {
                status: 'info' as const,
                evidence: `${h.pendingIdentities} identit${h.pendingIdentities === 1 ? 'y has' : 'ies have'} a pending debounced write (≤150 ms tail — normal during activity)`,
              }
            }
            return { status: 'ok' as const, evidence: 'every interview identity settled (no pending, no degraded)' }
          },
        },
        {
          id: 'publish-retry-budget',
          label: 'Publish retry budget',
          run: async () => {
            const { durablePublishHealth } = await import('../substrate/durablePublish.js')
            const h = durablePublishHealth()
            if (h.budgetExhausted.count > 0 && h.budgetExhausted.last) {
              const l = h.budgetExhausted.last
              return {
                status: 'warn' as const,
                evidence: `${h.budgetExhausted.count} publication(s) exhausted the win32 transient-retry ladder — latest ${l.path} (${l.fsCode ?? 'transient'} through ${l.attempts} attempts over ${l.elapsedMs}ms)`,
                fix: 'Another program held the destination past the retry budget (an antivirus scanner, a search indexer, an open handle). Exclude the config home from scanners if it recurs.',
              }
            }
            if (h.retriedSuccesses.count > 0 && h.retriedSuccesses.last) {
              return {
                status: 'info' as const,
                evidence: `the transient-retry ladder saved ${h.retriedSuccesses.count} publication(s) — latest ${h.retriedSuccesses.last.path} on attempt ${h.retriedSuccesses.last.attempts}`,
              }
            }
            return { status: 'ok' as const, evidence: 'no transient rename contention observed this session' }
          },
        },
        {
          id: 'orphan-temps',
          label: 'Orphan publish temps',
          run: async () => {
            const { countOrphanDurableTemps } = await import('../substrate/recoveryOrchestrator.js')
            const { dirs, stale } = await countOrphanDurableTemps()
            if (stale > 0) {
              return {
                status: 'info' as const,
                evidence: `${stale} stale temp(s) across ${dirs} durable dir(s) — self-healing (swept at next boot / next publish into the dir)`,
              }
            }
            return { status: 'ok' as const, evidence: `no stale publish temps across ${dirs} durable dir(s)` }
          },
        },
        {
          id: 'boot-recovery',
          label: 'Boot reconciliation',
          run: async () => {
            const { getBootRecovery, bootRecoveryStatusLine } = await import(
              '../substrate/recoveryOrchestrator.js'
            )
            const s = getBootRecovery()
            if (s.phase === 'pending') {
              return {
                status: 'info' as const,
                evidence:
                  'not run in this process — the pass runs at interactive and daemon boot, before any projection is built',
              }
            }
            if (s.phase === 'running') {
              return { status: 'info' as const, evidence: 'reconciliation in flight right now' }
            }
            const r = s.report!
            const line = bootRecoveryStatusLine(s)
            const notes = r.notes.length > 0 ? ` — ${r.notes.join('; ')}` : ''
            return {
              status: line?.tone === 'warn' ? ('warn' as const) : ('ok' as const),
              evidence: line
                ? `${line.text} (${r.durationMs}ms)${notes}`
                : `clean boot — nothing to reconcile (${r.orphanTemps.dirsSwept} dir(s) swept, ${r.teamJournal?.scanned ?? 0} journal op(s) scanned, ${r.durationMs}ms)${notes}`,
            }
          },
        },
        {
          id: 'durable-transaction',
          label: 'Durable transaction',
          depth: 'deep',
          probe: 'functional',
          timeoutMs: 30_000,
          run: async () => {
            const probes = await import('./healthDeepProbes.js')
            return probes.probeDurableTransaction()
          },
        },
      ],
    },
    {
      id: 'native-ownership',
      title: 'TERMINAL RUNTIME',
      checks: [
        {
          id: 'terminal-runtime',
          label: 'Terminal runtime',
          run: async () => {
            const { getCellLayoutCounters } = await import('../ink/layout/cellLayout.js')
            const c = getCellLayoutCounters()
            return {
              status: 'ok' as const,
              evidence: `Mercury Cell Layout (owned, bedrock B2) — last pass: ${c.visited} visited · ${c.measured} measured · ${c.cacheHits} cache hits · ${c.live} live nodes`,
            }
          },
        },
      ],
    },
    {
      id: 'profile',
      title: 'PROFILE',
      checks: [
        {
          id: 'appearance',
          label: 'Resolved appearance',
          run: () => {
            const a = getMercuryAppearanceSnapshot()
            const tokens = resolveMercuryTokens(a.concreteTheme, a.accent)
            const missing = listUnresolvedTokenRoles(tokens)
            const ground = oasisBgEnabled(Boolean(process.stdout.isTTY), a.concreteTheme)
              ? 'oasis ground painted'
              : isDarkThemeFamily(a.concreteTheme)
                ? 'ground off (env/TTY gate)'
                : 'profile ground (light family)'
            const evidence = `theme ${a.requestedTheme}${a.requestedTheme === 'auto' ? `→${a.concreteTheme}` : ''} · ${a.colorMode} · accent ${a.accent} · motion ${a.motion} · ${ground}`
            if (missing.length > 0) {
              return {
                status: 'fail' as const,
                evidence: `${evidence} — ${missing.length} unresolved semantic role(s): ${missing.join(',')}`,
                fix: 'A theme family resolved an empty token — chrome would lose contrast there. Report which family; /appearance to switch away meanwhile.',
                link: '/appearance',
              }
            }
            return { status: 'info' as const, evidence, link: '/appearance' }
          },
        },
        {
          id: 'roster-normalization',
          label: 'Agent roster',
          run: () => {
            const agents = getBuiltInAgents()
            const unresolved = agents.filter(a => findRoleDefinition(a.agentType, agents)?.agentType !== a.agentType)
            const haiku = agents.filter(a => a.model === 'haiku')
            const composable = agents.filter(a => getRoleSystemPrompt(a) !== undefined)
            const evidence = `${agents.length} built-in roles resolve · role prompts compose ${composable.length}/${agents.length} without live context`
            if (unresolved.length > 0 || haiku.length > 0) {
              return {
                status: 'fail' as const,
                evidence: `${evidence} — unresolved: ${unresolved.map(a => a.agentType).join(',') || 'none'}; haiku pins: ${haiku.map(a => a.agentType).join(',') || 'none'}`,
                fix: 'A built-in agent role fails normalization — sub-agents spawned with it would degrade to generic agents. Report this.',
              }
            }
            return { status: 'ok' as const, evidence }
          },
        },
        {
          id: 'team-launch',
          label: 'Sub-agent launch',
          run: () => {
            const mode = getResolvedTeammateMode()
            const inProc = isInProcessEnabled()
            const evidence = inProc
              ? "in-process — named sub-agents run inside this session's runner"
              : `${mode} panes — named sub-agents open terminal panes (in-process if the pane backend fails)`
            return { status: 'info' as const, evidence, link: '/teammates' }
          },
        },
      ],
    },
    {
      id: 'coding-loop-fast',
      title: 'CODING LOOP',
      checks: [
        {
          id: 'change-receipts-fast',
          label: 'Change receipts',
          run: async () => {
            const { changeTransactionEnabled } = await import(
              '../services/changeTransaction/contracts.js'
            )
            if (!changeTransactionEnabled()) {
              return { status: 'off' as const, evidence: 'MERCURY_CHANGE_RECEIPTS=0' }
            }
            const { _toolTerminalSubscriberCountForTesting } = await import(
              '../services/run/effectObserver.js'
            )
            const subs = _toolTerminalSubscriberCountForTesting()
            return {
              status: 'ok' as const,
              evidence: `anchors + receipt ring armed (${subs} observer subscription(s) on the effect seam)`,
            }
          },
        },
        {
          id: 'resource-plane-fast',
          label: 'Resource plane',
          run: async () => {
            const { mercuryRefsEnabled } = await import('../services/resources/contracts.js')
            if (!mercuryRefsEnabled()) {
              return { status: 'off' as const, evidence: 'MERCURY_REFS=0' }
            }
            const { resourceAdapterKinds } = await import('../services/resources/registry.js')
            const kinds = resourceAdapterKinds()
            return {
              status: kinds.length >= 10 ? ('ok' as const) : ('warn' as const),
              evidence: `${kinds.length} adapter kind(s): ${kinds.map(k => k.kind).join(' ')}`,
              ...(kinds.length < 10
                ? { fix: 'Built-in resource adapters failed to register — rebuild; report it if it persists.' }
                : {}),
            }
          },
        },
        {
          id: 'workshop-fast',
          label: 'Workshop',
          run: async () => {
            const { workshopEnabled } = await import('../services/workshop/contracts.js')
            if (!workshopEnabled()) {
              return { status: 'off' as const, evidence: 'MERCURY_WORKSHOP=0' }
            }
            const { probePythonInterpreter } = await import(
              '../services/workshop/pythonRuntime.js'
            )
            const py = probePythonInterpreter()
            return {
              status: 'ok' as const,
              evidence: `js/ts armed (embedded worker) · py ${'unavailable' in py ? `honestly unavailable (${py.unavailable.split(' — ')[0]})` : py.version}`,
            }
          },
        },
        {
          id: 'ide-plane-fast',
          label: 'IDE plane',
          run: async () => {
            const { selectPythonInterpreter } = await import('../services/ide/pythonProject.js')
            const { probeBuiltinPyright } = await import('../services/lsp/pyrightLane.js')
            const { probeRuff } = await import('../services/lsp/ruffLane.js')
            const { projectPythonDebuggerProvenance } = await import('../services/ide/pythonProject.js')
            const { probeBuiltinClangd, probeCompileDb } = await import('../services/lsp/clangdLane.js')
            const { mercuryGodotEnabled } = await import('../services/lsp/godotLane.js')
            const { vulcanEnabled } = await import('../utils/vulcan/vulcanGates.js')
            const { latestTransaction } = await import('../services/ide/ideTransaction.js')
            const { latestRun } = await import('../services/ide/pythonTests.js')
            const { darwinDebuggerAuthorisationHint } = await import('../services/dap/dapClient.js')

            const py = selectPythonInterpreter()
            const pyright = probeBuiltinPyright()
            const ruff = probeRuff()
            const debugpy = projectPythonDebuggerProvenance()
            const clangd = probeBuiltinClangd()
            const db = probeCompileDb()
            const tx = latestTransaction()
            const test = latestRun()
            const debugAuth = darwinDebuggerAuthorisationHint()

            const pyLine =
              py.state === 'ok'
                ? `python ${py.version} (${py.envKind}) · pyright ${pyright.available ? `${pyright.source}${pyright.version ? ` ${pyright.version}` : ''}` : 'ABSENT'} · ruff ${ruff.available ? (ruff.version ?? 'ok') : 'ABSENT'} · debugpy ${debugpy.adapterSource}`
                : `python UNAVAILABLE (${py.detail.slice(0, 80)})`
            const cppLine =
              (clangd.available
                ? `clangd ${clangd.clangdPath} · compile DB ${db.compileDb ?? 'ABSENT'}`
                : `clangd ABSENT (${clangd.reason?.slice(0, 60)})`) +
              (debugAuth ? ` · native debug: ${debugAuth}` : '')
            const godotLine = `godot lanes ${mercuryGodotEnabled() ? 'armed' : 'disarmed'} · vulcan ${vulcanEnabled() ? 'armed' : 'disarmed'}`
            const planeLine = `latest transaction ${tx ? `${tx.id} [${tx.verdict}]` : '—'} · latest test run ${test ? `${test.id} (${test.counts.failed === 0 ? 'green' : `${test.counts.failed} failing`})` : '—'}`
            const healthy = py.state === 'ok' || clangd.available
            return {
              status: healthy && debugAuth === null ? ('ok' as const) : ('warn' as const),
              evidence: debugAuth ? `${pyLine} · native debug authorisation OFF` : pyLine,
              detail: [cppLine, godotLine, planeLine].join('\n'),
              ...(py.state !== 'ok'
                ? { fix: 'Install Python 3, or point MERCURY_PYTHON at one.' }
                : debugAuth
                  ? { fix: 'sudo DevToolsSecurity -enable (macOS debugger authorisation; durable across reboots).' }
                  : {}),
            }
          },
        },
        {
          id: 'anvil-workbench-fast',
          label: 'Utility workbench',
          run: async () => {
            const { discoverRunnerProfiles } = await import('../services/ide/projectRunners.js')
            const { repoHostEnabled } = await import('../services/repoHost/repoHost.js')
            const { openTransactionIdFor } = await import('../services/ide/ideTransaction.js')
            const nodePath = await import('node:path')
            const { existsSync } = await import('node:fs')
            const { profiles } = discoverRunnerProfiles()
            const byRunner = new Map<string, { ok: number; total: number }>()
            for (const p of profiles) {
              const e = byRunner.get(p.runner) ?? { ok: 0, total: 0 }
              e.total += 1
              if (p.availability.state === 'ok') e.ok += 1
              byRunner.set(p.runner, e)
            }
            const runnersLine = profiles.length
              ? [...byRunner].map(([r, c]) => `${r} ${c.ok}/${c.total}`).join(' · ')
              : 'no runner manifests in this project'
            const ghOnPath = whichSync('gh') !== null
            const repoLine = repoHostEnabled()
              ? `repo host: ${ghOnPath ? 'gh on PATH (mercury://repo live)' : 'gh ABSENT — context unavailable (remedy: install gh + gh auth login)'}`
              : 'repo host: OFF (MERCURY_REPO_HOST=0)'
            const { structurePolyglotEnabled } = await import('../services/structure/contracts.js')
            const { resolveGrammarEngineDir, POLYGLOT_LANGUAGES } = await import('../services/structure/grammarFacility.js')
            let engineLine: string
            if (!structurePolyglotEnabled()) {
              engineLine = 'polyglot patterns: OFF (MERCURY_STRUCTURE_POLYGLOT=0)'
            } else {
              const engine = resolveGrammarEngineDir()
              if (engine.state === 'ok') {
                let present = 0
                try {
                  const { readdirSync } = await import('node:fs')
                  const shipped = new Set(readdirSync(engine.dir))
                  present = POLYGLOT_LANGUAGES.filter(lang => shipped.has(lang.wasm)).length
                } catch {
                  present = 0
                }
                engineLine =
                  present === POLYGLOT_LANGUAGES.length
                    ? `polyglot patterns: tree-sitter (${engine.source}) · ${present} languages`
                    : `polyglot patterns: tree-sitter (${engine.source}) · ${present} of ${POLYGLOT_LANGUAGES.length} languages present (${POLYGLOT_LANGUAGES.length - present} missing from ${engine.dir})`
              } else {
                engineLine = `polyglot patterns: engine UNAVAILABLE (${engine.note.slice(0, 80)})`
              }
            }
            const txId = openTransactionIdFor()
            return {
              status: 'ok' as const,
              evidence: `runners: ${runnersLine}`,
              detail: `${repoLine}\n${engineLine}\nopen coding transaction: ${txId ?? '—'}`,
            }
          },
        },
        {
          id: 'services-fast',
          label: 'Project services',
          run: async () => {
            const { servicesEnabled } = await import('../services/projectServices/contracts.js')
            if (!servicesEnabled()) {
              return { status: 'off' as const, evidence: 'MERCURY_SERVICES=0' }
            }
            const { reconcileAll } = await import('../services/projectServices/serviceManager.js')
            const records = reconcileAll(getCwd())
            const live = records.filter(r => ['starting', 'ready', 'running'].includes(r.state))
            return {
              status: 'ok' as const,
              evidence: `${records.length} record(s), ${live.length} live after reconciliation${live.length > 0 ? `: ${live.map(r => r.spec.name).join(', ')}` : ''}`,
            }
          },
        },
        {
          id: 'lanes-fast',
          label: 'Side lanes',
          run: async () => {
            const { lanesEnabled, listLanes } = await import('../services/contextLanes/lanes.js')
            if (!lanesEnabled()) {
              return { status: 'off' as const, evidence: 'MERCURY_LANES=0' }
            }
            const lanes = listLanes()
            const active = lanes.filter(l => l.status === 'active')
            const unpromoted = lanes.filter(l => l.handoff && !l.handoff.promoted)
            return {
              status: 'ok' as const,
              evidence: `${lanes.length} lane(s) · ${active.length} active${unpromoted.length > 0 ? ` · ${unpromoted.length} handoff(s) awaiting /branch promote` : ''}`,
            }
          },
        },
        {
          id: 'counsel-fast',
          label: 'Counsel',
          run: async () => {
            const { counselMode, counselStatus, counselConfigProblem } = await import('../services/counsel/counsel.js')
            const mode = counselMode()
            if (mode === 'off') {
              const problem = counselConfigProblem()
              if (problem !== null) {
                return { status: 'warn' as const, evidence: problem }
              }
              return {
                status: 'off' as const,
                evidence: 'MERCURY_COUNSEL unset — arm with =manual or =auto (reviews cost model calls)',
              }
            }
            const { processMainOwner } = await import('../services/run/resolveOwner.js')
            const status = counselStatus(processMainOwner())
            return {
              status: 'ok' as const,
              evidence: `mode ${mode} · ${status.pendingReceipts} un-reviewed receipt(s)${status.lastResult ? ` · last: ${status.lastResult.disposition}` : ''}`,
            }
          },
        },
      ],
    },
    {
      id: 'flux',
      title: 'TERMINAL FLUIDITY',
      checks: [
        {
          id: 'flux-probe',
          label: 'Paint probes',
          run: async () => {
            const { fluxSummary } = await import('./flux/fluxProbe.js')
            const sum = fluxSummary()
            if (!sum.enabled) {
              return {
                status: 'info' as const,
                evidence: 'probe off (opt-in) — MERCURY_FLUX_PROBE=1 arms frame/latency telemetry; laws gate-enforced (scripts/streaming/)',
              }
            }
            const risk = sum.counters['stale-frame-risk'] ?? 0
            return {
              status: risk === 0 ? ('ok' as const) : ('fail' as const),
              evidence: `armed · frames ${sum.frames.total} (p50 ${sum.frames.p50.toFixed(1)}ms · p95 ${sum.frames.p95.toFixed(1)}ms · max ${sum.frames.maxMs.toFixed(0)}ms) · patches ${sum.counters['patches'] ?? 0} · stale-frame-risk ${risk}`,
              ...(risk > 0 ? { fix: 'A probe observed unexpected screen writes — report this.' } : {}),
            }
          },
        },
      ],
    },
    {
      id: 'tool-capability-fast',
      title: 'TOOL CAPABILITY',
      checks: [
        skillsRefusedCheck(),
        {
          id: 'capability-census',
          label: 'Capability census',
          run: async () => {
            const { buildToolCensus, censusGapLines, CENSUS_NO_REASON, CENSUS_VERSION } = await import('./capability/census.js')
            const c = buildToolCensus()
            const s = c.summary
            const undeclared = c.rows.filter(r => r.declared === null).map(r => r.name)
            const gaps = censusGapLines(c)
            const reasonless = gaps.filter(g => g.reason === CENSUS_NO_REASON).flatMap(g => g.tools)
            const detail = gaps
              .map(g => `${g.support === 'conditional' ? 'conditional' : 'off'} · ${g.tools.join(', ')} — ${g.reason}`)
              .join('\n')
            const status =
              undeclared.length > 0 || s.unclassified.length > 0 ? ('fail' as const) : reasonless.length > 0 ? ('warn' as const) : ('ok' as const)
            return {
              status,
              evidence:
                `census v${CENSUS_VERSION} · ${s.tools} tool(s): ${s.bySupport.available} available · ` +
                `${s.bySupport.conditional} conditional · ${s.bySupport.unavailable} unavailable · ` +
                `${s.operations} operation(s)` +
                (undeclared.length > 0 ? ` · UNDECLARED: ${undeclared.join(', ')}` : '') +
                (s.unclassified.length > 0 ? ` · UNCLASSIFIED: ${s.unclassified.join(', ')}` : '') +
                (reasonless.length > 0 ? ` · NO REASON DECLARED: ${reasonless.join(', ')}` : ''),
              ...(detail.length > 0 ? { detail } : {}),
              ...(undeclared.length + s.unclassified.length + reasonless.length > 0
                ? { fix: 'Declare the tool’s capability contract (gate/conditions for a gated tool), then re-run `bun run scripts/builtin-tools/census-gen.ts`.' }
                : {}),
            }
          },
        },
        {
          id: 'capability-integrations',
          label: 'Lifecycle integrations',
          run: async () => {
            const { buildToolCensus } = await import('./capability/census.js')
            const s = buildToolCensus().summary
            return {
              status: 'ok' as const,
              evidence:
                `${s.withTransactionIntegration} declare transactions · ${s.withExecutionIntegration} declare executions · ` +
                `${s.withResourceOutputs} declare mercury:// outputs · ${s.withProof} name a focused proof · ` +
                `units covered: ${s.unitsCovered.length}`,
            }
          },
        },
        {
          id: 'capability-search',
          label: 'Capability search',
          run: async () => {
            const { getAllBaseTools } = await import('../tools.js')
            const { searchToolsWithKeywords } = await import('../tools/ToolSearchTool/ToolSearchTool.js')
            const tools = getAllBaseTools()
            const deferred = tools.filter(t => t.shouldDefer === true)
            if (!tools.some(t => t.name === 'Git')) {
              return {
                status: 'off' as const,
                evidence:
                  'Git work-graph tool not registered (MERCURY_GIT_GRAPH off) — the intent probe has no target',
              }
            }
            const hits = await searchToolsWithKeywords('split changes into atomic commits', deferred, tools, 3)
            return {
              status: hits[0] === 'Git' ? ('ok' as const) : ('fail' as const),
              evidence:
                hits[0] === 'Git'
                  ? `intent index live — 'split changes into atomic commits' → ${hits.join(' · ')} (${deferred.length} deferred)`
                  : `intent ranking broke: got ${hits.join(' · ') || '(none)'} — expected Git first`,
              ...(hits[0] !== 'Git' ? { fix: 'Capability search ranked an unexpected tool first — report this.' } : {}),
            }
          },
        },
      ],
    },
    {
      id: 'router-fast',
      title: 'ROUTER',
      checks: [
        {
          id: 'router-kernel',
          label: 'Route kernel',
          run: async () => {
            const { routerEnabled } = await import('./router/routerGates.js')
            if (!routerEnabled()) {
              return { status: 'info' as const, evidence: 'MERCURY_ROUTER=0 — routing off' }
            }
            const { compileRoute } = await import('./router/routeCompiler.js')
            const { buildRouterModelSnapshot } = await import('./router/modelRegistry.js')
            const { decodeTaskRoutePlan, stableDigest, ROUTER_POLICY_VERSION } = await import('./router/contracts.js')
            const { resolveRouterPosture } = await import('./router/postures.js')
            const r = compileRoute({
              mode: 'fanout',
              mission: {
                objective: 'health probe',
                title: 'probe',
                task: 'a hermetic three-node dependency compile',
                taskShape: 'bounded',
                ambiguity: 0,
                coupling: 0,
                parallelism: 1,
                candidateNodes: [
                  { id: 'a', title: 'a', task: 'a', ownsPaths: ['x/a.ts'], acceptance: ['a done'] },
                  { id: 'b', title: 'b', task: 'b', dependsOn: ['a'], ownsPaths: ['x/b.ts'], acceptance: ['b done'] },
                  { id: 'c', title: 'c', task: 'c', dependsOn: ['a'], ownsPaths: ['x/c.ts'], acceptance: ['c done'] },
                ],
              },
              posture: resolveRouterPosture(),
              models: buildRouterModelSnapshot(),
              worker: { maxWidth: 3, sharedLane: false },
              now: Date.now(),
              planId: 'rp-health-probe',
            })
            if (!r.ok) {
              return { status: 'fail' as const, evidence: `kernel probe REFUSED: [${r.refusal.reasonCodes.join(',')}] ${r.refusal.detail}`, fix: 'The route kernel refused its own probe — report this.' }
            }
            const decoded = decodeTaskRoutePlan(JSON.parse(JSON.stringify(r.plan)))
            const roundTrip = decoded !== null && stableDigest(decoded) === stableDigest(r.plan)
            return {
              status: roundTrip ? ('ok' as const) : ('fail' as const),
              evidence: `${ROUTER_POLICY_VERSION} · posture ${resolveRouterPosture()} · probe compiled ${r.plan.profile} (${r.plan.nodes.length} nodes) · decode ${roundTrip ? 'round-trips' : 'BROKE'}`,
              ...(roundTrip ? {} : { fix: 'The stored route plan no longer round-trips — report this.' }),
            }
          },
        },
        {
          id: 'router-store',
          label: 'Route store',
          run: async () => {
            const { routerEnabled } = await import('./router/routerGates.js')
            if (!routerEnabled()) return { status: 'info' as const, evidence: 'off (MERCURY_ROUTER=0)' }
            const { routerRunStore, routerStateDir } = await import('../substrate/routerRunStore.js')
            const { routerOutcomeStore } = await import('../substrate/routerOutcomeStore.js')
            const s = await routerRunStore().read()
            const outcomes = await routerOutcomeStore().read()
            const active = s.plans.filter(p => p.state === 'running' || p.state === 'synthesizing').length
            const refused = s.events.filter(e => e.to.startsWith('refused')).length
            return {
              status: 'ok' as const,
              evidence: `${routerStateDir()} · ${s.plans.length} plan(s) (${active} active) · ${s.events.length} event(s)${refused > 0 ? ` · ${refused} refused transition(s) (inspect /router)` : ''} · outcome memory ${outcomes.rows.length} row(s)`,
            }
          },
        },
        {
          id: 'router-providers',
          label: 'Provider slots',
          run: async () => {
            const { refreshProviderDiscovery } = await import('./router/providerDiscovery.js')
            await Promise.all([
              refreshProviderDiscovery('openai'),
              refreshProviderDiscovery('zai'),
              refreshProviderDiscovery('local'),
            ])
            const { buildRouterModelSnapshot } = await import('./router/modelRegistry.js')
            const snap = buildRouterModelSnapshot()
            const anthropic = snap.providers.find(p => p.id === 'anthropic')
            const classes = (['opus', 'sonnet', 'fable'] as const).map(c => snap.resolve(c, 'adaptive'))
            const engines = snap.providers.filter(p => p.id !== 'anthropic')
            const ENGINE_UNAVAILABLE_CODES = [
              'discovery-pending:',
              'no-executable:',
              'no-auth:',
              'no-api-key:',
              'no-account:',
              'not-configured:',
              'no-server:',
              'no-credential:',
            ]
            const enginesHonest = engines.every(
              p => p.available || ENGINE_UNAVAILABLE_CODES.some(code => p.reason?.startsWith(code)),
            )
            const gptRef = snap.resolve('gpt', 'adaptive')
            const glmRef = snap.resolve('glm', 'adaptive')
            const seatLawHolds =
              (gptRef === null || (gptRef.provider === 'openai' && gptRef.modelClass === 'gpt')) &&
              (glmRef === null || (glmRef.provider === 'zai' && glmRef.modelClass === 'glm'))
            const haikuRefused = snap.resolveExact('claude-haiku-4-5') === null
            const ok = anthropic?.available === true && classes.every(c => c !== null) && enginesHonest && seatLawHolds && haikuRefused
            const engineLine = engines.map(p => `${p.id} ${p.available ? 'configured' : p.reason}`).join(' · ')
            const seatLine = gptRef || glmRef
              ? `engine seats: ${[gptRef ? `gpt→${gptRef.model}` : null, glmRef ? `glm→${glmRef.model}` : null].filter(Boolean).join(' · ')} (explicit slots only)`
              : 'engine seats unresolved (no qualified candidate) — defaults stay Anthropic'
            return {
              status: ok ? ('ok' as const) : ('fail' as const),
              evidence: ok
                ? `anthropic configured (${classes.map(c => c!.model).join(' · ')}) · engines: ${engineLine} · ${seatLine} · haiku pin refused`
                : `provider honesty broke: anthropic=${anthropic?.available} classes=[${classes.map(c => c?.model ?? 'null').join(',')}] engines-honest=${enginesHonest} seat-law=${seatLawHolds} haiku-refused=${haikuRefused} (${engineLine})`,
              ...(ok ? {} : { fix: 'Provider resolution broke an invariant — report this.' }),
            }
          },
        },
      ],
    },
    {
      id: 'architecture-fast',
      title: 'ARCHITECTURE PRIMITIVES',
      checks: [
        {
          id: 'owner-vocabulary',
          label: 'Store owners',
          run: async () => {
            const { ownerLifecycleCounts } = await import('../services/run/ownerLifecycle.js')
            const counts = ownerLifecycleCounts()
            const names = Object.keys(counts.stores)
            return {
              status: names.length >= 3 ? ('ok' as const) : ('warn' as const),
              evidence: `${names.length} owner-scoped store(s) on ONE disposal registry · ${counts.adhoc} ad-hoc disposer(s)`,
              ...(names.length < 3 ? { fix: 'Core stores failed to register — rebuild; report it if it persists.' } : {}),
            }
          },
        },
        {
          id: 'primitive-resources',
          label: 'Resource kinds',
          run: async () => {
            const { resourceAdapterKinds } = await import('../services/resources/registry.js')
            const kinds = resourceAdapterKinds().map(k => k.kind)
            const wanted = ['owner', 'execution', 'transaction', 'evidence']
            const missing = wanted.filter(k => !kinds.includes(k))
            return {
              status: missing.length === 0 ? ('ok' as const) : ('fail' as const),
              evidence:
                missing.length === 0
                  ? `owner · execution · transaction · evidence all registered (${kinds.length} kinds total)`
                  : `missing primitive kind(s): ${missing.join(', ')}`,
              ...(missing.length > 0 ? { fix: 'The primitive adapters failed to register — rebuild; report it if it persists.' } : {}),
            }
          },
        },
        {
          id: 'execution-census',
          label: 'Execution domains',
          run: async () => {
            const { executionDomainKinds, executionPlaneCounts } = await import(
              '../services/primitives/executionPlane.js'
            )
            const { censusPlaneKinds } = await import('../services/primitives/executionCensus.js')
            const registered = executionDomainKinds()
            const covered = censusPlaneKinds()
            const unclassified = registered.filter(k => !covered.includes(k))
            const counts = executionPlaneCounts()
            return {
              status: unclassified.length === 0 ? ('ok' as const) : ('fail' as const),
              evidence:
                unclassified.length === 0
                  ? `${registered.length} domain(s) with hooks, all census-classified · ${counts.records} record(s), ${counts.live} live, ${counts.owners} owner(s)`
                  : `UNCLASSIFIED execution domain(s): ${unclassified.join(', ')} — add census rows (executionCensus.ts)`,
              ...(unclassified.length > 0 ? { fix: 'A new execution domain is unclassified — report this.' } : {}),
            }
          },
        },
        {
          id: 'primitive-consistency',
          label: 'Record consistency',
          run: async () => {
            const { listExecutions } = await import('../services/primitives/executionPlane.js')
            const { isTerminalExecutionState } = await import('../services/primitives/execution.js')
            const { processMainOwner } = await import('../services/run/resolveOwner.js')
            const { transactionsFor } = await import('../services/primitives/transactionPlane.js')
            const owner = processMainOwner()
            const records = listExecutions(owner, { limit: 500 })
            const inconsistent = records.filter(
              r =>
                (isTerminalExecutionState(r.state) && r.settledAt === undefined) ||
                (!isTerminalExecutionState(r.state) && r.settledAt !== undefined),
            )
            const orphanTxns = transactionsFor(owner).filter(
              t => ['applied', 'checking', 'verified'].includes(t.state) && !t.effectRef,
            )
            const ok = inconsistent.length === 0 && orphanTxns.length === 0
            return {
              status: ok ? ('ok' as const) : ('fail' as const),
              evidence: ok
                ? `no inconsistent state/settledAt pairs · no post-apply transaction without an effect ref (${records.length} execution(s) scanned)`
                : `${inconsistent.length} inconsistent execution(s), ${orphanTxns.length} effect-less applied transaction(s)`,
            }
          },
        },
        {
          id: 'view-coverage',
          label: 'View coverage',
          run: async () => {
            const { cardTone } = await import('../components/mercury-ui/toolCardGrammar.js')
            const { EXECUTION_STATES, TRANSACTION_STATES, executionCardState, transactionCardState } =
              await import('../services/primitives/index.js')
            const fallback = cardTone('__unknown__')
            const unmapped = [
              ...EXECUTION_STATES.map(s => executionCardState(s)),
              ...TRANSACTION_STATES.map(s => transactionCardState(s)),
            ].filter(s => {
              const t = cardTone(s)
              return t.glyph === fallback.glyph && t.tone === fallback.tone
            })
            return {
              status: unmapped.length === 0 ? ('ok' as const) : ('fail' as const),
              evidence:
                unmapped.length === 0
                  ? `every execution + transaction state maps onto the ONE card grammar`
                  : `unmapped state(s): ${[...new Set(unmapped)].join(', ')} — extend toolCardGrammar`,
            }
          },
        },
        {
          id: 'runtime-kernel',
          label: 'Runtime kernel',
          run: async () => {
            const { runtimeKernel } = await import('../services/primitives/runtimeKernel.js')
            const caps = runtimeKernel().capabilities()
            const provided = Object.entries(caps)
              .filter(([k, v]) => k !== 'notes' && v === true)
              .map(([k]) => k)
            return {
              status: 'ok' as const,
              evidence: `provided: ${provided.join(', ') || 'none'} (hash=${runtimeKernel().hash.id}) · absent capabilities name their owning facilities`,
            }
          },
        },
      ],
    },
  ]

  const depth = opts?.depth ?? 'fast'
  if (depth === 'deep') {
    const probes = await import('./healthDeepProbes.js')
    specs.push(
      {
        id: 'run-kernel',
        title: 'AUTONOMOUS RUN',
        checks: [
          {
            id: 'run-kernel-roundtrip',
            label: 'Run kernel',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 20_000,
            run: () => probes.probeRunKernel(),
          },
          {
            id: 'effect-observer',
            label: 'Effect observer',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 15_000,
            run: () => probes.probeEffectObserver(),
          },
        ],
      },
      {
        id: 'context-lifecycle',
        title: 'CONTEXT',
        checks: [
          {
            id: 'context-parity',
            label: 'Request-plan parity',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 20_000,
            run: () => probes.probeContextParity(),
          },
        ],
      },
      {
        id: 'ide-loop',
        title: 'IDE LOOP',
        checks: [
          {
            id: 'lsp-engine',
            label: 'LSP engine',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 20_000,
            run: () => probes.probeLspEngine(),
          },
          {
            id: 'lsp-live-lane',
            label: 'LSP live lane',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 25_000,
            run: () => probes.probeLspLiveLane(),
          },
          {
            id: 'dap-engine',
            label: 'DAP engine',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 30_000,
            run: ctx => probes.probeDapEngine(ctx?.signal),
          },
          {
            id: 'python-debugger',
            label: 'Python debugger',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 45_000,
            run: ctx => probes.probePythonDebugger(ctx?.signal),
          },
          {
            id: 'js-debugger',
            label: 'JS debugger boot',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 15_000,
            run: ctx => probes.probeJsDebugBoot(ctx?.signal),
          },
        ],
      },
      {
        id: 'axiom-deep',
        title: 'ARCHITECTURE',
        checks: [
          {
            id: 'axiom-primitives',
            label: 'Primitive journey',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 20_000,
            run: () => probes.probeAxiomPrimitives(),
          },
        ],
      },
      {
        id: 'vanguard',
        title: 'CODING LOOP',
        checks: [
          {
            id: 'change-transaction',
            label: 'Change transaction',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 15_000,
            run: () => probes.probeChangeTransaction(),
          },
          {
            id: 'workshop-js',
            label: 'Workshop js/ts',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 20_000,
            run: () => probes.probeWorkshopJs(),
          },
          {
            id: 'workshop-py',
            label: 'Workshop python',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 25_000,
            run: () => probes.probeWorkshopPython(),
          },
          {
            id: 'service-lifecycle',
            label: 'Project services',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 25_000,
            run: () => probes.probeServiceLifecycle(),
          },
          {
            id: 'lane-journey',
            label: 'Side lanes',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 15_000,
            run: () => probes.probeLaneJourney(),
          },
          {
            id: 'counsel-loop',
            label: 'Counsel',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 15_000,
            run: () => probes.probeCounsel(),
          },
          {
            id: 'agent-envelope',
            label: 'Agent envelopes',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 15_000,
            run: () => probes.probeAgentEnvelope(),
          },
        ],
      },
      {
        id: 'arsenal-deep',
        title: 'TOOL CAPABILITY',
        checks: [
          {
            id: 'structure-loop',
            label: 'Structural loop',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 25_000,
            run: () => probes.probeStructureLoop(),
          },
          {
            id: 'git-graph',
            label: 'Git work graph',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 25_000,
            run: () => probes.probeGitGraph(),
          },
          {
            id: 'journey-loop',
            label: 'Application journey',
            depth: 'deep',
            probe: 'functional',
            timeoutMs: 45_000,
            run: () => probes.probeJourneyLoop(),
          },
        ],
      },
    )
  }

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
      await publishAtomic(
        lastCertPath(),
        JSON.stringify({ ...summarizeCert(cert), _v: 1 }, null, 2),
      )
    } catch {
    }
  }
  try {
    const { runLifecycleVerbOpportunity } = await import('./backgroundHousekeeping.js')
    await runLifecycleVerbOpportunity('doctor')
  } catch {
  }
  return cert
}
