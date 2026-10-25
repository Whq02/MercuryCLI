#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)

const setup = await import('../../src/services/localSetup/index.ts')

section('§1 the Windows start plan hands cmd.exe one pre-quoted command line')
{
  const plan = await setup.planStart({ found: 'windows', where: 'C:\\Users\\Ana Lee\\AppData\\Local\\Programs\\Ollama\\ollama app.exe' } as never, { env: {}, platform: 'win32', fetchImpl: (async () => { throw new Error('offline') }) as never })
  check('the plan is the app start through cmd', plan.form === 'windows' && plan.argv[0] === 'cmd.exe' && plan.argv.slice(1, 4).join(' ') === '/d /s /c', JSON.stringify(plan.argv))
  check('the command line carries its own quotes round the spaced path', plan.argv[4] === 'start "" "C:\\Users\\Ana Lee\\AppData\\Local\\Programs\\Ollama\\ollama app.exe"', String(plan.argv[4]))
}

section('§2 the default exec runs that line as written (Windows hosts)')
if (process.platform !== 'win32') {
  console.log('  [skip] cmd.exe is the Windows host')
} else {
  const dir = join(proofHome, 'a spaced folder')
  mkdirSync(dir, { recursive: true })
  const tool = join(dir, 'my tool.cmd')
  writeFileSync(tool, '@echo off\r\necho RAN %*\r\n')
  const io = setup.resolveSetupIo({})
  const argv = setup.shellArgv('win32', `start "" /b "${tool}" arg1`)
  const ran = await io.exec(argv[0]!, argv.slice(1), { timeoutMs: 30_000 })
  check('the spaced, quoted batch file ran', ran.rc === 0 && ran.stdout.includes('RAN arg1'), JSON.stringify({ rc: ran.rc, stdout: ran.stdout, stderr: ran.stderr }))
  const plain = await io.exec('cmd.exe', ['/d', '/s', '/c', 'echo plain words'], { timeoutMs: 30_000 })
  check('an unquoted command line is unchanged', plain.rc === 0 && plain.stdout.trim() === 'plain words', JSON.stringify(plain.stdout))
}

removeScratch(proofHome)
console.log(failures === 0 ? '\nPASS prove-setup-windows-start-quoting' : `\nFAIL prove-setup-windows-start-quoting (${failures} failure(s))`)
process.exit(failures === 0 ? 0 : 1)
