#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, symlinkSync, mkdirSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const buildGateHint = 'fix the ripgrep gate in build.ts (the no-rg failure, the MERCURY_BUILD_ALLOW_NO_RG degraded path and the manifest search entry)'
const probeHint = 'fix searchToolsAvailability in src/platform/shell/ripgrep.ts'

const root = resolve(import.meta.dir, '..', '..')
const bun = process.execPath

const runBuild = (outdir: string, env: Record<string, string>) =>
  spawnSync('nice', ['-n', '19', bun, 'run', 'build.ts'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MERCURY_BUILD_OUTDIR: outdir, ...env },
    timeout: 240_000,
  })

console.log('============================================================')
console.log(' Build search gate — no-rg fails · opt-in degrades honestly')
console.log('============================================================')

section('(A) no rg + no opt-in → the build FAILS with a remedy, no manifest')
{
  const out = mkdtempSync(join(tmpdir(), 'build-norg-'))
  const r = runBuild(out, { MERCURY_BUILD_NO_VENDOR_RG: '1' })
  const all = (r.stdout ?? '') + (r.stderr ?? '')
  check('exit code is non-zero', r.status !== 0, `status=${r.status} — ${buildGateHint}`)
  check('names the failure', all.includes('BUILD FAILED: no ripgrep'), `${all.slice(-300)} — ${buildGateHint}`)
  check('never prints BUILD OK', !all.includes('BUILD OK'), buildGateHint)
  check('offers the degraded opt-in as the escape hatch', all.includes('MERCURY_BUILD_ALLOW_NO_RG=1'), buildGateHint)
  check('no manifest.json lands (absence = do-not-ship)', !existsSync(join(out, 'manifest.json')), buildGateHint)
}

section('(B) no rg + MERCURY_BUILD_ALLOW_NO_RG=1 → loud degraded build, honest manifest')
{
  const out = mkdtempSync(join(tmpdir(), 'build-norg-allow-'))
  const r = runBuild(out, { MERCURY_BUILD_NO_VENDOR_RG: '1', MERCURY_BUILD_ALLOW_NO_RG: '1' })
  const all = (r.stdout ?? '') + (r.stderr ?? '')
  check('exit code is zero', r.status === 0, `${all.slice(-300)} — ${buildGateHint}`)
  check('prints the DEGRADED BUILD warning', all.includes('DEGRADED BUILD'), buildGateHint)
  check('bundle lands', existsSync(join(out, 'mercury.mjs')), buildGateHint)
  const mp = join(out, 'manifest.json')
  check('manifest.json lands', existsSync(mp), buildGateHint)
  if (existsSync(mp)) {
    const m = JSON.parse(readFileSync(mp, 'utf8')) as {
      search: { vendored: boolean; remedy?: string }
      degraded: string[]
    }
    check('manifest: search.vendored=false', m.search.vendored === false, buildGateHint)
    check('manifest: degraded includes search', m.degraded.includes('search'), buildGateHint)
    check('manifest: carries a concrete remedy', typeof m.search.remedy === 'string' && m.search.remedy.includes('ripgrep'), buildGateHint)
  }
}

section('(C) runtime catalog agreement — source self-sufficiency · the unavailable arm · system preference')
{
  const savedPath = process.env.PATH ?? ''
  process.env.MERCURY_BUILTIN_RIPGREP = '1'
  process.env.PATH = ''

  const { searchToolsAvailability } = await import('../../src/platform/shell/ripgrep.js')
  const { getAllBaseTools } = await import('../../src/tools/kit/toolList.js')

  const down = searchToolsAvailability()
  check(
    'probe: the source tree is self-sufficient (builtin via the vendored dependency)',
    down.available === true && down.mode === 'builtin' && down.path.includes('@vscode'),
    `${JSON.stringify(down)} — ${probeHint}`,
  )
  const names = getAllBaseTools().map(t => t.name)
  check('catalog offers Glob/Grep on the self-sufficient tree', names.includes('Glob') && names.includes('Grep'), `${probeHint}; the catalog is getAllBaseTools in src/tools/kit/toolList.ts`)
  check('catalog still offers non-search tools', names.includes('Read') && names.includes('Bash'), 'the catalog is getAllBaseTools in src/tools/kit/toolList.ts')


  const distRg = join(root, 'dist', 'vendor', 'ripgrep', `${process.arch}-${process.platform}`, process.platform === 'win32' ? 'rg.exe' : 'rg')
  if (!existsSync(distRg)) {
    check('dist-vendored rg present for the system-preference leg (build first)', false, distRg)
  } else {
    const bin = join(mkdtempSync(join(tmpdir(), 'heal-bin-')), 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(distRg, join(bin, 'rg'))
    const probeCode = [
      "(globalThis)['MACRO'] = { VERSION: '0.0.0' };",
      `const m = await import(${JSON.stringify(join(root, 'src/platform/shell/ripgrep.ts'))});`,
      'console.log(JSON.stringify(m.searchToolsAvailability()));',
    ].join('\n')
    const res = spawnSync(process.execPath, ['-e', probeCode], {
      encoding: 'utf8',
      env: { ...process.env, PATH: bin, MERCURY_BUILTIN_RIPGREP: '0' },
    })
    let up: { available?: boolean; mode?: string } = {}
    try {
      up = JSON.parse(res.stdout.trim().split('\n').at(-1) ?? '{}') as typeof up
    } catch {
    }
    check(
      'probe: =0 prefers the system rg (fresh process, PATH-provided binary)',
      up.available === true && up.mode === 'system',
      `${JSON.stringify(up)} stderr=${(res.stderr ?? '').slice(0, 120)} — ${probeHint} (MERCURY_BUILTIN_RIPGREP=0 must prefer the system rg)`,
    )
  }
  process.env.PATH = savedPath
  delete process.env.MERCURY_BUILTIN_RIPGREP
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL SEARCH-GATE CHECKS PASS')
  process.exit(0)
} else {
  console.log(` ❌ ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
