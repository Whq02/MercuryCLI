#!/usr/bin/env bun
// prove-editor-verbs-honest-exit — editor install/uninstall exit honestly
// (field card FC-013). Both verbs exited 0 having done NOTHING when the code
// CLI was absent, printing the manual-fallback text on stdout — so
// `mercury editor install && <next step>` proceeded as though the install
// had happened. An action verb that performed no action now exits 1 with the
// guidance on stderr; `status` (a report, not an action) keeps exit 0.
//
//   §1 uninstall with no code CLI: rc=1, guidance on stderr.
//   §2 install with no code CLI (vsix present): rc=1, guidance on stderr.
//   §3 install with no vsix: rc=1 (unchanged).
//   §4 status with no code CLI: rc=0 (a report is not an action).
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
// An empty PATH dir ensures findCodeCli finds nothing, deterministically.
const EMPTY_BIN = realpathSync(mkdtempSync(join(tmpdir(), 'editor-empty-bin-')))
process.env.PATH = EMPTY_BIN

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { editorBridgeMain } = await import('../../src/cli/editorBridge.ts')

// Capture both streams around one call.
const run = async (action: string): Promise<{ rc: number; out: string; err: string }> => {
  let out = ''
  let err = ''
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += String(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    const rc = await editorBridgeMain(action)
    return { rc, out, err }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

section('§1 UNINSTALL, NO CODE CLI')
{
  const { rc, err } = await run('uninstall')
  check('exits non-zero (nothing was uninstalled — FC-013)', rc !== 0, `rc=${rc}`)
  check('the manual guidance lands on stderr', /manual/i.test(err), JSON.stringify(err).slice(0, 120))
}

section('§2 INSTALL, NO CODE CLI, VSIX PRESENT')
{
  // A vsix beside a fake bundle path so only the code CLI is missing.
  const bundleDir = realpathSync(mkdtempSync(join(tmpdir(), 'editor-bundle-')))
  writeFileSync(join(bundleDir, 'mercury-vscode.vsix'), 'fake-vsix')
  const origArgv1 = process.argv[1]
  process.argv[1] = join(bundleDir, 'mercury.mjs')
  try {
    const { rc, err } = await run('install')
    check('exits non-zero (nothing was installed — FC-013)', rc !== 0, `rc=${rc}`)
    check('the manual guidance lands on stderr', /manual/i.test(err), JSON.stringify(err).slice(0, 120))
  } finally {
    process.argv[1] = origArgv1
    rmSync(bundleDir, { recursive: true, force: true })
  }
}

section('§3 INSTALL, NO VSIX')
{
  const { rc } = await run('install')
  check('still exits non-zero', rc !== 0, `rc=${rc}`)
}

section('§4 STATUS, NO CODE CLI')
{
  const { rc, out } = await run('status')
  check('a report is not an action: rc=0', rc === 0, `rc=${rc}`)
  check('and it says the CLI is missing', /not found/i.test(out))
}

rmSync(EMPTY_BIN, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-editor-verbs-honest-exit: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-editor-verbs-honest-exit: all green')
