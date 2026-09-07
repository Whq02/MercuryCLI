#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'unv-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'unv-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const md = (body: string): string => `---\ndescription: probe\n---\n${body}\n`
const skillsDir = join(PROJ, '.mercury', 'skills')
mkdirSync(join(skillsDir, 'has space'), { recursive: true })
writeFileSync(join(skillsDir, 'has space', 'SKILL.md'), md('the spaced skill'))
mkdirSync(join(skillsDir, 'fine'), { recursive: true })
writeFileSync(join(skillsDir, 'fine', 'SKILL.md'), md('the fine skill'))
process.chdir(PROJ)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { parseSlashCommand } = await import('../../src/utils/slashCommandParsing.ts')
const { getCommands } = await import('../../src/commands.ts')
const skillsMod = (await import('../../src/skills/loadSkillsDir.ts')) as unknown as {
  getSkillLoadRefusals: () => Array<{ path: string; error: string; source: string }>
  slashNameProblem?: (name: string) => string | null
}

section("§1 THE PARSER'S GRAMMAR")
{
  check('the gate is exported (slashNameProblem)', typeof skillsMod.slashNameProblem === 'function')
  check('the empty name is unparseable (/ alone is null)', parseSlashCommand('/') === null)
  const spaced = parseSlashCommand('/w5 has space')
  check(
    "a spaced name can never round-trip ('/w5 has space' parses as command 'w5')",
    spaced !== null && spaced.commandName === 'w5',
    JSON.stringify(spaced),
  )
}

const roster = await getCommands(PROJ)
const names = roster.map(c => c.name)
const refusals = skillsMod.getSkillLoadRefusals()

section('§2 THE SKILLS LANE')
{
  check('the fine skill registers', names.includes('fine'))
  check('no EMPTY-named command sits in the roster', !names.some(n => n === '' || n.endsWith(':')))
  check(
    'no spaced command sits in the roster',
    !names.some(n => /\s/.test(n)),
    JSON.stringify(names.filter(n => /\s/.test(n))),
  )
  check(
    'the spaced skill directory is refused, named uninvocable',
    refusals.some(r => r.path.includes('has space') && r.error.includes('uninvocable')),
    JSON.stringify(refusals.filter(r => r.path.includes('has space'))),
  )
}

console.log(failures === 0 ? '\nprove-uninvocable-names: all green' : `\nprove-uninvocable-names: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
