// ============================================================================
//  scripts/release/payloadContract.mjs — the ONE member-role authority for
//  Mercury release payloads (MERCURY-UPDATE-RELIABILITY U2).
//
//  The packager's member set and the updater provers' fixture set are never
//  two hand-maintained lists: this module is the single source both consume.
//  scripts/release/package.mjs derives its allowlist + the manifest's
//  releaseLayout section from it, and the updater provers build their
//  fixtures through it — a fixture that drifts from the shipped archive
//  cannot exist by construction.
//
//  The compatibility floor (the oldest shipped reader an update archive must
//  serve) is the machine-readable scripts/release/compat-floor.json beside
//  this file; changing the floor later is one explicit edit there.
//
//  Runtime twin: src/services/privateChannel/installLayout.ts implements the
//  IDENTICAL whole-payload digest law (payloadDigestOf) for install identity —
//  scripts cannot be imported from the bundled runtime, so the law is
//  duplicated by spec and cross-checked by prover
//  (scripts/updater/prove-install-layout.ts pins both implementations to one
//  digest on one fixture tree).
// ============================================================================
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DOC_SET = ['README-FIRST.md', 'INSTALLING.md', 'UPDATING.md', 'RELEASE-NOTES.md', 'NOTICES.md']

/** Read the machine-readable compatibility floor (the one owner). */
export function readCompatFloor() {
  const here = dirname(fileURLToPath(import.meta.url))
  return JSON.parse(readFileSync(join(here, 'compat-floor.json'), 'utf8'))
}

/**
 * The complete expected top-level member list for one platform target under
 * one compatibility floor, sorted byte-order. The packager's allowlist and
 * the provers' fixture builders both derive from THIS list.
 */
export function topAllowlist(target, floor) {
  const isWin = target === 'windows-x64'
  const members = [
    'mercury.mjs',
    'manifest.json',
    'vendor',
    'splash.mjs',
    'splash-core.mjs',
    'verify-artifact.mjs',
    'mercury-vscode.vsix',
    ...DOC_SET,
    ...(isWin ? ['mercury.cmd', 'mercury.ps1', 'install.ps1'] : ['mercury', 'install.sh']),
  ]
  return members.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** Declared role per top-level member (the releaseLayout vocabulary). */
export function memberRole(name) {
  if (name === 'mercury.mjs') return 'primary'
  if (name === 'manifest.json') return 'manifest'
  if (name === 'mercury' || name === 'mercury.cmd') return 'launcher'
  if (name === 'mercury.ps1') return 'launcher-ps'
  if (name === 'install.sh' || name === 'install.ps1') return 'installer'
  if (name === 'splash.mjs') return 'splash'
  if (name === 'splash-core.mjs') return 'splash-core'
  if (name === 'verify-artifact.mjs') return 'verifier'
  if (name === 'mercury-vscode.vsix') return 'vsix'
  if (name === 'vendor') return 'vendor-tree'
  if (DOC_SET.includes(name)) return 'doc'
  return 'unknown'
}

/** The launcher member the target's stable shim invokes. */
export const launcherFor = target => (target === 'windows-x64' ? 'mercury.cmd' : 'mercury')

const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Byte-order sorted recursive FILE list ('/'-joined rel paths on every OS). */
export function walkPayloadFiles(dir, base = '') {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const rel = base ? `${base}/${name}` : name
    if (statSync(full).isDirectory()) out.push(...walkPayloadFiles(full, rel))
    else out.push({ path: rel, bytes: statSync(full).size })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * THE deterministic whole-payload digest law (one spec, two implementations —
 * see the runtime twin note above): over every file EXCEPT the top-level
 * manifest.json (the manifest carries the digest, so it cannot cover itself),
 * in byte-order sorted '/'-joined rel-path order, hash the concatenation of
 * `<relpath>\n<sha256-of-bytes-hex>\n`. Different bytes anywhere in the
 * declared payload ⇒ a different identity; path separators and locales cannot
 * change it.
 */
export function payloadDigestOf(dir) {
  const h = createHash('sha256')
  for (const f of walkPayloadFiles(dir)) {
    if (f.path === 'manifest.json') continue
    h.update(`${f.path}\n${sha256File(join(dir, f.path))}\n`)
  }
  return h.digest('hex')
}

/**
 * The packager-owned releaseLayout manifest section (schema 1) for a staged
 * payload dir — every top-level member with its declared role (files carry
 * bytes+sha256; the vendor tree carries its subtree digest), the primary, the
 * launcher, and the whole-payload digest. The reader's arm-1 decoder
 * (channelCore.describePayload) consumes primary/compatibility/launcher; the
 * rest is the auditable release record.
 */
export function releaseLayoutSection(stagedDir, target, floor) {
  const members = []
  const compatibility = []
  for (const name of readdirSync(stagedDir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const full = join(stagedDir, name)
    const role = memberRole(name)
    // W7-D (L20 — no circular artifact claim): the manifest hosts this
    // very section, so a bytes/sha256 member row for it describes PRE-FINAL
    // bytes the shipped file can never have (package.mjs writes the layout
    // back into manifest.json after enumeration — the F4 field finding). The
    // manifest is identified explicitly WITHOUT a self-digest; the payload
    // stays bound by payloadDigest (manifest-exclusive by the twin law) and
    // the archive/release digest above it. No shipped reader consumed the
    // self row (describePayload reads primary/compatibility/launcher only),
    // so schema 1 stands.
    if (name === 'manifest.json') continue
    if (statSync(full).isDirectory()) {
      members.push({ path: name, role, treeDigest: payloadDigestOf(full) })
    } else {
      const entry = { path: name, role, bytes: statSync(full).size, sha256: sha256File(full) }
      members.push(entry)
    }
  }
  const primary = members.find(m => m.role === 'primary')
  if (!primary) throw new Error('releaseLayoutSection: staged payload has no primary bundle')
  return {
    schema: 1,
    floorVersion: floor.floorVersion,
    primary: { path: primary.path, bytes: primary.bytes, sha256: primary.sha256 },
    compatibility,
    launcher: launcherFor(target),
    payloadDigest: payloadDigestOf(stagedDir),
    /** The self-describing record, digest-free by law (L20). */
    manifestMember: { path: 'manifest.json', role: 'manifest' },
    members,
  }
}
