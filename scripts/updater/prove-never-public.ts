#!/usr/bin/env bun
// ============================================================================
//  scripts/updater/prove-never-public.ts — the never-public / never-leaking
//  ratchet (PRIVATE BETA RELEASE §9): the private channel's own sources can
//  never grow an npm/public/anonymous delivery path or a credential
//  read/echo, and the release workflow publishes ONLY to this repository's
//  Releases. (The behavioral halves — output never carrying token material,
//  every gh call hitting the configured private slug — live in
//  prove-update-journey.ts; this is the standing structural guard.)
// ============================================================================
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

const channelDir = join(ROOT, 'src', 'services', 'privateChannel')
const channelFiles = readdirSync(channelDir).filter(f => f.endsWith('.ts'))
check('the channel owner exists with its four modules', channelFiles.length >= 4, channelFiles.join(', '))
const channelSrc = channelFiles.map(f => readFileSync(join(channelDir, f), 'utf8')).join('\n')
const cliSrc =
  readFileSync(join(ROOT, 'src', 'cli', 'update.ts'), 'utf8') + readFileSync(join(ROOT, 'src', 'cli', 'installVerb.ts'), 'utf8')
const all = channelSrc + cliSrc

// ── never public / never anonymous ──────────────────────────────────────────
for (const [label, needle] of [
  ['npm registry', 'npmjs.com'],
  ['npm install path', 'npm install'],
  ['GCS bucket delivery', 'storage.googleapis'],
  ['anonymous release-asset URL', 'releases/download/'],
  ['raw fetch of release bytes', 'fetch('],
  ['curl transport', "'curl'"],
] as const) {
  check(`channel sources carry no ${label}`, !all.includes(needle))
}
// The transport spawns ONE argv: default ['gh'], overridable ONLY through the
// registered hermetic proof seam (MERCURY_GH_CMD — the Windows-capable fake-gh
// lane); no other literal binary may be spawned by the channel sources.
check(
  'the only transport binary is gh (MERCURY_GH_CMD the sole registered override)',
  /return \['gh'\]/.test(channelSrc) &&
    /flagEnv\('MERCURY_GH_CMD'\)/.test(channelSrc) &&
    /execFile\(argv\[0\]!/.test(channelSrc) &&
    !/execFile\('(?!chmod)/.test(channelSrc),
)

// ── never reading or echoing credentials ────────────────────────────────────
for (const [label, needle] of [
  ['gh token subcommand', 'auth token'],
  ['GH_TOKEN env read', 'GH_TOKEN'],
  ['GITHUB_TOKEN env read', 'GITHUB_TOKEN'],
  ['OAuth secret vocabulary', 'client_secret'],
] as const) {
  check(`channel sources never touch ${label}`, !all.includes(needle))
}

// ── the workflow publishes only here, as a prerelease ───────────────────────
const wf = readFileSync(join(ROOT, '.github', 'workflows', 'private-release.yml'), 'utf8')
check('workflow has no npm publish', !wf.includes('npm publish'))
check('workflow has no public-bucket upload', !wf.includes('storage.googleapis') && !wf.includes('aws s3'))
check('workflow marks every labelled tag prerelease', wf.includes("PRERELEASE='--prerelease'"))
check('workflow uses the repo-scoped github.token only', wf.includes('GH_TOKEN: ${{ github.token }}') && !wf.includes('PERSONAL_ACCESS_TOKEN'))
check('workflow release step targets gh release create (this repo)', wf.includes('gh release create'))

console.log('')
if (failures === 0) {
  console.log('PASS prove-never-public')
  process.exit(0)
}
console.log(`FAIL prove-never-public (${failures})`)
process.exit(1)
