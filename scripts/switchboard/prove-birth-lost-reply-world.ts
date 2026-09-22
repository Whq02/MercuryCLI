#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DRIVE = 'scripts/switchboard/prove-birth-lost-reply-drive.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const SPELLED_ROOT = /(?:^|[^A-Za-z0-9_])\/(?:private\/tmp|tmp|var\/folders|Users|home)\b/
const rootLineOf = (source: string): string | null => source.match(/^const WORLD_ROOT = (.*)$/m)?.[1] ?? null
const spelledRoots = (source: string): string[] => source.split('\n').flatMap((line, i) => (SPELLED_ROOT.test(line) ? [`${i + 1}: ${line.trim().slice(0, 80)}`] : []))
const derivesFromTmpdir = (source: string): boolean => /^import \{[^}]*\btmpdir\b[^}]*\} from 'node:os'$/m.test(source) && /\btmpdir\(\)/.test(rootLineOf(source) ?? '')
const realWorld = (source: string): boolean => /realpathSync\(mkdtempSync\(join\(WORLD_ROOT, /.test(source)

console.log('§0 the self-test: a drive that spells its root reds, a drive that derives it greens')
{
  const spelled = ["import { join } from 'node:path'", "const WORLD_ROOT = '/private/tmp/scratch'", "const world = realpathSync(mkdtempSync(join(WORLD_ROOT, 'x-')))"].join('\n')
  const derived = ["import { tmpdir } from 'node:os'", "import { join } from 'node:path'", 'const WORLD_ROOT = tmpdir()', "const world = realpathSync(mkdtempSync(join(WORLD_ROOT, 'x-')))"].join('\n')
  const linked = derived.replace('realpathSync(mkdtempSync(', 'mkdtempSync((')
  check('a spelled Mac root is found on its line', spelledRoots(spelled).length === 1 && spelledRoots(spelled)[0]!.startsWith('2:'), spelledRoots(spelled).join(' | '))
  check('a spelled root is not a derived one', !derivesFromTmpdir(spelled))
  check('a derived root spells nothing and reads tmpdir()', spelledRoots(derived).length === 0 && derivesFromTmpdir(derived))
  check('a world that is not a real path is caught', realWorld(derived) && !realWorld(linked))
  check('a Linux /tmp and a Mac /var/folders spelling trip too', spelledRoots("const R = '/tmp/scratch'").length === 1 && spelledRoots("const R = '/var/folders/x'").length === 1)
}

console.log(`§1 the drive's world root (${DRIVE})`)
{
  const source = readFileSync(join(REPO, DRIVE), 'utf8')
  const rootLine = rootLineOf(source)
  check('the drive names one WORLD_ROOT', rootLine !== null, 'no `const WORLD_ROOT =` line')
  check('the root is derived from the host temp dir (tmpdir() from node:os), so a runner that refuses a spelled root still reaches the drive', derivesFromTmpdir(source), rootLine ?? '')
  check('no line of the drive spells a machine temp root (/private/tmp, /tmp, /var/folders, a home)', spelledRoots(source).length === 0, spelledRoots(source).join(' | '))
  check('the world is a real path (a symlinked temp dir would key the seeded trust on the wrong spelling)', realWorld(source))
}

console.log(failures === 0 ? '\nprove-birth-lost-reply-world: THE ROOT IS DERIVED, NEVER SPELLED' : `\nprove-birth-lost-reply-world: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
