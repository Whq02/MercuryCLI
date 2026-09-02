#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isUnderHomeRoot } from '../../src/utils/realmRegistry.ts'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, ok: boolean): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}`)
  }
}

console.log('§1 the guard admits native win32 folders under the home root')
check(
  'a native backslash folder under home is INSIDE (the S1 repro)',
  isUnderHomeRoot('C:\\Users\\name\\projects\\anything', 'C:\\Users\\name', 'win32'),
)
check(
  'the drive/dir case twin is INSIDE on win32 (its filesystems fold case)',
  isUnderHomeRoot('c:\\users\\NAME\\projects\\foo', 'C:\\Users\\name', 'win32'),
)
check(
  'a forward-slash spelling of the same folder is INSIDE on win32',
  isUnderHomeRoot('C:/Users/name/projects/foo', 'C:\\Users\\name', 'win32'),
)
check(
  'the home root itself is INSIDE (addRealm refuses it separately, with its own honest line)',
  isUnderHomeRoot('C:\\Users\\name', 'C:\\Users\\name', 'win32'),
)

console.log('§2 the guard still refuses what is genuinely outside')
check('another drive is OUTSIDE', !isUnderHomeRoot('D:\\stuff', 'C:\\Users\\name', 'win32'))
check(
  'a sibling user is OUTSIDE (no bare-prefix collision: name2 does not match name)',
  !isUnderHomeRoot('C:\\Users\\name2\\proj', 'C:\\Users\\name', 'win32'),
)

console.log('§3 POSIX behavior is byte-identical to the old guard')
check('a folder under home is INSIDE', isUnderHomeRoot('/Users/x/dev/proj', '/Users/x', 'darwin'))
check('a sibling-prefix home is OUTSIDE', !isUnderHomeRoot('/Users/xy/dev', '/Users/x', 'darwin'))
check('case does NOT fold on POSIX (case-sensitive filesystems)', !isUnderHomeRoot('/users/X/dev', '/Users/x', 'linux'))

console.log('§4 the POISON: the POSIX-only spelling is gone from the owner')
{
  const src = readFileSync(join(ROOT, 'src/utils/realmRegistry.ts'), 'utf8')
  check(
    "no `startsWith(home + '/')` guard remains in realmRegistry",
    !src.includes("startsWith(home + '/')"),
  )
  check('both doors (addRealm + cloneRealm) ride the one fold', (src.match(/isUnderHomeRoot\(/g) ?? []).length >= 3)
}

console.log('§5 a spaced folder is ONE argument on the /realms command surface')
{
  const cmd = readFileSync(join(ROOT, 'src/commands/realms/realms.tsx'), 'utf8')
  check(
    "the add arm joins the remainder (a spaced path is not judged by its first word)",
    /case 'add': \{[\s\S]{0,400}?const path = rest\.join\(' '\)/.test(cmd),
  )
  check(
    'the clone arm keeps the whole remainder as the one target path',
    cmd.includes("const target = rest.length > 1 ? rest.slice(1).join(' ') : undefined"),
  )
  check("the add arm's positional truncation is gone", !/case 'add': \{[\s\S]{0,200}?const \[path\] = rest/.test(cmd))
}

process.exit(failures === 0 ? 0 : 1)
