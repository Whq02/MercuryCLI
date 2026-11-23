#!/usr/bin/env bun


let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''} — fix isPathInside in src/tools/read/pathPrefix.ts`)
  }
}

console.log('§1 TS-2 — isPathInside: one fold, every separator spelling')
{
  const { isPathInside } = await import('../../src/tools/read/pathPrefix.ts')
  check('a native win32 dir accepts its native child', isPathInside('C:\\u\\m\\plans\\slug.md', 'C:\\u\\m\\plans', 'win32'))
  check('…and the POSIX spelling of the same child (the model writes POSIX at native dirs)', isPathInside('C:/u/m/plans/slug.md', 'C:\\u\\m\\plans', 'win32'))
  check('…mixed spellings inside the path too', isPathInside('C:\\u/m\\plans/slug.md', 'C:/u\\m/plans', 'win32'))
  check('NTFS case-insensitivity is honoured on win32', isPathInside('c:\\U\\M\\PLANS\\slug.md', 'C:\\u\\m\\plans', 'win32'))
  check('the directory itself counts (the plans guards always did)', isPathInside('C:\\u\\m\\plans', 'C:\\u\\m\\plans', 'win32'))
  check('a sibling-prefix directory never matches', !isPathInside('/u/m/plansX/f.md', '/u/m/plans', 'linux') && !isPathInside('C:\\u\\m\\plansX\\f.md', 'C:\\u\\m\\plans', 'win32'))
  check('POSIX behaviour is byte-identical to the old guard (case stays significant)', isPathInside('/u/m/plans/slug.md', '/u/m/plans', 'linux') && !isPathInside('/u/m/PLANS/slug.md', '/u/m/plans', 'linux'))
}

process.exit(failures === 0 ? 0 : 1)
