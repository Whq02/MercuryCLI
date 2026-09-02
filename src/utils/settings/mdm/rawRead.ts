import { execFile } from 'node:child_process'
import { subprocessEnv } from '../../subprocessEnv.js'
import { existsSync } from 'node:fs'

import {
  getMacOSPlistPaths,
  LEGACY_WINDOWS_REGISTRY_KEY_PATH_HKCU,
  LEGACY_WINDOWS_REGISTRY_KEY_PATH_HKLM,
  MDM_SUBPROCESS_TIMEOUT_MS,
  PLUTIL_ARGS_PREFIX,
  PLUTIL_PATH,
  WINDOWS_REGISTRY_KEY_PATH_HKCU,
  WINDOWS_REGISTRY_KEY_PATH_HKLM,
  WINDOWS_REGISTRY_VALUE_NAME,
} from './constants.js'

/**
 * Subprocess reads of plist/registry policy. Deliberately import-light so
 * it can be fired at process start, before heavy modules load, and
 * awaited later. A non-zero exit or a timeout is "no data", never an
 * exception.
 */

export type RawReadResult = {
  /** On macOS: the single winning entry, or [] when no candidate won. Null on Windows and elsewhere. */
  plistStdouts: Array<{ stdout: string; label: string }> | null
  hklmStdout: string | null
  hkcuStdout: string | null
}

function runSubprocess(command: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    execFile(command, args, { windowsHide: true, timeout: MDM_SUBPROCESS_TIMEOUT_MS, env: { ...subprocessEnv() } }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      resolve(stdout)
    })
  })
}

async function readMacOSPlists(): Promise<Array<{ stdout: string; label: string }>> {
  // Candidates whose file does not exist are skipped WITHOUT spawning —
  // non-managed machines never carry these files and a spawn costs
  // milliseconds even to fail. The existence check is synchronous so the
  // first real spawn still fires before the event loop yields.
  const candidates = getMacOSPlistPaths().filter(candidate => {
    try {
      return existsSync(candidate.path)
    } catch {
      return false
    }
  })
  const outputs = await Promise.all(
    candidates.map(async candidate => ({
      candidate,
      stdout: await runSubprocess(PLUTIL_PATH, [...PLUTIL_ARGS_PREFIX, candidate.path]),
    })),
  )
  // First candidate (in priority order) with a successful, non-empty
  // output wins.
  for (const { candidate, stdout } of outputs) {
    if (stdout !== null && stdout.trim() !== '') {
      return [{ stdout, label: candidate.label }]
    }
  }
  return []
}

async function readWindowsRegistry(): Promise<{ hklmStdout: string | null; hkcuStdout: string | null }> {
  // Four queries concurrently; per hive the Mercury key wins on a
  // successful exit, the imported key is the fallback.
  const [hklmMercury, hklmLegacy, hkcuMercury, hkcuLegacy] = await Promise.all([
    runSubprocess('reg', ['query', WINDOWS_REGISTRY_KEY_PATH_HKLM, '/v', WINDOWS_REGISTRY_VALUE_NAME]),
    runSubprocess('reg', ['query', LEGACY_WINDOWS_REGISTRY_KEY_PATH_HKLM, '/v', WINDOWS_REGISTRY_VALUE_NAME]),
    runSubprocess('reg', ['query', WINDOWS_REGISTRY_KEY_PATH_HKCU, '/v', WINDOWS_REGISTRY_VALUE_NAME]),
    runSubprocess('reg', ['query', LEGACY_WINDOWS_REGISTRY_KEY_PATH_HKCU, '/v', WINDOWS_REGISTRY_VALUE_NAME]),
  ])
  return {
    hklmStdout: hklmMercury ?? hklmLegacy,
    hkcuStdout: hkcuMercury ?? hkcuLegacy,
  }
}

/** A fresh raw read of every policy hive for this platform. */
export async function fireRawRead(): Promise<RawReadResult> {
  if (process.platform === 'darwin') {
    return { plistStdouts: await readMacOSPlists(), hklmStdout: null, hkcuStdout: null }
  }
  if (process.platform === 'win32') {
    const { hklmStdout, hkcuStdout } = await readWindowsRegistry()
    return { plistStdouts: null, hklmStdout, hkcuStdout }
  }
  // No MDM equivalent elsewhere; file-based managed settings serve that role.
  return { plistStdouts: null, hklmStdout: null, hkcuStdout: null }
}

let startupRawRead: Promise<RawReadResult> | null = null

/** Fire once for startup (idempotent). */
export function startMdmRawRead(): void {
  if (startupRawRead === null) {
    startupRawRead = fireRawRead()
  }
}

export function getMdmRawReadPromise(): Promise<RawReadResult> | null {
  return startupRawRead
}

/** PROOF-ONLY seam: stand a scripted raw read in for the startup read, so
 *  the boot barrier's tier load can be proven without a real plist or
 *  registry policy on the box (the underscore name is the contract). */
export function _setMdmRawReadForProofs(result: RawReadResult | Promise<RawReadResult>): void {
  startupRawRead = Promise.resolve(result)
}
