#!/usr/bin/env bun
// prove-skill-dir-siblings — two command-discovery defects (field cards
// FC-056 · FC-057).
//
// FC-057: a SKILL.md anywhere inside a commands/ folder silently deleted
//   every sibling .md in that folder — three files on disk, one command
//   registered, nothing on any channel. The siblings now register as
//   ordinary commands beside the directory skill.
// FC-056: two custom files resolving to one name registered one and dropped
//   the other with the only record behind --debug; a custom-vs-custom
//   collision now rides the error channel doctor surfaces.
//
//   §1 FC-057: SKILL.md + two siblings ⇒ three registrations.
//   §2 FC-056: a same-name pair ⇒ one registered, the drop VISIBLE on the
//      error channel.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'skill-sib-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'skill-sib-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const commandsDir = join(PROJ, '.mercury', 'commands')
mkdirSync(join(commandsDir, 'skdir'), { recursive: true })
const md = (body: string): string => `---\ndescription: probe\n---\n${body}\n`
writeFileSync(join(commandsDir, 'skdir', 'SKILL.md'), md('the directory skill'))
writeFileSync(join(commandsDir, 'skdir', 'sibA.md'), md('sibling A'))
writeFileSync(join(commandsDir, 'skdir', 'sibB.md'), md('sibling B'))
// The FC-056 collision pair: race.md beside race/SKILL.md.
mkdirSync(join(commandsDir, 'a1', 'race'), { recursive: true })
writeFileSync(join(commandsDir, 'a1', 'race.md'), md('the file claimant'))
writeFileSync(join(commandsDir, 'a1', 'race', 'SKILL.md'), md('the dir claimant'))
process.chdir(PROJ)

const { getCommands } = await import('../../src/commands.ts')
const { getInMemoryErrors } = await import('../../src/utils/log.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const roster = await getCommands(PROJ)
const names = roster.map(c => c.name)

section('§1 FC-057 — siblings survive the SKILL.md')
{
  check('the directory skill registers', names.includes('skdir'), JSON.stringify(names.filter(n => n.includes('skdir'))))
  check('sibling A registers beside it', names.some(n => n.endsWith('sibA')), JSON.stringify(names.filter(n => n.includes('sib'))))
  check('sibling B registers beside it', names.some(n => n.endsWith('sibB')))
}

section('§2 FC-056 — the collision is visible')
{
  const raceEntries = names.filter(n => n === 'a1:race')
  check('exactly one a1:race registers (first wins)', raceEntries.length === 1, JSON.stringify(raceEntries))
  const errors = getInMemoryErrors().map(e => e.error)
  check(
    'the drop rides the ERROR channel (FC-056)',
    errors.some(e => /collision on \/a1:race/.test(e)),
    JSON.stringify(errors.slice(-3)),
  )
}

rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-skill-dir-siblings: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-skill-dir-siblings: all green')
