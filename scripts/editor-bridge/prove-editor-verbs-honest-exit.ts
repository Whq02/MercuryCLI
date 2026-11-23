#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const EMPTY_BIN = realpathSync(mkdtempSync(join(tmpdir(), 'editor-empty-bin-')))
process.env.PATH = EMPTY_BIN

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) {
    failures++
    if (hint) console.log(`    what to change: ${hint}`)
  }
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { editorBridgeMain } = await import('../../src/commands/verbs/editorBridge.ts')

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
  check('exits non-zero (nothing was uninstalled — FC-013)', rc !== 0, `rc=${rc}`, 'the uninstall branch of editorBridgeMain in src/commands/verbs/editorBridge.ts must return 1 when no editor CLI is found')
  check('the manual guidance lands on stderr', /manual/i.test(err), JSON.stringify(err).slice(0, 120), 'the uninstall branch of editorBridgeMain in src/commands/verbs/editorBridge.ts must write the manual uninstall guidance with err(), not out()')
}

section('§2 INSTALL, NO CODE CLI, VSIX PRESENT')
{
  const bundleDir = realpathSync(mkdtempSync(join(tmpdir(), 'editor-bundle-')))
  writeFileSync(join(bundleDir, 'mercury-vscode.vsix'), 'fake-vsix')
  const origArgv1 = process.argv[1]
  process.argv[1] = join(bundleDir, 'mercury.mjs')
  try {
    const { rc, err } = await run('install')
    check('exits non-zero (nothing was installed — FC-013)', rc !== 0, `rc=${rc}`, 'the install branch of editorBridgeMain in src/commands/verbs/editorBridge.ts must return 1 when the vsix exists but no editor CLI is found')
    check('the manual guidance lands on stderr', /manual/i.test(err), JSON.stringify(err).slice(0, 120), 'the install branch of editorBridgeMain in src/commands/verbs/editorBridge.ts must write the manual install steps with err(), not out()')
  } finally {
    process.argv[1] = origArgv1
    rmSync(bundleDir, { recursive: true, force: true })
  }
}

section('§3 INSTALL, NO VSIX')
{
  const { rc } = await run('install')
  check('still exits non-zero', rc !== 0, `rc=${rc}`, 'the install branch of editorBridgeMain in src/commands/verbs/editorBridge.ts must return 1 when mercury-vscode.vsix is not found')
}

section('§4 STATUS, NO CODE CLI')
{
  const { rc, out } = await run('status')
  check('a report is not an action: rc=0', rc === 0, `rc=${rc}`, 'the status branch of editorBridgeMain in src/commands/verbs/editorBridge.ts must return 0 when no editor CLI is found')
  check('and it says the CLI is missing', /not found/i.test(out), '', 'the status branch of editorBridgeMain in src/commands/verbs/editorBridge.ts must print a line with not found on stdout when no editor CLI is on PATH')
}

rmSync(EMPTY_BIN, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-editor-verbs-honest-exit: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-editor-verbs-honest-exit: all green')
