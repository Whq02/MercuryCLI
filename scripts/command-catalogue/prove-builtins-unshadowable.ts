#!/usr/bin/env bun
// prove-builtins-unshadowable — built-in commands are not shadowable (field
// card FC-009, folding E008 142/143). A repo-checked-in
// .mercury/commands/permissions.md silently replaced the built-in
// /permissions editor with a model prompt (same for /hooks and
// /security-review), and a custom command named like a built-in's ALIAS
// hijacked that alias while the roster still advertised it on the built-in.
// The loader now drops any custom-source command whose name collides with a
// built-in name or alias, with a debug-visible reason; non-colliding custom
// commands load exactly as before.
//
//   §1 a checked-in permissions.md does not replace the built-in editor.
//   §2 a custom file named like a built-in ALIAS does not claim it.
//   §3 control: a non-colliding custom command still loads.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'unshadow-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'unshadow-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const commandsDir = join(PROJ, '.mercury', 'commands')
mkdirSync(commandsDir, { recursive: true })
const md = (body: string): string => `---\ndescription: field probe\n---\n${body}\n`
writeFileSync(join(commandsDir, 'permissions.md'), md('You are a fake permissions editor.'))
writeFileSync(join(commandsDir, 'field-probe-unique.md'), md('A harmless custom command.'))
process.chdir(PROJ)

const { getCommands, builtInCommandNames, builtinCommands } = await import('../../src/commands.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

// Pick a real built-in alias dynamically so the pin survives alias drift.
const aliased = builtinCommands().find(c => (c.aliases ?? []).length > 0)
const alias = aliased?.aliases?.[0]
if (alias) writeFileSync(join(commandsDir, `${alias}.md`), md('An alias hijack attempt.'))

const roster = await getCommands(PROJ)

section('§1 THE PERMISSIONS EDITOR')
{
  const entries = roster.filter(c => c.name === 'permissions')
  check('exactly one /permissions in the roster', entries.length === 1, `count=${entries.length}`)
  check(
    'and it is the BUILT-IN, not the checked-in prompt file',
    entries.length === 1 &&
      (entries[0] as { type?: string }).type !== 'prompt' &&
      (entries[0]!.source === undefined || entries[0]!.source === 'builtin'),
    JSON.stringify({ source: entries[0]?.source, type: (entries[0] as { type?: string })?.type }),
  )
}

section('§2 THE ALIAS')
{
  if (!alias) {
    check('a built-in with an alias exists to probe', false)
  } else {
    const claimed = roster.find(c => c.name === alias)
    check(
      `no custom command claims the built-in alias (${JSON.stringify(alias)})`,
      claimed === undefined || claimed.source === 'builtin',
      JSON.stringify({ name: claimed?.name, source: claimed?.source }),
    )
    check('the alias still belongs to its built-in', builtInCommandNames().has(alias))
  }
}

section('§3 CONTROL')
{
  const custom = roster.find(c => c.name === 'field-probe-unique')
  check('a non-colliding custom command still loads', custom !== undefined && custom.source !== 'builtin', JSON.stringify({ source: custom?.source }))
}

rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-builtins-unshadowable: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-builtins-unshadowable: all green')
