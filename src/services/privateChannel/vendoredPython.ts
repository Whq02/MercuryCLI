import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { lockPathParts, payloadBinaryPath } from './vendoredRuntime.js'

export const PYTHON_PACK_PATH = 'vendor/python'

export const PYTHON_PACK_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win-x64', 'win-arm64'] as const
export type PythonPackPlatform = (typeof PYTHON_PACK_PLATFORMS)[number]

export function pythonPackPlatform(platform: string, arch: string): PythonPackPlatform | null {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64'
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  if (platform === 'win32' && arch === 'arm64') return 'win-arm64'
  return null
}

export function pythonBinaryFor(packPlatform: string): string {
  return packPlatform.startsWith('win-') ? 'python.exe' : 'bin/python3'
}

export function pythonMinorOf(version: string): string {
  const m = /^(\d+)\.(\d+)\./.exec(version)
  if (!m) throw new Error(`pythonMinorOf: ${version} is not a CPython version`)
  return `${m[1]}.${m[2]}`
}

export function pythonStdlibFor(packPlatform: string, version: string): string {
  return packPlatform.startsWith('win-') ? 'Lib' : `lib/python${pythonMinorOf(version)}`
}

interface PythonPackSelection {
  interpreter: string
  roots: string[]
  excluded: string[]
  licence: string
}

export function pythonPackSelectionFor(packPlatform: string, version: string): PythonPackSelection {
  const minor = pythonMinorOf(version)
  const stdlib = pythonStdlibFor(packPlatform, version)
  const dropped = ['ensurepip', 'idlelib', 'site-packages', 'test', 'tkinter', 'turtledemo', 'turtle.py'].map(name => `${stdlib}/${name}`)
  if (packPlatform.startsWith('win-')) {
    return {
      interpreter: 'python.exe',
      roots: [`python${minor.replace('.', '')}.dll`, 'python3.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'DLLs', stdlib],
      excluded: dropped,
      licence: 'LICENSE.txt',
    }
  }
  return {
    interpreter: `bin/python${minor}`,
    roots: [stdlib],
    excluded: dropped,
    licence: `${stdlib}/LICENSE.txt`,
  }
}

const DROPPED_NAMES = [/^__pycache__$/, /^config-\d/, /^_tkinter\./, /^_test\w*\.(pyd|so)$/, /^_ctypes_test\.(pyd|so)$/, /^(tcl|tk)\d.*\.dll$/]

export function pythonPackKeeps(selection: PythonPackSelection, rel: string): boolean {
  const parts = lockPathParts(rel)
  if (parts.some(part => DROPPED_NAMES.some(rule => rule.test(part)))) return false
  return !selection.excluded.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`))
}

interface VendoredPythonRecord {
  vendored: true
  path: string
  binary: string
  name: 'python'
  version: string
  release: string
  platform: PythonPackPlatform
  license: string
  archiveSha256: string
  binarySha256: string
}

interface AbsentPythonRecord {
  vendored: false
  path: string
  remedy: string
}

type PythonRecord = VendoredPythonRecord | AbsentPythonRecord

const HEX64 = /^[0-9a-f]{64}$/

export function readPythonRecord(manifest: unknown): PythonRecord | null {
  if (typeof manifest !== 'object' || manifest === null) return null
  const raw = (manifest as { pythonRuntime?: unknown }).pythonRuntime
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.vendored === false) {
    return {
      vendored: false,
      path: typeof r.path === 'string' ? r.path : PYTHON_PACK_PATH,
      remedy: typeof r.remedy === 'string' ? r.remedy : '',
    }
  }
  if (r.vendored !== true) return null
  const platform = typeof r.platform === 'string' && (PYTHON_PACK_PLATFORMS as readonly string[]).includes(r.platform) ? (r.platform as PythonPackPlatform) : null
  if (
    platform === null ||
    r.name !== 'python' ||
    typeof r.version !== 'string' ||
    typeof r.release !== 'string' ||
    typeof r.path !== 'string' ||
    typeof r.binary !== 'string' ||
    typeof r.archiveSha256 !== 'string' ||
    !HEX64.test(r.archiveSha256) ||
    typeof r.binarySha256 !== 'string' ||
    !HEX64.test(r.binarySha256)
  ) {
    return null
  }
  return {
    vendored: true,
    path: r.path,
    binary: r.binary,
    name: 'python',
    version: r.version,
    release: r.release,
    platform,
    license: typeof r.license === 'string' ? r.license : '',
    archiveSha256: r.archiveSha256,
    binarySha256: r.binarySha256,
  }
}

function vendoredPythonBinaryPath(payloadDir: string, record: VendoredPythonRecord): string {
  return payloadBinaryPath(payloadDir, record)
}

type PythonCheck =
  | { state: 'ok'; binaryPath: string }
  | { state: 'absent' | 'mismatch'; binaryPath: string; note: string }

export function checkVendoredPython(payloadDir: string, record: VendoredPythonRecord, opts: { digest?: boolean } = {}): PythonCheck {
  const binaryPath = vendoredPythonBinaryPath(payloadDir, record)
  let isFile = false
  try {
    isFile = statSync(binaryPath).isFile()
  } catch {
    isFile = false
  }
  if (!isFile) {
    return { state: 'absent', binaryPath, note: `the manifest declares a vendored python ${record.version} at ${record.path}/${record.binary} but the file is absent` }
  }
  if (opts.digest) {
    const actual = createHash('sha256').update(readFileSync(binaryPath)).digest('hex')
    if (actual !== record.binarySha256) {
      return {
        state: 'mismatch',
        binaryPath,
        note: `the vendored python ${record.path}/${record.binary} does not match the manifest record (expected ${record.binarySha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
      }
    }
  }
  return { state: 'ok', binaryPath }
}

export function payloadVendoredPython(payloadDir: string): { record: VendoredPythonRecord; binaryPath: string } | null {
  const manifestPath = join(payloadDir, 'manifest.json')
  if (!existsSync(manifestPath)) return null
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
  const record = readPythonRecord(manifest)
  if (record === null || !record.vendored) return null
  const check = checkVendoredPython(payloadDir, record)
  return check.state === 'ok' ? { record, binaryPath: check.binaryPath } : null
}
