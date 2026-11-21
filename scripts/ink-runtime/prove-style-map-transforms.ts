#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.FORCE_COLOR = '3'
delete process.env.TMUX
const scratchHome = (): string => mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'style-map-home-'))
process.env.MERCURY_CONFIG_DIR = scratchHome()

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

console.log('prove-style-map-transforms — arm 1: bun (in-process)')
const { runStyleMapLaws } = await import('./styleMapLaws.ts')
failures += await runStyleMapLaws('bun')

section('arm 2: node (bundle-and-run — the shipped wrap engine)')
{
  const cache = join(ROOT, 'node_modules', '.cache', 'mercury-style-map-node')
  mkdirSync(cache, { recursive: true })
  const macro = join(cache, 'macro.ts')
  writeFileSync(macro, ";(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }\n")
  const entry = join(cache, 'entry.ts')
  const bundle = join(cache, 'style-map-laws.node.mjs')
  writeFileSync(
    entry,
    [
      `import './macro.ts'`,
      `import { runStyleMapLaws } from '${join(ROOT, 'scripts/ink-runtime/styleMapLaws.ts')}'`,
      `process.exit(await runStyleMapLaws('node'))`,
      '',
    ].join('\n'),
  )
  const bunBin = process.env.BUN ?? (existsSync(join(homedir(), '.bun/bin/bun')) ? join(homedir(), '.bun/bin/bun') : 'bun')
  const built = spawnSync(bunBin, [join(ROOT, 'scripts/search/lib/bundle-for-node.ts'), entry, bundle], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    timeout: 180_000,
  })
  check('the laws bundle for node (the search suite\'s bundle-for-node, the product\'s own resolution laws)', built.status === 0, `${built.stdout}${built.stderr}`.slice(-600) + ' — the bundle step failed; fix the import or syntax error named above in scripts/ink-runtime/styleMapLaws.ts or what it imports, or check scripts/search/lib/bundle-for-node.ts')
  if (built.status === 0) {
    const nodeBin = process.env.MERCURY_NODE_BIN ?? 'node'
    const version = spawnSync(nodeBin, ['--version'], { encoding: 'utf8', env: process.env }).stdout?.trim() ?? '(unknown)'
    console.log(`  node arm: ${nodeBin} ${version}`)
    const ran = spawnSync(nodeBin, [bundle], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '3', MERCURY_CONFIG_DIR: scratchHome() },
      timeout: 180_000,
    })
    process.stdout.write(ran.stdout ?? '')
    const stderrLines = (ran.stderr ?? '').split('\n').filter(l => l.trim() !== '')
    if (stderrLines.length > 0) process.stdout.write(stderrLines.map(l => `    | ${l}`).join('\n') + '\n')
    check('every law holds under node too (the arm relays its failure count)', ran.status === 0, `status ${ran.status} — read the FAIL lines the node arm printed above; the laws are in scripts/ink-runtime/styleMapLaws.ts, so fix the style-map code they exercise so it holds under node as well as bun`)
    check('the node arm actually ran the laws (its log carries the §4 defect pin)', (ran.stdout ?? '').includes('(node) THE DEFECT PIN: the second segment is wholly red past the decomposed cluster'), 'the node arm did not print its defect-pin line; it likely crashed before the laws finished (see the stderr lines above) or the pin text changed in scripts/ink-runtime/styleMapLaws.ts')
  }
}


console.log(failures === 0 ? '\nprove-style-map-transforms: ALL LAWS HOLD (bun + node)' : `\nprove-style-map-transforms: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
