#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')

function runScenario(body: string, extraEnv: Record<string, string> = {}): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wider-w10-')))
  const userHome = join(scratch, 'userhome')
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(userHome, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.HOME = ${JSON.stringify(userHome)}
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.12' }
    process.chdir(${JSON.stringify(project)})
    const USER_HOME = ${JSON.stringify(userHome)}
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, HOME: userHome, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file', ...extraEnv },
      timeout: 30_000,
    })
    if (res.status !== 0) throw new Error(`scenario exited ${res.status}: ${res.stderr.slice(-1500)}`)
    const line = res.stdout.trim().split('\n').pop() ?? '{}'
    return JSON.parse(line) as Record<string, unknown>
  } finally {
    try {
      chmodSync(join(home, 'versions'), 0o700)
    } catch {}
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\n§1 w10-1 — channelStatus and mercury update --status report unreadable versions dir and launcher')
{
  const r = runScenario(`
    const { chmodSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { listInstalledVersions, resolveLayoutRoots, shimStatus } = await import(SRC + '/services/privateChannel/installLayout.ts')
    const { channelStatus } = await import(SRC + '/services/privateChannel/updateService.ts')
    const { update } = await import(SRC + '/cli/update.ts')
    const roots = resolveLayoutRoots()
    mkdirSync(roots.versionsDir, { recursive: true })
    mkdirSync(roots.shimPath, { recursive: true })
    chmodSync(roots.versionsDir, 0o000)
    try {
      out.plainVersions = listInstalledVersions(roots)
      out.plainShim = shimStatus(roots)
      const st = await channelStatus(roots)
      out.versionsReadError = st.versionsReadError ?? null
      out.shim = st.shim
      out.shimReadError = st.shimReadError ?? null
      const chunks = []
      const origOut = process.stdout.write.bind(process.stdout)
      const origErr = console.error
      const origExit = process.exit
      process.stdout.write = ((c) => { chunks.push(String(c)); return true })
      console.error = ((...a) => { chunks.push(a.map(String).join(' ')) })
      process.exit = (() => { throw new Error('__EXIT__') })
      try {
        await update({ status: true })
      } catch {} finally {
        process.stdout.write = origOut
        console.error = origErr
        process.exit = origExit
      }
      out.printed = chunks.join('\\n')
      out.shimPath = roots.shimPath
    } finally {
      chmodSync(roots.versionsDir, 0o700)
    }
  `)
  const printed = String(r.printed ?? '')
  check('w10-1: listInstalledVersions keeps []', Array.isArray(r.plainVersions) && r.plainVersions.length === 0, JSON.stringify(r.plainVersions))
  check('w10-1: shimStatus keeps absent', r.plainShim === 'absent', String(r.plainShim))
  check('w10-1: channelStatus reports versionsReadError', typeof r.versionsReadError === 'string' && r.versionsReadError.length > 0, String(r.versionsReadError))
  check('w10-1: channelStatus reports shimReadError', r.shim === 'unreadable' && typeof r.shimReadError === 'string' && r.shimReadError.length > 0, JSON.stringify({ shim: r.shim, err: r.shimReadError }))
  check('w10-1: update --status prints unreadable versions sentence', printed.includes('installed versions could not be read ('), printed)
  check('w10-1: update --status prints unreadable launcher sentence', printed.includes(`the launcher at ${String(r.shimPath)} could not be read (`), printed)
}

console.log('\n§2 w10-2 — unparseable MERCURY_GH_CMD runs plain gh and prints notice once in cli/update')
{
  const r = runScenario(`
    const { chmodSync, existsSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const binDir = join(PROJECT, 'fakebin')
    const marker = join(PROJECT, 'plain-gh-ran')
    mkdirSync(binDir, { recursive: true })
    const fakeGh = join(binDir, 'gh')
    writeFileSync(fakeGh, '#!/bin/sh\\necho ran >> ' + JSON.stringify(marker) + '\\necho true\\n')
    chmodSync(fakeGh, 0o755)
    process.env.PATH = binDir + ':' + (process.env.PATH ?? '')
    process.env.MERCURY_UPDATE_CHANNEL_REPO = 'example/mercury'
    process.env.MERCURY_GH_CMD = '{bad json'
    const { update } = await import(SRC + '/cli/update.ts')
    const errs = []
    const origOut = process.stdout.write.bind(process.stdout)
    const origErr = console.error
    const origExit = process.exit
    process.stdout.write = (() => true)
    console.error = ((...a) => { errs.push(a.map(String).join(' ')) })
    process.exit = (() => { throw new Error('__EXIT__') })
    try {
      await update({ status: true })
    } catch {} finally {
      process.stdout.write = origOut
      console.error = origErr
      process.exit = origExit
    }
    out.plainRan = existsSync(marker)
    out.errs = errs
  `)
  const errs = Array.isArray(r.errs) ? (r.errs as string[]) : []
  const matches = errs.filter(
    l => l.includes('MERCURY_GH_CMD is not a JSON list of strings (') && l.includes('), so it is not used and plain gh ran; fix or unset it.'),
  )
  check('w10-2: plain gh still ran', r.plainRan === true, JSON.stringify(r))
  check('w10-2: cli/update prints skipped MERCURY_GH_CMD sentence once', matches.length === 1, JSON.stringify(errs))
}

console.log(failures === 0 ? '\nprove-wider-w10: all green' : `\nprove-wider-w10: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
