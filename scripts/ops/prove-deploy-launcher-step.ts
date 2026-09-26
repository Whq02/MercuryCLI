#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const DEPLOY = join(ROOT, 'scripts/splash/deploy.sh')
const { shimContent } = await import('../../src/services/privateChannel/installLayout.ts')
const scratch = mkdtempSync(join(tmpdir(), 'deploy-launcher-step-'))
const launcherAt = (name: string, text: string): string => {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'mercury')
  writeFileSync(path, text)
  chmodSync(path, 0o755)
  return path
}
const deploy = (launcher: string): { rc: number; out: string; lines: string[] } => {
  const home = mkdtempSync(join(scratch, 'home-'))
  const run = spawnSync('bash', [DEPLOY], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_LAUNCHER: launcher, MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' },
  })
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
  return { rc: run.status ?? -1, out, lines: out.split('\n').filter(l => l.startsWith('launcher action block')) }
}
const RED = 'RED WHERE THE STEP REFUSES A SHIM IT DOES NOT OWN'

section("§1 the installer's stable shim at the launcher path: skipped quietly, untouched")
const shim = launcherAt('shim', shimContent(false))
const shimBefore = readFileSync(shim, 'utf8')
const shimRun = deploy(shim)
check('the deploy itself succeeds (the splash pair lands in the scratch home)', shimRun.rc === 0 && /deployed → .*splash\.mjs/.test(shimRun.out), `rc=${shimRun.rc}\n${shimRun.out}`)
check(`${RED}: no REFUSED line for the shim`, !/REFUSED/.test(shimRun.out), shimRun.lines.join(' | '))
check(`${RED}: one quiet line says the shim was skipped as not ours, and names it`, shimRun.lines.length === 1 && /^launcher action block: skipped — not ours: /.test(shimRun.lines[0] ?? '') && (shimRun.lines[0] ?? '').includes(shim), shimRun.lines.join(' | '))
check('the shim is byte-identical after the deploy', readFileSync(shim, 'utf8') === shimBefore)
check("the fixture is the installer's own shim text (the managed marker, no block, no resolver, no args anchor)", shimBefore.includes('mercury-managed-shim') && !shimBefore.includes('mercury_resolve_home') && !/^args=\(\)/m.test(shimBefore) && !shimBefore.includes('mercury-splash-action-begin'))

section('§2 a foreign launcher with none of the anchors: the same quiet line')
const foreign = launcherAt('foreign', '#!/bin/sh\nexec /opt/other/bin/mercury "$@"\n')
const foreignRun = deploy(foreign)
check(`${RED}: a foreign launcher is skipped quietly too, never refused`, foreignRun.rc === 0 && !/REFUSED/.test(foreignRun.out) && foreignRun.lines.length === 1 && /^launcher action block: skipped — not ours: /.test(foreignRun.lines[0] ?? ''), foreignRun.lines.join(' | '))
check('the foreign launcher is untouched', readFileSync(foreign, 'utf8') === '#!/bin/sh\nexec /opt/other/bin/mercury "$@"\n')

section('§3 the controls: our own launcher is managed; an old-generation launcher of ours still refuses loudly')
const ours = launcherAt('ours', readFileSync(join(ROOT, 'scripts/ops/launcher-mercury.sh'), 'utf8'))
const oursRun = deploy(ours)
check('the repo launcher is recognised and managed (refreshed or already current), exit 0', oursRun.rc === 0 && oursRun.lines.length === 1 && /^launcher action block(: already current| refreshed → )/.test(oursRun.lines[0] ?? ''), `rc=${oursRun.rc} ${oursRun.lines.join(' | ')}`)
check('the managed launcher still carries the block markers once', (readFileSync(ours, 'utf8').match(/^: mercury-splash-action-begin$/gm) ?? []).length === 1 && (readFileSync(ours, 'utf8').match(/^: mercury-splash-action-end$/gm) ?? []).length === 1)
const old = launcherAt('old', '#!/bin/bash\nmercury_resolve_home() { printf %s "$HOME/.mercury"; }\nargs=()\nexec node "$HOME/.mercury/runtime/dist/mercury.mjs" "${args[@]}" "$@"\n')
const oldBefore = readFileSync(old, 'utf8')
const oldRun = deploy(old)
check('an old-generation launcher of ours (no MERCURY_SA_EXIT capture) still refuses loudly with exit 1 and nothing written', oldRun.rc === 1 && /REFUSED — .* is an OLD-generation launcher/.test(oldRun.out) && readFileSync(old, 'utf8') === oldBefore, `rc=${oldRun.rc} ${oldRun.lines.join(' | ')}`)
const absent = join(scratch, 'absent', 'mercury')
const absentRun = deploy(absent)
check('no launcher at the path: the step says so and the deploy still succeeds', absentRun.rc === 0 && absentRun.out.includes(`launcher not found at ${absent}`), `rc=${absentRun.rc}`)

section('§4 the source: the not-ours arm prints the quiet line, and REFUSED stays for a launcher that is ours')
const src = readFileSync(DEPLOY, 'utf8')
const arm = src.slice(src.indexOf('if not is_mercury_launcher:'), src.indexOf('# the pairing guard'))
check(`${RED}: the not-ours arm says skipped — not ours, never REFUSED`, arm.includes("skipped — not ours: {launcher}") && !arm.includes('REFUSED') && !arm.includes('does not look like a Mercury launcher'), arm.trim())
check('the arm exits 0 (the splash deploy is whole without the block)', /sys\.exit\(0\)/.test(arm))
check('REFUSED remains the word for a launcher that is ours and wrong (the old generation, a broken marker pair)', src.includes("is an OLD-generation launcher") && src.includes("print(f'launcher action block: REFUSED — {launcher}: {why};"))

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅' : '❌'} the deploy skips a shim it does not own: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
