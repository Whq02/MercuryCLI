// ============================================================================
//  src/services/privateChannel/vendoredRuntime.ts — the ONE owner of the
//  vendored Node runtime's shape.
//
//  A release archive carries its own Node beside the bundle, so a fresh
//  machine needs only git. This module spells the shape exactly once — the
//  fixed directory, the binary per platform family, the nodejs.org platform
//  keys the lock pins, the manifest record, and how a running process tells
//  whether it IS that runtime — for every consumer: the vendor fetch
//  (scripts/vendor/fetch-node.ts), the build (build.ts), the install/update
//  layout, the artifact verifier, the install and update verbs and the
//  doctor row. Node builtins only, no side effects: the build imports it
//  under bun and the bundle ships it.
//
//  The launchers cannot import it (they are shell), so they spell the fixed
//  path themselves; scripts/node-runtime/prove-launchers.ts pins every
//  launcher's spelling to RUNTIME_PACK_PATH and the binary names below.
// ============================================================================
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The fixed directory beside the bundle: `<payload>/vendor/node`. */
export const RUNTIME_PACK_PATH = 'vendor/node'

/** The pack platforms the lock pins — nodejs.org's own archive spelling. */
export const NODE_PACK_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win-x64'] as const
export type NodePackPlatform = (typeof NODE_PACK_PLATFORMS)[number]

/** The lock platform for a (process.platform, process.arch) pair, or null
 *  when nodejs.org publishes no archive Mercury vendors for it. */
export function nodePackPlatform(platform: string, arch: string): NodePackPlatform | null {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64'
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  return null
}

/** The runtime binary's path inside the pack: the nodejs.org tarballs carry
 *  `bin/node`, the Windows zip a top-level `node.exe`. */
export function runtimeBinaryFor(packPlatform: string): string {
  return packPlatform === 'win-x64' ? 'node.exe' : 'bin/node'
}

/** The members the pack keeps out of the nodejs.org archive: the binary and
 *  the licence. npm, corepack, headers and man pages are deliberately not
 *  vendored — the runtime is one static binary. */
export function packMembersFor(packPlatform: string): string[] {
  return [runtimeBinaryFor(packPlatform), 'LICENSE']
}

export interface VendoredRuntimeRecord {
  vendored: true
  /** RUNTIME_PACK_PATH — repeated in the record so a reader needs no code. */
  path: string
  /** the binary's path inside `path` (`bin/node` · `node.exe`) */
  binary: string
  name: 'node'
  version: string
  platform: NodePackPlatform
  license: string
  /** the nodejs.org archive digest the lock pins (provenance) */
  archiveSha256: string
  /** the shipped binary's digest, computed from the verified cache at build */
  binarySha256: string
}

export interface AbsentRuntimeRecord {
  vendored: false
  path: string
  remedy: string
}

export type RuntimeRecord = VendoredRuntimeRecord | AbsentRuntimeRecord

const HEX64 = /^[0-9a-f]{64}$/

/** Decode a manifest's `runtime` record — a manifest without one (an older
 *  build) answers null; a malformed vendored record also answers null so no
 *  reader trusts half a claim. */
export function readRuntimeRecord(manifest: unknown): RuntimeRecord | null {
  if (typeof manifest !== 'object' || manifest === null) return null
  const raw = (manifest as { runtime?: unknown }).runtime
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.vendored === false) {
    return {
      vendored: false,
      path: typeof r.path === 'string' ? r.path : RUNTIME_PACK_PATH,
      remedy: typeof r.remedy === 'string' ? r.remedy : '',
    }
  }
  if (r.vendored !== true) return null
  const platform = typeof r.platform === 'string' && (NODE_PACK_PLATFORMS as readonly string[]).includes(r.platform) ? (r.platform as NodePackPlatform) : null
  if (
    platform === null ||
    r.name !== 'node' ||
    typeof r.version !== 'string' ||
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
    name: 'node',
    version: r.version,
    platform,
    license: typeof r.license === 'string' ? r.license : '',
    archiveSha256: r.archiveSha256,
    binarySha256: r.binarySha256,
  }
}

export function vendoredRuntimeBinaryPath(payloadDir: string, record: VendoredRuntimeRecord): string {
  return join(payloadDir, ...record.path.split('/'), ...record.binary.split('/'))
}

export type RuntimeCheck =
  | { state: 'ok'; binaryPath: string }
  | { state: 'absent' | 'mismatch'; binaryPath: string; note: string }

/**
 * Check the vendored runtime a payload declares against its bytes. Presence
 * is always checked; the digest only on request (`digest: true`) — the
 * binary is large, so the cheap arm serves every-run validation and the
 * digest arm serves deep verification.
 */
export function checkVendoredRuntime(payloadDir: string, record: VendoredRuntimeRecord, opts: { digest?: boolean } = {}): RuntimeCheck {
  const binaryPath = vendoredRuntimeBinaryPath(payloadDir, record)
  let isFile = false
  try {
    isFile = statSync(binaryPath).isFile()
  } catch {
    isFile = false
  }
  if (!isFile) {
    return { state: 'absent', binaryPath, note: `the manifest declares a vendored node ${record.version} at ${record.path}/${record.binary} but the file is absent` }
  }
  if (opts.digest) {
    const actual = createHash('sha256').update(readFileSync(binaryPath)).digest('hex')
    if (actual !== record.binarySha256) {
      return {
        state: 'mismatch',
        binaryPath,
        note: `the vendored runtime ${record.path}/${record.binary} does not match the manifest record (expected ${record.binarySha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
      }
    }
  }
  return { state: 'ok', binaryPath }
}

/** The vendored runtime a payload directory declares AND carries, or null
 *  (no manifest, no record, an absent-runtime record, or a missing binary). */
export function payloadVendoredRuntime(payloadDir: string): { record: VendoredRuntimeRecord; binaryPath: string } | null {
  const manifestPath = join(payloadDir, 'manifest.json')
  if (!existsSync(manifestPath)) return null
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
  const record = readRuntimeRecord(manifest)
  if (record === null || !record.vendored) return null
  const check = checkVendoredRuntime(payloadDir, record)
  return check.state === 'ok' ? { record, binaryPath: check.binaryPath } : null
}

/** The payload directory of the RUNNING bundle (argv[1]'s directory when it
 *  is a bundle), or null under a source run. */
export function runningBundlePayloadDir(argv1: string | undefined = process.argv[1]): string | null {
  if (!argv1 || !argv1.endsWith('.mjs')) return null
  return dirname(argv1)
}

function sameFile(a: string, b: string, isWindows: boolean): boolean {
  const canon = (p: string): string => {
    let v = p
    try {
      v = realpathSync.native(p)
    } catch {
      // an unresolvable side compares lexically
    }
    return isWindows ? v.toLowerCase() : v
  }
  return canon(a) === canon(b)
}

export interface RunningRuntime {
  /** which rung produced the process: the vendored pack · MERCURY_NODE · a PATH node */
  source: 'vendored' | 'explicit' | 'system'
  /** the running Node version (process.versions.node) */
  version: string
  /** the vendored runtime the payload carries, when it carries one */
  vendored: { version: string; binaryPath: string; inUse: boolean } | null
}

/** Classify the running process's runtime — pure over the gathered facts. */
export function describeRunningRuntime(facts: {
  payloadDir: string | null
  execPath: string
  execVersion: string
  explicitNode: string | null
  isWindows?: boolean
}): RunningRuntime {
  const isWindows = facts.isWindows ?? process.platform === 'win32'
  const carried = facts.payloadDir === null ? null : payloadVendoredRuntime(facts.payloadDir)
  const vendored =
    carried === null
      ? null
      : { version: carried.record.version, binaryPath: carried.binaryPath, inUse: sameFile(carried.binaryPath, facts.execPath, isWindows) }
  if (vendored?.inUse) return { source: 'vendored', version: facts.execVersion, vendored }
  if (facts.explicitNode && facts.explicitNode.trim() !== '' && sameFile(facts.explicitNode, facts.execPath, isWindows)) {
    return { source: 'explicit', version: facts.execVersion, vendored }
  }
  return { source: 'system', version: facts.execVersion, vendored }
}

/** The one-phrase runtime line every surface speaks — the doctor row,
 *  `update --status`, `install --dry-run`. */
export function runtimeLine(rt: RunningRuntime): string {
  const notInUse = rt.vendored && !rt.vendored.inUse ? `vendored node ${rt.vendored.version} present at ${RUNTIME_PACK_PATH}, not in use` : null
  switch (rt.source) {
    case 'vendored':
      return `vendored node ${rt.version} (${RUNTIME_PACK_PATH})`
    case 'explicit':
      return `explicit node ${rt.version} (MERCURY_NODE${notInUse ? `; ${notInUse}` : ''})`
    case 'system':
      return `system node ${rt.version} (${notInUse ?? 'no vendored runtime'})`
  }
}

/** The runtime line for a PAYLOAD (an install's version directory, the
 *  extracted archive `install --dry-run` describes). */
export function payloadRuntimeLine(payloadDir: string): string {
  const carried = payloadVendoredRuntime(payloadDir)
  if (carried === null) return 'none carried (the launcher runs MERCURY_NODE or a PATH node)'
  return `vendored node ${carried.record.version} (${carried.record.path}/${carried.record.binary}, ${carried.record.platform})`
}
