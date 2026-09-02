#!/usr/bin/env bun
// ============================================================================
//  scripts/updater/prove-status-check-agreement.ts — the two read-only
//  update verbs agree on filesystem damage (FC-121). An unreadable version
//  pointer (current.txt as a directory) made update --check exit 1 while
//  update --status exited 0 with a prose line — opposite verdicts on one
//  state. --status still prints its full report; the exit code now carries
//  the verdict, on the failure channel per the exit-helper discipline.
//
//  §1 damaged pointer: --status exits 1, the report still renders whole
//     and names the unreadable pointer; --status --json exits 1 with
//     parseable JSON.
//  §2 healthy install: --status exits 0 on stdout (control).
//  §3 the --check arm's pointer-unreadable case routes cliError
//     (call-shaped agreement pin — driving --check live needs channel
//     access machinery this prover does not fake).
//
//  Run: ~/.bun/bin/bun run scripts/updater/prove-status-check-agreement.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'updstatus-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const ROOT = join(import.meta.dir, '..', '..')

const { update } = await import('../../src/cli/update.js')

// Drive one update() invocation with process.exit stubbed and both
// channels captured (the exit helpers tolerate a stubbed exit by design).
const drive = async (
  options: Record<string, boolean>,
): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  let code: number | null = null
  const outChunks: string[] = []
  const errChunks: string[] = []
  const realExit = process.exit
  const realWrite = process.stdout.write.bind(process.stdout)
  const realConsoleError = console.error
  process.exit = ((c?: number) => {
    if (code === null) code = c ?? 0
  }) as never
  process.stdout.write = ((c: unknown) => {
    outChunks.push(String(c))
    return true
  }) as never
  console.error = ((...a: unknown[]) => {
    errChunks.push(a.map(String).join(' '))
  }) as never
  try {
    await update(options)
  } catch {
    // a stubbed exit lets code continue into states the real flow never
    // reaches; anything thrown past the first exit request is noise
  } finally {
    process.exit = realExit
    process.stdout.write = realWrite
    console.error = realConsoleError
  }
  return { code, stdout: outChunks.join(''), stderr: errChunks.join('\n') }
}

section('§1 DAMAGED POINTER — STATUS SPEAKS THE VERDICT')
{
  // current.txt as a DIRECTORY is the card's own damage.
  mkdirSync(join(HOME, 'versions', 'current.txt'), { recursive: true })
  const r = await drive({ status: true })
  check('--status exits 1 on the unreadable pointer', r.code === 1, `code=${r.code}`)
  check(
    'the report still renders whole and names the unreadable pointer',
    r.stderr.includes('running version:') && r.stderr.includes('unreadable'),
    r.stderr.split('\n').find(l => l.includes('installed')) ?? '(no installed line)',
  )
  const j = await drive({ status: true, json: true })
  check('--status --json exits 1 too', j.code === 1, `code=${j.code}`)
  let parsed: unknown = null
  try {
    parsed = JSON.parse(j.stderr)
  } catch {
    parsed = null
  }
  check(
    'the JSON is parseable and carries the pointer state',
    parsed !== null && (parsed as { installedPointer?: string }).installedPointer === 'unreadable',
    j.stderr.slice(0, 120),
  )
}

section('§2 HEALTHY INSTALL — STATUS EXITS 0 (control)')
{
  const HOME2 = realpathSync(mkdtempSync(join(tmpdir(), 'updstatus-ok-')))
  process.env.MERCURY_CONFIG_DIR = HOME2
  mkdirSync(join(HOME2, 'versions'), { recursive: true })
  writeFileSync(join(HOME2, 'versions', 'current.txt'), '1.0.0\n')
  const r = await drive({ status: true })
  check('--status exits 0', r.code === 0, `code=${r.code}`)
  check('the report is on stdout', r.stdout.includes('running version:'))
}

section('§3 THE CHECK ARM AGREES (call-shaped)')
{
  const src = readFileSync(join(ROOT, 'src', 'cli', 'update.ts'), 'utf-8')
  check(
    "--check's pointer-unreadable case routes cliError",
    /case 'pointer-unreadable':\s*\n\s*return cliError\(/.test(src),
  )
  check(
    "--status's verdict forks on the same damage",
    src.includes("status.installedPointer === 'unreadable'") &&
      src.includes('pointerDamaged ? cliError(lines') &&
      src.includes('pointerDamaged ? failJson('),
  )
}

console.log(failures === 0 ? '\nprove-status-check-agreement: all green' : `\nprove-status-check-agreement: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
