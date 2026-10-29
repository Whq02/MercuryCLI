#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'tstore-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

if (process.argv.includes('--live')) {
  const HOME4 = process.argv[process.argv.indexOf('--live') + 1] as string
  process.env.MERCURY_CONFIG_DIR = HOME4
  const report = await import('../../src/utils/healthReport.js')
  const storeRow = async (): Promise<{ status: string; evidence: string } | null> => {
    const cert = await report.runHealthReport({ depth: 'fast' })
    const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'transcript-store')
    return row ? { status: String(row.status), evidence: String(row.evidence) } : null
  }
  const { getTranscriptPath } = await import('../../src/utils/sessionStorage/paths.js')
  const live = getTranscriptPath()
  check('the probe follows the config home of the run', live.startsWith(HOME4) && live.endsWith('.jsonl'), live)
  mkdirSync(join(HOME4, 'projects'), { recursive: true })
  const before = await storeRow()
  check('no session file yet: the folder is probed and the words say so', before?.status === 'ok' && before.evidence.includes('no transcript file yet') && before.evidence.includes('the folder'), `${before?.status}: ${before?.evidence}`)
  mkdirSync(dirname(live), { recursive: true })
  writeFileSync(live, '{"type":"fixture"}\n')
  const past = new Date(Date.now() - 60_000)
  utimesSync(live, past, past)
  const beforeMtime = statSync(live).mtimeMs
  const row = await storeRow()
  check('a readable, writable session file reads ok naming the file', row?.status === 'ok' && row.evidence.includes(live) && row.evidence.includes('readable, writable'), `${row?.status}: ${row?.evidence}`)
  check('the probe writes nothing to the transcript and leaves its mtime unchanged', statSync(live).size === 19 && statSync(live).mtimeMs === beforeMtime && readFileSync(live, 'utf8') === '{"type":"fixture"}\n', `size=${statSync(live).size} mtime=${statSync(live).mtimeMs} vs ${beforeMtime}`)
  if (process.getuid?.() === 0) {
    console.log('  [SKIP] a denied session file (root ignores file modes)')
  } else {
    chmodSync(live, 0o444)
    const denied = await storeRow()
    chmodSync(live, 0o644)
    check('a session file that refuses writes FAILS naming the file', denied?.status === 'fail' && denied.evidence.includes(live) && denied.evidence.includes('not writable') && denied.evidence.includes('recorded'), `${denied?.status}: ${denied?.evidence}`)
    const principal = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${userInfo().username}` : userInfo().username
    if (process.platform === 'win32') execFileSync('icacls', [live, '/deny', `${principal}:(RD)`], { stdio: 'pipe' })
    else chmodSync(live, 0o200)
    const unreadable = await storeRow()
    if (process.platform === 'win32') execFileSync('icacls', [live, '/remove:d', principal], { stdio: 'pipe' })
    else chmodSync(live, 0o644)
    check('…and one that refuses reads says so', unreadable?.status === 'fail' && unreadable.evidence.includes('not readable'), `${unreadable?.status}: ${unreadable?.evidence}`)
  }
  rmSync(live)
  mkdirSync(live)
  const wrongKind = await storeRow()
  check('a directory at the session file path FAILS naming the kind', wrongKind?.status === 'fail' && wrongKind.evidence.includes('not a regular file'), `${wrongKind?.status}: ${wrongKind?.evidence}`)
  rmSync(HOME4, { recursive: true, force: true })
  process.exit(failures === 0 ? 0 : 1)
}

const report = await import('../../src/utils/healthReport.js')
const storeRow = async (): Promise<{ status: string; evidence: string } | null> => {
  const cert = await report.runHealthReport({ depth: 'fast' })
  const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'transcript-store')
  return row ? { status: String(row.status), evidence: String(row.evidence) } : null
}

console.log('§1 the damage the card names')
{
  writeFileSync(join(HOME, 'projects'), 'not a directory\n')
  const row = await storeRow()
  check('the row exists (transcript-store)', row !== null)
  check(
    'a regular file at projects/ FAILS naming the unusable store',
    row?.status === 'fail' && row.evidence.includes('not a directory') && row.evidence.includes('transcripts'),
    `${row?.status}: ${row?.evidence}`,
  )
}

console.log('\n§2 absence is normal, and said')
{
  const HOME2 = realpathSync(mkdtempSync(join(tmpdir(), 'tstore-fresh-')))
  process.env.MERCURY_CONFIG_DIR = HOME2
  const row = await storeRow()
  check(
    'a fresh home reads ok with the first-session sentence',
    row?.status === 'ok' && row.evidence.includes('first session creates it'),
    `${row?.status}: ${row?.evidence}`,
  )
}

console.log('\n§3 a healthy store reads ok, counted')
{
  const HOME3 = realpathSync(mkdtempSync(join(tmpdir(), 'tstore-ok-')))
  process.env.MERCURY_CONFIG_DIR = HOME3
  mkdirSync(join(HOME3, 'projects', 'p1'), { recursive: true })
  mkdirSync(join(HOME3, 'projects', 'p2'), { recursive: true })
  const row = await storeRow()
  check(
    'a healthy directory reads ok, counted and writable',
    row?.status === 'ok' && row.evidence.includes('2 project dir(s)') && row.evidence.includes('writable'),
    `${row?.status}: ${row?.evidence}`,
  )
}

console.log('\n§4 the live session has a transcript file: the row probes THAT file (a child with its own home)')
{
  const HOME4 = realpathSync(mkdtempSync(join(tmpdir(), 'tstore-live-')))
  const child = Bun.spawnSync([process.execPath, import.meta.path, '--live', HOME4], { env: { ...process.env, MERCURY_CONFIG_DIR: HOME4 }, stdout: 'inherit', stderr: 'inherit' })
  if (child.exitCode !== 0) failures++
}

console.log(failures === 0 ? '\nprove-transcript-store-row: all green' : `\nprove-transcript-store-row: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
