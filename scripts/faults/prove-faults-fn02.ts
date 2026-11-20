#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
void POSIX_MODES

function runCase(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn02-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  for (const dir of [home, project]) mkdirSync(dir, { recursive: true })
  try {
    const src = `
      process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
      process.env.MERCURY_CREDENTIAL_STORE = 'file'
      process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
      process.env.NODE_ENV = 'test'
      delete process.env.MERCURY_HOME
      globalThis.MACRO = { VERSION: '1.0.0' }
      process.chdir(${JSON.stringify(project)})
      const fs = await import('node:fs')
      const path = await import('node:path')
      const SRC = ${JSON.stringify(SRC)}
      const HOME = ${JSON.stringify(home)}
      const PROJECT = ${JSON.stringify(project)}
      const out = {}
      ${body}
      process.stdout.write('\\n' + JSON.stringify(out))
      process.exit(0)
    `
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none' },
    })
    if (res.status !== 0) throw new Error(`scenario failed (${res.status}): ${res.stderr.slice(-1500)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\npersistModelChoice — failed compat endpoint lookup refuses instead of saving as default')
{
  const r = runCase(`
    const settingsPath = path.join(HOME, 'settings.json')
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\\n')
    process.env.MERCURY_COMPAT_BASE_URL = 'ftp://bad-url'
    const { persistModelChoice } = await import(path.join(SRC, 'commands/model/persistModelChoice.ts'))
    const result = persistModelChoice('compat/pod-1/llama')
    out.outcome = result.outcome
    out.sentence = result.sentence
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    out.savedModel = after.engine?.model ?? null
    delete process.env.MERCURY_COMPAT_BASE_URL
    const control = persistModelChoice('claude-sonnet-4-6')
    out.controlOutcome = control.outcome
    const afterControl = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    out.controlSaved = afterControl.engine?.model ?? null
  `)
  check('persistModelChoice refuses when compatModelEndpoint throws', r.outcome === 'refused', `got outcome=${String(r.outcome)} sentence=${String(r.sentence)}`)
  check('persistModelChoice does not write engine.model to userSettings on lookup failure', r.savedModel === null, `savedModel=${String(r.savedModel)}`)
  check('persistModelChoice refusal uses refusedSentence wording', typeof r.sentence === 'string' && r.sentence.includes('not saved as your default'), `sentence=${String(r.sentence)}`)
  check('control: normal model still saves to userSettings', r.controlOutcome === 'saved' && r.controlSaved === 'claude-sonnet-4-6', `got ${String(r.controlOutcome)} / ${String(r.controlSaved)}`)
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
