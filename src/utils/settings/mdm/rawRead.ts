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


export type RawReadResult = {
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
  for (const { candidate, stdout } of outputs) {
    if (stdout !== null && stdout.trim() !== '') {
      return [{ stdout, label: candidate.label }]
    }
  }
  return []
}

async function readWindowsRegistry(): Promise<{ hklmStdout: string | null; hkcuStdout: string | null }> {
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

export async function fireRawRead(): Promise<RawReadResult> {
  if (process.platform === 'darwin') {
    return { plistStdouts: await readMacOSPlists(), hklmStdout: null, hkcuStdout: null }
  }
  if (process.platform === 'win32') {
    const { hklmStdout, hkcuStdout } = await readWindowsRegistry()
    return { plistStdouts: null, hklmStdout, hkcuStdout }
  }
  return { plistStdouts: null, hklmStdout: null, hkcuStdout: null }
}

let startupRawRead: Promise<RawReadResult> | null = null

export function startMdmRawRead(): void {
  if (startupRawRead === null) {
    startupRawRead = fireRawRead()
  }
}

export function getMdmRawReadPromise(): Promise<RawReadResult> | null {
  return startupRawRead
}

export function _setMdmRawReadForProofs(result: RawReadResult | Promise<RawReadResult>): void {
  startupRawRead = Promise.resolve(result)
}
