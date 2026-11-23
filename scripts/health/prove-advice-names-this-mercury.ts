#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DIST, NODE } from '../daemon/dupline-world.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let adviceFixHint = 'change ownCommandWord or thisMercuryCommand in src/platform/update-channel/installPath.ts'
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} · ` : ''}${adviceFixHint}` : ''}`)
  if (!cond) failures++
}

const { ownCommandWord, thisMercuryCommand } = await import('../../src/platform/update-channel/installPath.ts')

const node = '/opt/homebrew/Cellar/node@24/24.20.0/bin/node'
const bundle = '/Users/op/pre27-air/pre27/dist/mercury.mjs'
const installed = { state: 'stable' as const, resolved: '/Users/op/.local/bin/mercury' }
const another = { state: 'other' as const, resolved: '/Users/op/.local/bin/mercury', npmWrapper: false }
const absent = { state: 'absent' as const }

console.log('§1 the command word that names THIS Mercury')
check('a managed install whose stable command is on PATH is addressed by its word', ownCommandWord({ provenanceKind: 'managed', found: installed, node, bundle }) === 'mercury')
check("a source build never borrows the word when the PATH's mercury is another install", ownCommandWord({ provenanceKind: 'development', found: another, node, bundle }) === `${node} ${bundle}`, ownCommandWord({ provenanceKind: 'development', found: another, node, bundle }))
check('a source build with no mercury on PATH is addressed by its own invocation', ownCommandWord({ provenanceKind: 'development', found: absent, node, bundle }) === `${node} ${bundle}`)
check("a managed install shadowed by another launcher on PATH is addressed by its own invocation", ownCommandWord({ provenanceKind: 'managed', found: another, node, bundle }) === `${node} ${bundle}`)
check('a Homebrew or npm install on PATH keeps its word', ownCommandWord({ provenanceKind: 'homebrew', found: another, node, bundle }) === 'mercury' && ownCommandWord({ provenanceKind: 'npm', found: another, node, bundle }) === 'mercury')
check('a path with a space is quoted', ownCommandWord({ provenanceKind: 'development', found: absent, node: 'C:\\Program Files\\nodejs\\node.exe', bundle: 'C:\\pre27 field\\dist\\mercury.mjs' }) === '"C:\\\\Program Files\\\\nodejs\\\\node.exe" "C:\\\\pre27 field\\\\dist\\\\mercury.mjs"', ownCommandWord({ provenanceKind: 'development', found: absent, node: 'C:\\Program Files\\nodejs\\node.exe', bundle: 'C:\\pre27 field\\dist\\mercury.mjs' }))
check('with no bundle to name the word stands', ownCommandWord({ provenanceKind: 'development', found: absent, node, bundle: undefined }) === 'mercury')
const live = thisMercuryCommand()
check('the live resolver answers a non-empty command, the same on every read', live.length > 0 && thisMercuryCommand() === live, live)

console.log("§2 the built product's health advice names THIS install (a source build with no `mercury` on PATH)")
{
  adviceFixHint = 'the daemon row of the health certificate must name this build by its own node and bundle invocation (the word comes from thisMercuryCommand in src/platform/update-channel/installPath.ts); rebuild dist/mercury.mjs with bun run build.ts'
  type Row = { id: string; status: string; evidence?: string; fix?: string }
  const rows = (value: unknown, out: Row[] = []): Row[] => {
    if (Array.isArray(value)) for (const item of value) rows(item, out)
    else if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (typeof record.id === 'string' && typeof record.status === 'string') out.push(record as unknown as Row)
      for (const inner of Object.values(record)) rows(inner, out)
    }
    return out
  }
  const world = mkdtempSync(join(tmpdir(), 'advice-word-'))
  const work = join(world, 'work')
  const userHome = join(world, 'home')
  const configDir = join(world, 'config')
  const versionsDir = join(configDir, 'versions')
  const localAppData = join(userHome, 'AppData', 'Local')
  const appData = join(userHome, 'AppData', 'Roaming')
  const xdgConfigHome = join(userHome, '.config')
  for (const d of [work, userHome, configDir, localAppData, appData]) mkdirSync(d, { recursive: true })
  const worldBase = resolve(world)
  for (const p of [userHome, configDir, versionsDir, localAppData, appData, xdgConfigHome]) {
    const rel = relative(worldBase, resolve(p))
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      console.log(`  [FAIL] SAFETY: layout root escapes scratch: ${p}`)
      process.exit(1)
    }
  }
  check('every layout and home root lies under scratch', true)
  const nodeBin = NODE.includes('/') || NODE.includes('\\') ? NODE : (Bun.which(NODE) ?? NODE)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    LOCALAPPDATA: localAppData,
    APPDATA: appData,
    XDG_CONFIG_HOME: xdgConfigHome,
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_VERSIONS_DIR: versionsDir,
    TMPDIR: world,
    PATH: process.platform === 'win32' ? dirname(nodeBin) : `/usr/bin:/bin${delimiter}${dirname(nodeBin)}`,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
  }
  delete env.MERCURY_HOME
  delete env.HOMEDRIVE
  delete env.HOMEPATH
  const run = spawnSync(nodeBin, [DIST, 'health', '--json'], { cwd: work, env, encoding: 'utf8', timeout: 120_000 })
  check('the built product started', run.error === undefined, String(run.error))
  let parsed: unknown = null
  try {
    parsed = JSON.parse(run.stdout ?? '')
  } catch {
    parsed = null
  }
  const daemonRow = rows(parsed).find(row => row.id === 'daemon')
  const advice = daemonRow?.evidence ?? ''
  check('health answered a certificate with the daemon row', daemonRow !== undefined, (run.stderr ?? '').slice(-300))
  check('with no daemon the row offers the opt-in start', advice.includes('opt-in: run `'), advice)
  check("the start it names is this build's own invocation (node and bundle), not the bare word", advice.includes(`${DIST} daemon\``) && !advice.includes('run `mercury daemon`'), advice)
  rmSync(world, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL LAWS HOLD' : `${failures} FAILURE(S)`} — prove-advice-names-this-mercury`)
process.exit(failures === 0 ? 0 : 1)
