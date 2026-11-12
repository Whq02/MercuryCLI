import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, posix, win32 } from 'node:path'

import { bundleArgOf, bundleDirOf, sameBundlePath, tokenBinding, type ProcessSweepCensus, type ProcessSweepEntry } from '../../daemon/processSweep.js'
import type { ProcessSweepDeps } from '../../daemon/processSweepRun.js'
import { runningBuildTree } from '../artifactIdentity.js'
import { getMercuryHome } from '../envUtils.js'

const NO_OWN_BUNDLE = 'this process does not run from a mercury.mjs it can name, so it cannot tell its own build from another'

type OwnRecord = { pid: number; startToken: string | null; buildTree: string | null }

export interface OwnBuild {
  bundle: string
  putInPlaceMs: number
  buildTree: string | null
}

export interface OtherBuildsDeps extends ProcessSweepDeps {
  ownBuildTree?: string | null
  realpath?: (path: string) => string | null
}

function realPathOf(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

function ownBundleAtLoad(): string | null {
  const bundle = process.argv[1]
  if (typeof bundle !== 'string' || bundleArgOf([bundle]) === null) return null
  return realPathOf(bundle)
}

const BUNDLE_AT_LOAD = ownBundleAtLoad()

function asWritten(path: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return path
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`
  return path.startsWith('\\\\?\\') ? path.slice(4) : path
}

function recordOf(records: readonly OwnRecord[], entry: ProcessSweepEntry): OwnRecord | 'none' | 'unknown' {
  let unknown = false
  for (const record of records) {
    if (record.pid !== entry.process.pid) continue
    const binding = tokenBinding(record.startToken, entry.startToken)
    if (binding === 'bound') return record
    if (binding === 'uncertain') unknown = true
  }
  return unknown ? 'unknown' : 'none'
}

export function otherBuildIn(
  census: ProcessSweepCensus,
  selfPid: number,
  own: OwnBuild,
  records: readonly OwnRecord[],
  realpath: (path: string) => string | null,
): string | null {
  if (!census.complete) return `the process table could not be read (${census.error ?? 'incomplete'})`
  const self = census.entries.find(entry => entry.process.pid === selfPid)
  if (self === undefined || !(self.process.startedAtMs > 0)) return 'this process was not found in the process table with its start time'
  if (self.process.startedAtMs < own.putInPlaceMs) return 'this process started before its bundle was last put in place'
  const paths = census.platform === 'win32' ? win32 : posix
  for (const entry of census.entries) {
    const other = entry.process
    if (other.pid === selfPid || entry.state.startsWith('Z')) continue
    if (other.user !== '' && self.process.user !== '' && other.user !== self.process.user) continue
    const written = recordOf(records, entry)
    if (written === 'unknown') return `a record names process ${other.pid}, and whether it is that process's own could not be told`
    if (written !== 'none') {
      if (own.buildTree === null) return `process ${other.pid} wrote a record of itself, and this process has no build mark to hold against it`
      if (written.buildTree === null) return `an older Mercury build is running (process ${other.pid}: its record carries no build mark)`
      if (written.buildTree !== own.buildTree) return `another Mercury build is running (process ${other.pid}, build ${written.buildTree})`
      continue
    }
    if (other.args.length === 0) return `the command line of process ${other.pid} could not be read`
    const bundle = bundleArgOf(other.args)
    if (bundle === null) continue
    const spelled = asWritten(bundle, census.platform)
    if (!paths.isAbsolute(spelled)) return `process ${other.pid} names its bundle by a relative path (${bundle})`
    const real = realpath(spelled)
    if (real === null) return `the bundle of process ${other.pid} could not be resolved (${bundle})`
    if (!sameBundlePath(real, spelled, census.platform)) return `process ${other.pid} names its bundle by a path that is not its real path (${bundle})`
    if (!sameBundlePath(own.bundle, real, census.platform)) return `another Mercury build is running (process ${other.pid}, ${bundleDirOf(bundle)})`
    if (!(other.startedAtMs > 0)) return `the start time of process ${other.pid} could not be read`
    if (other.startedAtMs < own.putInPlaceMs) return `process ${other.pid} started before this build was put in place`
  }
  return null
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function recordsOf(home: string, ownDaemonDir: string): OwnRecord[] | null {
  const records: OwnRecord[] = []
  const daemonDirs = new Set([ownDaemonDir, join(home, 'daemon')])
  const windows = join(home, 'processes')
  let names: string[] = []
  try {
    names = readdirSync(windows)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
  }
  for (const name of names) {
    const named = /^cockpit-(\d+)-[0-9a-f-]+\.json$/.exec(name)
    if (named === null) continue
    try {
      const raw = JSON.parse(readFileSync(join(windows, name), 'utf8')) as Record<string, unknown>
      records.push({ pid: typeof raw.pid === 'number' ? raw.pid : Number(named[1]), startToken: textOf(raw.startToken), buildTree: textOf(raw.buildTree) })
      const daemonDir = textOf(raw.daemonDir)
      if (daemonDir !== null) daemonDirs.add(daemonDir)
    } catch {
      records.push({ pid: Number(named[1]), startToken: null, buildTree: null })
    }
  }
  for (const dir of daemonDirs) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, 'daemon.json'), 'utf8')) as Record<string, unknown>
      if (typeof raw.pid === 'number') records.push({ pid: raw.pid, startToken: textOf(raw.startInstant) ?? textOf(raw.startToken), buildTree: textOf(raw.buildTree) })
    } catch {
    }
  }
  return records
}

export async function otherBuildAlive(deps: OtherBuildsDeps = {}): Promise<string | null> {
  try {
    const bundle = deps.bundle === undefined ? BUNDLE_AT_LOAD : bundleArgOf([deps.bundle]) === null ? null : realPathOf(deps.bundle)
    if (bundle === null) return NO_OWN_BUNDLE
    let putInPlaceMs: number
    try {
      const file = statSync(bundle)
      putInPlaceMs = Math.max(file.mtimeMs, file.ctimeMs, statSync(dirname(bundle)).ctimeMs)
    } catch {
      return NO_OWN_BUNDLE
    }
    const { readMercuryProcesses } = await import('../../daemon/processSweepRun.js')
    const { daemonDir } = await import('../../daemon/controlSocket.js')
    const home = deps.home ?? getMercuryHome()
    const records = recordsOf(home, deps.ownDaemonDir ?? daemonDir())
    if (records === null) return 'the records of this home\'s windows could not be read'
    const census = await readMercuryProcesses({
      rpc: async () => ({ ok: false, code: 'ENOTSUP', error: 'the credential store reads command lines only' }),
      ...deps,
    })
    const own: OwnBuild = { bundle, putInPlaceMs, buildTree: deps.ownBuildTree === undefined ? runningBuildTree() : deps.ownBuildTree }
    return otherBuildIn(census, process.pid, own, records, deps.realpath ?? realPathOf)
  } catch (error) {
    return `the Mercury processes could not be read (${error instanceof Error ? error.message : String(error)})`
  }
}
