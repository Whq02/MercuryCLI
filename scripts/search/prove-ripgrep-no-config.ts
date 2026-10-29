#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { resolveRipgrep, ripGrep } = await import('../../src/utils/ripgrep.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 THE RESOLVED CONFIG')
{
  const { mode, config } = resolveRipgrep()
  check(
    `the ${mode} branch carries --no-config (FC-040)`,
    (config.rgArgs ?? []).includes('--no-config'),
    JSON.stringify({ mode, rgArgs: config.rgArgs }),
  )
}

section('§2 LIVE — the rc file cannot blind the walk')
{
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'rg-noconfig-')))
  mkdirSync(join(scratch, 'deep', 'deeper'), { recursive: true })
  writeFileSync(join(scratch, 'top.md'), 'top')
  writeFileSync(join(scratch, 'deep', 'deeper', 'nested.md'), 'nested')
  const rcPath = join(scratch, 'rg-rc')
  writeFileSync(rcPath, '--max-depth=1\n')
  const before = process.env.RIPGREP_CONFIG_PATH
  process.env.RIPGREP_CONFIG_PATH = rcPath
  try {
    const found = await ripGrep(['--files', '--glob', '*.md'], scratch, AbortSignal.timeout(20_000))
    const names = found.map(f => f.split('/').pop())
    check('the nested file is FOUND despite --max-depth=1 in the rc', names.includes('nested.md'), JSON.stringify(names))
    check('the top-level file too (the search itself works)', names.includes('top.md'))
  } finally {
    if (before === undefined) delete process.env.RIPGREP_CONFIG_PATH
    else process.env.RIPGREP_CONFIG_PATH = before
    rmSync(scratch, { recursive: true, force: true })
  }
}

section('§3 STRUCTURAL — refusal degrade + overflow report')
{
  const loader = readFileSync(join(import.meta.dir, '../../src/utils/markdownConfigLoader.ts'), 'utf8')
  check(
    'the estate discovery is the native capped walk; a walk stopped by a cap is logged loudly and kept partial (FC-041)',
    /async function discoverMarkdownFiles[\s\S]{0,600}logError\(new Error\(`markdownConfigLoader: \$\{note\}`\)\)/.test(loader) && /addBootNote\('warn', note\)/.test(loader),
  )
  const rg = readFileSync(join(import.meta.dir, '../../src/utils/ripgrep.ts'), 'utf8')
  check(
    'the overflow drop is reported with the salvage count (FC-042)',
    /isOverflow[\s\S]{0,400}exceeded the[\s\S]{0,200}salvaged/.test(rg),
  )
}

if (failures > 0) {
  console.error(`\nprove-ripgrep-no-config: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-ripgrep-no-config: all green')
