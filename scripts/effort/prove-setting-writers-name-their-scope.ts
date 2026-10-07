#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const COMMANDS = join(ROOT, 'src', 'commands')
const WRITE_CALL = /updateSettingsForSource\(\s*'(userSettings|localSettings|projectSettings)'|saveGlobalConfig\(/
const SAYS_SAVED = /saved (as your default|for later boots|for future sessions)|Saved as your default/

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const sourcesOf = (dir: string): string[] => readdirSync(dir).filter(name => /\.tsx?$/.test(name)).map(name => join(dir, name))
const writers: string[] = []
for (const name of readdirSync(COMMANDS)) {
  const dir = join(COMMANDS, name)
  if (!statSync(dir).isDirectory()) continue
  const files = sourcesOf(dir)
  const text = files.map(file => readFileSync(file, 'utf8')).join('\n')
  if (WRITE_CALL.test(text)) writers.push(name)
}
console.log(`§1 the slash commands that write a setting from their own folder: ${writers.join(', ')}`)
check('the census finds the known writers', ['effort', 'vim', 'mouse', 'appearance'].every(name => writers.includes(name)), writers.join(','))

console.log('§2 a writer command\'s menu line never calls its write session-scoped')
for (const name of writers) {
  const index = readFileSync(join(COMMANDS, name, 'index.ts'), 'utf8')
  const description = /description:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/.exec(index)?.[2] ?? ''
  check(`/${name}: "${description.slice(0, 90)}${description.length > 90 ? '…' : ''}"`, !/for this session|this session only|session-only/i.test(description), description)
}

console.log('§3 the writers whose answer confirms a setting change say that it is saved and for whom')
const answers: Record<string, string[]> = {
  effort: ['Saved as your default for future sessions', 'saved as your default for future sessions'],
  vim: ['Editor mode set to ${next} — saved for later boots'],
  mouse: ['saved for later boots'],
  appearance: ['Theme set to ${setting} — saved for later boots', 'decorative animation off, state changes stay visible; saved for later boots', 'decorative animation on; saved for later boots'],
}
for (const [name, needles] of Object.entries(answers)) {
  const text = sourcesOf(join(COMMANDS, name)).map(file => readFileSync(file, 'utf8')).join('\n')
  for (const needle of needles) check(`/${name} says "${needle}"`, text.includes(needle))
  check(`/${name} carries a saved clause at all`, SAYS_SAVED.test(text))
}

console.log('§4 the model command\'s persisted choice names the default it writes')
const persist = readFileSync(join(COMMANDS, 'model', 'persistModelChoice.ts'), 'utf8')
check('persistModelChoice says "saved as your default"', persist.includes("' · saved as your default'"))

console.log(failures === 0 ? 'PASS: every slash command that writes a setting says so and names the scope' : `FAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
