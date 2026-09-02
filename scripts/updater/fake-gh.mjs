#!/usr/bin/env node
// ============================================================================
//  scripts/updater/fake-gh.mjs — the portable hermetic gh for updater proofs
//  (MERCURY-UPDATE-RELIABILITY U2; supersedes the POSIX-only shell shim so
//  the same fixture transport runs on windows-latest).
//
//  Serves fixture releases/assets from GH_SHIM_FIXTURES and logs every
//  invocation to GH_SHIM_LOG. Knobs (same contract as the old shell shim):
//    GH_SHIM_AUTH=fail         → `gh auth status` reports signed-out
//    GH_SHIM_REPO_ACCESS=deny  → repo probe 404s
//    GH_SHIM_SKIP_SUMS=1       → SHA256SUMS.txt never arrives (interrupted DL)
//
//  Consumers reach it two ways:
//    · NEW runtimes: MERCURY_GH_CMD='["node","<abs path to this file>"]'
//    · OLD shipped runtimes (no seam): a PATH-front `gh` wrapper — a #!/bin/sh
//      exec on POSIX; on win32 a csc-compiled gh.exe forwarder (Node execFile
//      cannot spawn .cmd/.bat shims — the CreateProcess .exe-only wall).
// ============================================================================
import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
if (process.env.GH_SHIM_LOG) appendFileSync(process.env.GH_SHIM_LOG, `gh ${args.join(' ')}\n`)
const fixtures = process.env.GH_SHIM_FIXTURES ?? ''

const verb = args[0]
if (verb === 'auth') {
  if ((process.env.GH_SHIM_AUTH ?? 'ok') === 'ok') process.exit(0)
  console.error('You are not logged into any GitHub hosts.')
  process.exit(1)
}
if (verb === 'api') {
  const path = args[1] ?? ''
  if (/^repos\/.+\/releases/.test(path)) {
    process.stdout.write(readFileSync(join(fixtures, 'releases.json'), 'utf8'))
    process.exit(0)
  }
  if (/^repos\//.test(path)) {
    if ((process.env.GH_SHIM_REPO_ACCESS ?? 'ok') !== 'ok') {
      console.error('HTTP 404: Not Found')
      process.exit(1)
    }
    console.log('true')
    process.exit(0)
  }
  console.error('unexpected api call')
  process.exit(1)
}
if (verb === 'release' && args[1] === 'download') {
  const tag = args[2] ?? ''
  let dir = ''
  const patterns = []
  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--dir') dir = args[++i] ?? ''
    else if (args[i] === '--pattern') patterns.push(args[++i] ?? '')
  }
  for (const p of patterns) {
    if (process.env.GH_SHIM_SKIP_SUMS === '1' && p === 'SHA256SUMS.txt') continue
    const src = join(fixtures, 'assets', tag, p)
    if (existsSync(src)) copyFileSync(src, join(dir, p))
  }
  process.exit(0)
}
console.error(`unexpected gh verb: ${verb ?? '(none)'}`)
process.exit(1)
