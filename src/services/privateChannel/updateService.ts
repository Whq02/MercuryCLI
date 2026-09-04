import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { logForDebugging } from '../../utils/debug.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHECKSUM_MANIFEST_NAME,
  formatPrivateVersion,
  judgeExtractedLayout,
  lookupChecksum,
  parsePrivateVersion,
  PAYLOAD_ROOT,
  selectRelease,
  type ReleaseSelection,
} from './channelCore.js'
import { describeSignatureVerdict, type SignatureVerdict } from './artifactSigning.js'
import { verifyPayloadDir } from './artifactVerify.js'
import {
  channelRepoSlug,
  checkChannelAccess,
  downloadChannelAssets,
  listChannelReleases,
  type ChannelAccess,
  type ChannelAccessRefusal,
  type ChannelRoadName,
} from './channelTransport.js'
import {
  acquireUpdateLock,
  installPayload,
  listInstalledVersions,
  pathEntryEquals,
  readCurrentVersion,
  readCurrentVersionState,
  readPreviousVersion,
  releaseUpdateLock,
  restoreCurrent,
  runningPayloadDir,
  shimStatus,
  smokeVersion,
  sweepUpdaterResidue,
  switchCurrent,
  validatePayloadDir,
  versionDirIntact,
  writeShim,
  type LayoutRoots,
  type ShimOutcome,
} from './installLayout.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { describeRunningRuntime, payloadRuntimeLine, runningBundlePayloadDir, runtimeLine, type RunningRuntime } from './vendoredRuntime.js'

export function runningRuntime(): RunningRuntime {
  return describeRunningRuntime({
    payloadDir: runningBundlePayloadDir(),
    execPath: process.execPath,
    execVersion: process.versions.node,
    explicitNode: flagEnv('MERCURY_NODE') ?? null,
  })
}

export type ProgressLine =
  | 'checking'
  | 'release found'
  | 'downloading'
  | 'verifying'
  | 'staging'
  | 'activating'
  | 'complete'
  | 'restored previous version'
  | 'no update'
  | 'action required'

export type Progress = (state: ProgressLine, detail?: string) => void

export function installedVersionTruth(roots: LayoutRoots): { version: string; source: 'pointer' | 'running' } {
  const pointer = readCurrentVersion(roots)
  if (pointer) return { version: pointer, source: 'pointer' }
  return { version: MACRO.VERSION, source: 'running' }
}


export interface ChannelStatus {
  runningVersion: string
  installedVersion: string | null
  installedPointer: 'ok' | 'absent' | 'empty' | 'unreadable'
  previousVersion: string | null
  versionsPresent: string[]
  versionsDir: string
  shim: 'absent' | 'managed' | 'foreign'
  shimPath: string
  runtime: RunningRuntime
  channelRepo: string
  access: ChannelAccess
}

export async function channelStatus(roots: LayoutRoots): Promise<ChannelStatus> {
  const slug = channelRepoSlug()
  return {
    runningVersion: MACRO.VERSION,
    installedVersion: readCurrentVersion(roots),
    installedPointer: readCurrentVersionState(roots).state,
    previousVersion: readPreviousVersion(roots),
    versionsPresent: listInstalledVersions(roots),
    versionsDir: roots.versionsDir,
    shim: shimStatus(roots),
    shimPath: roots.shimPath,
    runtime: runningRuntime(),
    channelRepo: slug,
    access: await checkChannelAccess(slug),
  }
}

export const statusRuntimeLine = (status: Pick<ChannelStatus, 'runtime'>): string => runtimeLine(status.runtime)


export type CheckOutcome =
  | {
      state: 'update-available'
      installed: string
      tag: string
      version: string
      assetName: string
      channelRepo: string
      road: ChannelRoadName
      assetUrl: string | null
      checksumUrl: string | null
    }
  | { state: 'current'; installed: string; channelRepo: string; road: ChannelRoadName }
  | { state: 'no-releases'; installed: string; channelRepo: string; road: ChannelRoadName }
  | { state: 'access-unavailable'; access: ChannelAccessRefusal }
  | { state: 'unsupported-platform'; note: string }
  | { state: 'malformed-release'; tag: string; note: string }
  | { state: 'invalid-installed-version'; installed: string }
  | { state: 'pointer-unreadable'; note: string }

export async function checkForUpdate(roots: LayoutRoots, progress: Progress): Promise<CheckOutcome> {
  progress('checking')
  const slug = channelRepoSlug()
  const pointer = readCurrentVersionState(roots)
  if (pointer.state === 'unreadable') return { state: 'pointer-unreadable', note: pointer.note }
  const installed = installedVersionTruth(roots)
  const installedParsed = parsePrivateVersion(installed.version)
  if (!installedParsed) return { state: 'invalid-installed-version', installed: installed.version }

  const listed = await listChannelReleases(slug)
  if (listed.state !== 'ok') return { state: 'access-unavailable', access: listed.access }
  const selection: ReleaseSelection = selectRelease(listed.releases, installedParsed, process.platform, process.arch)
  switch (selection.state) {
    case 'update-available':
      progress('release found', `${selection.tag} (installed: ${installed.version})`)
      return {
        state: 'update-available',
        installed: installed.version,
        tag: selection.tag,
        version: formatPrivateVersion(selection.version),
        assetName: selection.assetName,
        channelRepo: slug,
        road: listed.road,
        assetUrl: selection.assetUrl,
        checksumUrl: selection.checksumUrl,
      }
    case 'current':
      progress('no update')
      return { state: 'current', installed: installed.version, channelRepo: slug, road: listed.road }
    case 'no-releases':
      progress('no update')
      return { state: 'no-releases', installed: installed.version, channelRepo: slug, road: listed.road }
    case 'unsupported-platform':
      return { state: 'unsupported-platform', note: selection.note }
    case 'malformed-release':
      return { state: 'malformed-release', tag: selection.tag, note: selection.note }
  }
}


export type UpdateStage =
  | 'lock'
  | 'download'
  | 'checksum'
  | 'extract-tool-absent'
  | 'extract'
  | 'envelope'
  | 'payload'
  | 'staged-smoke'
  | 'staging'
  | 'pointer'
  | 'post-switch-smoke'

export type UpdateOutcome =
  | {
      state: 'updated'
      from: string
      to: string
      previousKept: boolean
      shim: ShimOutcome
      road: ChannelRoadName
      signature: SignatureVerdict['state']
      receiptPath?: string
    }
  | { state: 'no-update'; check: CheckOutcome }
  | { state: 'refused'; stage: UpdateStage; reason: string; remedy: string; retryable?: boolean; road?: ChannelRoadName; receiptPath?: string }
  | { state: 'restored'; stage: UpdateStage; reason: string; activeVersion: string; road?: ChannelRoadName; receiptPath?: string }

const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

type ExtractOutcome = { state: 'ok' } | { state: 'tool-absent'; note: string } | { state: 'failed'; note: string }

function resolveWindowsShell(): string | null {
  for (const exe of ['pwsh', 'powershell']) {
    try {
      execFileSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { windowsHide: true, stdio: 'pipe', timeout: 30_000, env: { ...subprocessEnv() } })
      return exe
    } catch {
    }
  }
  return null
}

function extractArchive(archivePath: string, destDir: string, isWindows: boolean): ExtractOutcome {
  mkdirSync(destDir, { recursive: true })
  if (isWindows) {
    const shell = resolveWindowsShell()
    if (!shell) {
      return { state: 'tool-absent', note: 'no PowerShell found (pwsh or powershell) to expand the archive — install PowerShell 7' }
    }
    try {
      execFileSync(
        shell,
        ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:MERCURY_UPDATE_ARCHIVE -DestinationPath $env:MERCURY_UPDATE_DEST -Force'],
        { windowsHide: true, stdio: 'pipe', timeout: 300_000, env: { ...subprocessEnv(), MERCURY_UPDATE_ARCHIVE: archivePath, MERCURY_UPDATE_DEST: destDir } },
      )
      return { state: 'ok' }
    } catch (e) {
      return { state: 'failed', note: e instanceof Error ? e.message.slice(0, 200) : String(e) }
    }
  }
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', destDir], { windowsHide: true, stdio: 'pipe', timeout: 300_000, env: { ...subprocessEnv() } })
    return { state: 'ok' }
  } catch (e) {
    return { state: 'failed', note: e instanceof Error ? e.message.slice(0, 200) : String(e) }
  }
}

function writeUpdateReceipt(roots: LayoutRoots, startedAt: string, outcome: UpdateOutcome): string | null {
  try {
    mkdirSync(roots.versionsDir, { recursive: true })
    const path = join(roots.versionsDir, 'last-update.json')
    writeFileSync(
      path,
      JSON.stringify(
        {
          schema: 1,
          txn: `${process.pid}-${startedAt}`,
          startedAt,
          finishedAt: new Date().toISOString(),
          outcome: outcome.state,
          stage: 'stage' in outcome ? outcome.stage : outcome.state === 'updated' ? 'complete' : undefined,
          ...('road' in outcome && outcome.road !== undefined ? { road: outcome.road } : {}),
          ...(outcome.state === 'updated' ? { from: outcome.from, to: outcome.to, signature: outcome.signature } : {}),
          ...(outcome.state === 'refused' ? { reason: outcome.reason, retryable: outcome.retryable ?? false } : {}),
          ...(outcome.state === 'restored' ? { reason: outcome.reason, activeVersion: outcome.activeVersion } : {}),
        },
        null,
        1,
      ) + '\n',
    )
    return path
  } catch {
    return null
  }
}

export async function performUpdate(roots: LayoutRoots, progress: Progress): Promise<UpdateOutcome> {
  const startedAt = new Date().toISOString()
  const outcome = await performUpdateTransaction(roots, progress)
  if (outcome.state === 'no-update') return outcome
  const receiptPath = writeUpdateReceipt(roots, startedAt, outcome)
  return receiptPath ? { ...outcome, receiptPath } : outcome
}

async function performUpdateTransaction(roots: LayoutRoots, progress: Progress): Promise<UpdateOutcome> {
  const check = await checkForUpdate(roots, progress)
  if (check.state !== 'update-available') return { state: 'no-update', check }
  const outcome = await acquireAndActivate(roots, progress, check)
  return outcome.state === 'refused' || outcome.state === 'restored' ? { ...outcome, road: check.road } : outcome
}

async function acquireAndActivate(
  roots: LayoutRoots,
  progress: Progress,
  check: Extract<CheckOutcome, { state: 'update-available' }>,
): Promise<UpdateOutcome> {
  const lock = acquireUpdateLock(roots)
  if (lock.state === 'held') {
    return {
      state: 'refused',
      stage: 'lock',
      reason: `another update is already running${lock.byPid ? ` (pid ${lock.byPid})` : ''}`,
      remedy: 'wait for it to finish; if it crashed, remove <versions>/.update.lock and retry',
    }
  }
  sweepUpdaterResidue(roots)
  const staging = join(roots.versionsDir, `.download-${process.pid}`)
  try {
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })

    progress('downloading', `${check.assetName} + ${CHECKSUM_MANIFEST_NAME} from ${check.tag} (${check.road === 'gh' ? 'through gh' : 'anonymously'})`)
    const dl = await downloadChannelAssets(
      check.road,
      check.channelRepo,
      check.tag,
      [
        { name: check.assetName, url: check.assetUrl },
        { name: CHECKSUM_MANIFEST_NAME, url: check.checksumUrl },
      ],
      staging,
    )
    if (dl.state !== 'ok') return { state: 'refused', stage: 'download', reason: dl.note, remedy: dl.remedy, retryable: true }

    progress('verifying')
    const archivePath = join(staging, check.assetName)
    const sumsPath = join(staging, CHECKSUM_MANIFEST_NAME)
    if (!existsSync(archivePath))
      return { state: 'refused', stage: 'download', reason: `download finished but ${check.assetName} is absent`, remedy: 'rerun `mercury update`', retryable: true }
    if (!existsSync(sumsPath))
      return { state: 'refused', stage: 'download', reason: `download finished but ${CHECKSUM_MANIFEST_NAME} is absent`, remedy: 'rerun `mercury update`', retryable: true }
    const looked = lookupChecksum(readFileSync(sumsPath, 'utf8'), check.assetName)
    if (looked.state !== 'ok') {
      return {
        state: 'refused',
        stage: 'checksum',
        reason:
          looked.state === 'missing-entry'
            ? `${CHECKSUM_MANIFEST_NAME} has no entry for ${check.assetName}`
            : looked.state === 'duplicate-entry'
              ? `${CHECKSUM_MANIFEST_NAME} lists ${check.assetName} ${looked.count} times`
              : `checksum manifest malformed: ${looked.note}`,
        remedy: 'the release publication is inconsistent — report it; nothing was activated',
      }
    }
    const actual = sha256File(archivePath)
    if (actual !== looked.sha256) {
      return {
        state: 'refused',
        stage: 'checksum',
        reason: `SHA-256 mismatch for ${check.assetName} (expected ${looked.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
        remedy: 'the downloaded bytes do not match the release manifest — rerun `mercury update`; nothing was activated',
        retryable: true,
      }
    }

    const extracted = join(staging, 'extracted')
    const extraction = extractArchive(archivePath, extracted, roots.isWindows)
    if (extraction.state === 'tool-absent') {
      return { state: 'refused', stage: 'extract-tool-absent', reason: extraction.note, remedy: 'install PowerShell 7 (pwsh) and rerun `mercury update`' }
    }
    if (extraction.state === 'failed') {
      return {
        state: 'refused',
        stage: 'extract',
        reason: `archive extraction failed: ${extraction.note}`,
        remedy: 'rerun `mercury update` — the download may have been interrupted',
        retryable: true,
      }
    }
    const layout = judgeExtractedLayout(
      readdirSync(extracted),
      existsSync(join(extracted, PAYLOAD_ROOT)) ? readdirSync(join(extracted, PAYLOAD_ROOT)) : [],
    )
    if (layout.state !== 'ok') {
      return { state: 'refused', stage: 'envelope', reason: `unexpected archive layout: ${layout.note}`, remedy: 'report the release as malformed; nothing was activated' }
    }
    const payloadDir = join(extracted, PAYLOAD_ROOT)
    const payload = validatePayloadDir(payloadDir)
    if (payload.state !== 'ok') {
      return { state: 'refused', stage: 'payload', reason: `payload incomplete: ${payload.note}`, remedy: 'report the release as malformed; nothing was activated' }
    }
    if (payload.version !== check.version) {
      return {
        state: 'refused',
        stage: 'payload',
        reason: `embedded version ${payload.version} does not equal the selected release ${check.version}`,
        remedy: 'report the release as malformed; nothing was activated',
      }
    }
    const provenance = verifyPayloadDir(payloadDir, { depth: 'deep' })
    progress('verifying', `signature: ${describeSignatureVerdict(provenance.verdict)}`)

    progress('staging')
    const staged = smokeVersion(payloadDir, check.version, payload.bundle)
    if (staged.state !== 'ok') {
      return { state: 'refused', stage: 'staged-smoke', reason: `staged smoke failed: ${staged.note}`, remedy: 'nothing was activated; report this build' }
    }
    const installed = installPayload(roots, payloadDir, check.version)
    if (installed.state === 'failed') {
      return {
        state: 'refused',
        stage: 'staging',
        reason: `staging into the versions directory failed: ${installed.note}`,
        remedy: installed.retryable ? 'nothing was activated; rerun `mercury update`' : 'nothing was activated; free disk space and retry',
        retryable: installed.retryable,
      }
    }

    progress('activating', check.version)
    const from = check.installed
    let previous: string | null
    try {
      previous = switchCurrent(roots, check.version).previous
    } catch (e) {
      return {
        state: 'refused',
        stage: 'pointer',
        reason: `pointer selection failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
        remedy: 'the active installation is unchanged; rerun `mercury update`',
        retryable: true,
      }
    }
    const post = smokeVersion(join(roots.versionsDir, check.version), check.version, payload.bundle)
    if (post.state !== 'ok') {
      if (previous) restoreCurrent(roots, previous)
      progress('restored previous version', previous ?? '(none)')
      return {
        state: 'restored',
        stage: 'post-switch-smoke',
        reason: `post-switch smoke failed: ${post.note}`,
        activeVersion: previous ?? from,
      }
    }
    const shim = writeShim(roots)
    progress('complete', check.version)
    return {
      state: 'updated',
      from,
      to: check.version,
      previousKept: previous !== null && versionDirIntact(roots, previous),
      shim,
      road: check.road,
      signature: provenance.verdict.state,
    }
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch (sweepError) {
      logForDebugging(`update: staging sweep failed (ignored — the verdict stands): ${String(sweepError)}`)
    }
    releaseUpdateLock(roots)
  }
}


export type RollbackOutcome =
  | { state: 'rolled-back'; from: string | null; to: string }
  | { state: 'refused'; reason: string; remedy: string }

export async function performRollback(roots: LayoutRoots, progress: Progress): Promise<RollbackOutcome> {
  const current = readCurrentVersion(roots)
  const previous = readPreviousVersion(roots)
  if (!previous) {
    return {
      state: 'refused',
      reason: 'no previous installed version is recorded for this managed install',
      remedy: 'nothing to roll back to — install an older release archive explicitly if you need one',
    }
  }
  if (!versionDirIntact(roots, previous)) {
    return {
      state: 'refused',
      reason: `the previous version ${previous} is no longer intact under ${roots.versionsDir}`,
      remedy: 'download and install that release archive again if you need it',
    }
  }
  const lock = acquireUpdateLock(roots)
  if (lock.state === 'held') {
    return {
      state: 'refused',
      reason: `another update is already running${lock.byPid ? ` (pid ${lock.byPid})` : ''}`,
      remedy: 'wait for it to finish; if it crashed, remove <versions>/.update.lock and retry',
    }
  }
  try {
    progress('activating', previous)
    const prevDir = join(roots.versionsDir, previous)
    const prevCheck = validatePayloadDir(prevDir)
    const smoke = smokeVersion(prevDir, previous, prevCheck.state === 'ok' ? prevCheck.bundle : undefined)
    if (smoke.state !== 'ok') {
      return { state: 'refused', reason: `the previous version fails its start smoke: ${smoke.note}`, remedy: 'the active version was left unchanged' }
    }
    switchCurrent(roots, previous)
    progress('complete', previous)
    return { state: 'rolled-back', from: current, to: previous }
  } finally {
    releaseUpdateLock(roots)
  }
}


export type InstallVerbOutcome =
  | {
      state: 'installed'
      version: string
      versionDir: string
      changed: boolean
      activated: boolean
      shim: ReturnType<typeof writeShim>
      binDirOnPath: boolean
    }
  | { state: 'refused'; reason: string; remedy: string }
  | { state: 'dry-run'; version: string | null; wouldInstallTo: string; shimPath: string; runtime: string; note: string }

export function describeInstall(roots: LayoutRoots): InstallVerbOutcome {
  const payloadDir = runningPayloadDir()
  const payload = validatePayloadDir(payloadDir)
  return {
    state: 'dry-run',
    version: payload.state === 'ok' ? payload.version : null,
    wouldInstallTo: join(roots.versionsDir, payload.state === 'ok' ? payload.version : '<version>'),
    shimPath: roots.shimPath,
    runtime: payloadRuntimeLine(payloadDir),
    note:
      payload.state === 'ok'
        ? 'no changes made (dry run); configuration and sessions are never touched'
        : `refusal expected: ${payload.note}`,
  }
}

export async function performInstall(roots: LayoutRoots, progress: Progress, opts: { force?: boolean } = {}): Promise<InstallVerbOutcome> {
  const payloadDir = runningPayloadDir()
  const payload = validatePayloadDir(payloadDir)
  if (payload.state !== 'ok') {
    return {
      state: 'refused',
      reason: payload.note,
      remedy: 'run `mercury install` from the mercury/ directory of an extracted release archive (its own launcher)',
    }
  }
  const lock = acquireUpdateLock(roots)
  if (lock.state === 'held') {
    return {
      state: 'refused',
      reason: `another install/update is already running${lock.byPid ? ` (pid ${lock.byPid})` : ''}`,
      remedy: 'wait for it to finish; if it crashed, remove <versions>/.update.lock and retry',
    }
  }
  sweepUpdaterResidue(roots)
  try {
    progress('staging', payload.version)
    const installed = installPayload(roots, payloadDir, payload.version)
    if (installed.state === 'failed') {
      return { state: 'refused', reason: installed.note, remedy: 'free disk space and rerun `mercury install`' }
    }
    const staged = smokeVersion(installed.versionDir, payload.version, payload.bundle)
    if (staged.state !== 'ok') {
      return { state: 'refused', reason: `installed copy fails its smoke: ${staged.note}`, remedy: 're-extract the archive and rerun `mercury install`' }
    }
    progress('activating', payload.version)
    const before = readCurrentVersion(roots)
    switchCurrent(roots, payload.version)
    const post = smokeVersion(join(roots.versionsDir, payload.version), payload.version, payload.bundle)
    if (post.state !== 'ok') {
      if (before) restoreCurrent(roots, before)
      return { state: 'refused', reason: `post-activation smoke failed: ${post.note}`, remedy: 'the previous pointer was restored' }
    }
    const shim = writeShim(roots, { force: opts.force })
    const binDirOnPath = (process.env.PATH ?? '')
      .split(roots.isWindows ? ';' : ':')
      .some(p => pathEntryEquals(p, roots.binDir, roots.isWindows))
    progress('complete', payload.version)
    return {
      state: 'installed',
      version: payload.version,
      versionDir: installed.versionDir,
      changed: installed.changed,
      activated: true,
      shim,
      binDirOnPath,
    }
  } finally {
    releaseUpdateLock(roots)
  }
}
