import { realpathSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

import { bundleArgOf, bundleDirOf, sameBundlePath, type ProcessSweepCensus } from '../../daemon/processSweep.js'
import type { ProcessSweepDeps } from '../../daemon/processSweepRun.js'

const NO_OWN_BUNDLE = 'this process does not run from a mercury.mjs it can name, so it cannot tell its own build from another'

function resolved(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

export function otherBuildIn(census: ProcessSweepCensus, selfPid: number, ownBundle: string, ownBundleWrittenMs: number): string | null {
  if (!census.complete) return `the process table could not be read (${census.error ?? 'incomplete'})`
  const self = census.entries.find(entry => entry.process.pid === selfPid)
  if (self === undefined || !(self.process.startedAtMs > 0)) return 'this process was not found in the process table with its start time'
  if (self.process.startedAtMs < ownBundleWrittenMs) return 'this process started before its bundle was last written'
  const paths = census.platform === 'win32' ? win32 : posix
  for (const entry of census.entries) {
    const other = entry.process
    if (other.pid === selfPid || entry.state.startsWith('Z')) continue
    if (other.user !== '' && self.process.user !== '' && other.user !== self.process.user) continue
    if (other.args.length === 0) return `the command line of process ${other.pid} could not be read`
    const bundle = bundleArgOf(other.args)
    if (bundle === null) continue
    if (!paths.isAbsolute(bundle)) return `process ${other.pid} names its bundle by a relative path (${bundle})`
    if (!sameBundlePath(ownBundle, resolved(bundle), census.platform)) return `another Mercury build is running (process ${other.pid}, ${bundleDirOf(bundle)})`
    if (!(other.startedAtMs > 0)) return `the start time of process ${other.pid} could not be read`
    if (other.startedAtMs < ownBundleWrittenMs) return `process ${other.pid} started before this build was written`
  }
  return null
}

export async function otherBuildAlive(deps: ProcessSweepDeps = {}): Promise<string | null> {
  try {
    const { ownBundlePath, readMercuryProcesses } = await import('../../daemon/processSweepRun.js')
    const ownBundle = ownBundlePath(deps.bundle)
    if (ownBundle === null) return NO_OWN_BUNDLE
    let written: number
    try {
      const stat = statSync(ownBundle)
      written = Math.max(stat.mtimeMs, stat.ctimeMs)
    } catch {
      return NO_OWN_BUNDLE
    }
    const census = await readMercuryProcesses({
      rpc: async () => ({ ok: false, code: 'ENOTSUP', error: 'the credential store reads command lines only' }),
      ...deps,
    })
    return otherBuildIn(census, process.pid, ownBundle, written)
  } catch (error) {
    return `the Mercury processes could not be read (${error instanceof Error ? error.message : String(error)})`
  }
}
