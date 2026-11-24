#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { getPlatform } from '../../src/platform/environment/platform.js'
import { protectedPathForms, spelling } from '../../src/permissions/rules/protectedPaths.js'

let failures = 0
const HINT = 'spelling() in src/permissions/rules/protectedPaths.ts must turn bare /c, /c/, /mnt/c and /mnt/c/ into c:/ while leaving /cache and /c2 alone'

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${detail ? `${detail} — ` : ''}${HINT}`}`)
  if (!ok) failures++
}

getPlatform.cache.set(undefined, 'windows')
try {
  const driveForms = protectedPathForms('c:/')
  check('c:/ holds drive-root form c:', driveForms.includes('c:'), JSON.stringify(driveForms))
  for (const input of ['/c', '/c/', '/mnt/c', '/mnt/c/', '/C', '/MNT/C']) {
    const forms = protectedPathForms(input)
    check(`${input} holds the same drive-root form as c:/`, forms.includes('c:') && driveForms.every(f => forms.includes(f)), JSON.stringify(forms))
  }
  const slashSub = protectedPathForms('/c/users/x')
  const driveSub = protectedPathForms('c:/users/x')
  check('/c/users/x and c:/users/x give the same forms', JSON.stringify(slashSub) === JSON.stringify(driveSub), `${JSON.stringify(slashSub)} vs ${JSON.stringify(driveSub)}`)
  for (const nonDrive of ['/cache', '/c2', '/mnt/cache', '/mnt/c2']) {
    const spelled = spelling(nonDrive)
    const forms = protectedPathForms(nonDrive)
    check(`${nonDrive} is not turned into a drive`, spelled === nonDrive && !forms.includes('c:') && forms.includes(nonDrive), `spelling=${JSON.stringify(spelled)} forms=${JSON.stringify(forms)}`)
  }
} finally {
  getPlatform.cache.delete(undefined)
}

console.log(`bare-drive-root-form: ${failures ? `FAIL (${failures})` : 'PASS'}`)
process.exit(failures ? 1 : 0)
