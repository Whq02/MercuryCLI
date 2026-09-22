#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Stats } from 'node:fs'

const REPO = join(import.meta.dir, '..', '..')
const SRC = process.env.PROVE_SRC ?? join(REPO, 'src')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

console.log('§1 the predicate: a stat-known named pipe, socket or device is never watched; everything else is the watcher\'s own rule')
const { ignoringSpecialFiles } = await import('../../src/utils/watchRoot.ts')
const statOf = (kind: 'file' | 'dir' | 'fifo' | 'socket' | 'char' | 'block'): Stats =>
  ({
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isFIFO: () => kind === 'fifo',
    isSocket: () => kind === 'socket',
    isCharacterDevice: () => kind === 'char',
    isBlockDevice: () => kind === 'block',
    isSymbolicLink: () => false,
  }) as unknown as Stats
const asked: string[] = []
const byPath = ignoringSpecialFiles((candidatePath: string) => {
  asked.push(candidatePath)
  return candidatePath.endsWith('.git')
})
for (const kind of ['fifo', 'socket', 'char', 'block'] as const) {
  check(`a ${kind} stat is ignored before the rule is asked`, byPath('/h/settings.json', statOf(kind)) === true && !asked.includes('/h/settings.json'))
}
check('a file stat defers to the rule (kept)', byPath('/h/keep.json', statOf('file')) === false && asked.includes('/h/keep.json'))
check('a file stat defers to the rule (ignored by path)', byPath('/h/.git', statOf('file')) === true)
check('a directory stat defers to the rule', byPath('/h/dir', statOf('dir')) === false)
check('no stat defers to the rule', byPath('/h/nostat.git', undefined) === true && byPath('/h/nostat', undefined) === false)
const bare = ignoringSpecialFiles()
check('with no rule of its own, only a special file is ignored', bare('/h/x', statOf('fifo')) === true && bare('/h/x', statOf('file')) === false && bare('/h/x', undefined) === false)

console.log('\n§2 every directory-listing watcher reads the predicate')
const WATCHERS: Array<[string, string]> = [
  ['the settings change detector', 'utils/settings/changeDetector.ts'],
  ['the keybindings loader', 'keybindings/loadUserBindings.ts'],
  ['the hooks file-changed watcher', 'utils/hooks/fileChangedWatcher.ts'],
  ['the agent definitions watcher', 'services/agents/watch.ts'],
  ['the skills change detector', 'utils/skills/skillChangeDetector.ts'],
]
for (const [name, rel] of WATCHERS) {
  let text = ''
  try {
    text = readFileSync(join(SRC, rel), 'utf8')
  } catch (e) {
    check(`${name} (${rel}) is readable`, false, e instanceof Error ? e.message : String(e))
    continue
  }
  const imports = /import \{[^}]*\bignoringSpecialFiles\b[^}]*\} from '[^']*watchRoot\.js'/.test(text)
  const applied = (text.match(/ignored: ignoringSpecialFiles\(/g) ?? []).length
  const watches = (text.match(/(?:\.watch|watcherFactory)\([^\n{}]*\{/g) ?? []).length
  check(`${name} imports the predicate and applies it to each of its ${watches} watch call(s)`, imports && applied >= 1 && applied === watches, `imports=${imports} applied=${applied} watch calls=${watches}`)
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
