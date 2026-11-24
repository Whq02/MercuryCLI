#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.MERCURY_SNAPSHOT_MISSING_CHILD !== '1') {
  const scratch = mkdtempSync(join(tmpdir(), 'shell-snapshot-missing-'))
  const home = join(scratch, 'home')
  const config = join(scratch, 'config')
  mkdirSync(home, { recursive: true })
  mkdirSync(config, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    MERCURY_CONFIG_DIR: config,
    SHELL: '/bin/sh',
    MERCURY_SNAPSHOT_MISSING_CHILD: '1',
  }
  delete env.ZDOTDIR
  delete env.MERCURY_HOME
  try {
    const child = spawnSync(process.execPath, [...process.execArgv, import.meta.path], { stdio: 'inherit', env })
    process.exit(child.status ?? 1)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_ERROR_REPORTING = '1'
const { createAndSaveSnapshot } = await import('../../src/platform/shell/bash/shellSnapshot.ts')
const { getInMemoryErrors } = await import('../../src/platform/logs/errorLog.ts')

const HINT = 'check createAndSaveSnapshot in src/platform/shell/bash/shellSnapshot.ts when capture exits 0 without writing the snapshot file'
let failures = 0
const check = (label: string, good: boolean, detail = ''): void => {
  console.log(`${good ? 'PASS' : 'FAIL'} ${label}${good ? (detail ? ` — ${detail}` : '') : ` — ${[detail, HINT].filter(Boolean).join('; ')}`}`)
  if (!good) failures++
}
const firstLines = (): string[] => getInMemoryErrors().map((e: { error: string }) => e.error.split('\n')[0] ?? '')
const since = (n: number): string[] => firstLines().slice(n)
const HEAD = 'shell snapshot creation failed: '

let before = firstLines().length
const endsWell = await createAndSaveSnapshot({ path: '/usr/bin/true', origin: 'system' })
const wellLines = since(before).filter(l => l.includes(HEAD))
check('a capture that ends well and leaves no file answers undefined', endsWell === undefined, String(endsWell))
check('that road says the creation-failed error line once', wellLines.length === 1, `${wellLines.length} line(s): ${JSON.stringify(wellLines)}`)
check('the line ends with the shell path in brackets, as the failed-capture road writes it', wellLines.length === 1 && wellLines[0]!.endsWith(' (/usr/bin/true)'), JSON.stringify(wellLines))
check('the line carries a reason between the head and the shell path', wellLines.length === 1 && wellLines[0]!.slice(wellLines[0]!.indexOf(HEAD) + HEAD.length, -' (/usr/bin/true)'.length).trim().length > 0, JSON.stringify(wellLines))

before = firstLines().length
const fails = await createAndSaveSnapshot({ path: '/usr/bin/false', origin: 'system' })
const failLines = since(before).filter(l => l.includes(HEAD))
check('a capture that fails answers undefined', fails === undefined, String(fails))
check('the failed-capture road says its error line once, with the shell path, as before', failLines.length === 1 && failLines[0]!.endsWith(' (/usr/bin/false)'), JSON.stringify(failLines))
check('the two roads give different reasons', wellLines.length === 1 && failLines.length === 1 && wellLines[0]!.replace('/usr/bin/true', '') !== failLines[0]!.replace('/usr/bin/false', ''), `${JSON.stringify(wellLines)} against ${JSON.stringify(failLines)}`)

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
