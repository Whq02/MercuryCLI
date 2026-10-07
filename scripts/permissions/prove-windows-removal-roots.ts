#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { evaluateWards, REFUSAL_WARDS } from '../../src/utils/wards/wards.ts'
import { getPlatform } from '../../src/utils/platform.ts'
import { createPathChecker } from '../../src/tools/BashTool/pathValidation.ts'
import { isDangerousRemovalPath } from '../../src/utils/permissions/pathValidation.ts'
import { getEmptyToolPermissionContext } from '../../src/Tool.ts'

let failures = 0
let checks = 0
function check(label: string, ok: boolean): void {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
}
const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const home = process.env.HOME
const profile = process.env.USERPROFILE
const rules = REFUSAL_WARDS.filter(rule => rule.name === 'no-root-recursive-delete')
const refused = (operand: string): boolean => !evaluateWards(rules, { toolName: 'Bash', input: {}, shellCommand: `rm -rf ${operand}` }).allow
try {
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
  getPlatform.cache.set(undefined, 'windows')
  process.env.HOME = process.env.USERPROFILE = 'C:\\Users\\Proof Operator'
  for (const drive of ['C', 'd', 'Z']) {
    for (const root of [`${drive}:\\`, `${drive}:/`, `/${drive.toLowerCase()}/`, `/${drive.toLowerCase()}`]) {
      for (const operand of [root, `'${root}'`, `"${root}"`]) check(`Windows refuses drive root ${operand}`, refused(operand))
    }
  }
  const homes = ['C:\\Users\\Proof Operator', 'C:/Users/Proof Operator', '/c/Users/Proof Operator', 'c:/users/proof operator', '$USERPROFILE', '${USERPROFILE}', '%USERPROFILE%']
  for (const path of homes) {
    for (const operand of [`'${path}'`, `"${path}"`]) check(`Windows refuses own home ${operand}`, refused(operand))
  }
  process.env.HOME = process.env.USERPROFILE = 'C:\\Users\\Proof'
  for (const operand of ['C:\\Users\\Proof', 'C:/Users/Proof', '/c/Users/Proof', '$USERPROFILE', '%USERPROFILE%']) check(`Windows refuses unquoted own home ${operand}`, refused(operand))
  for (const operand of ['C:/Users/Proof2', 'C:/Users/Other', 'C:/Users/Proof/project', '/c/Users/Proof/project', '/c/Users/Other', 'C:/Windows', 'C:\\Windows', 'C:/Users', 'C:\\Users', '/c/Windows', '/c/Users']) check(`Windows leaves non-root operand to permission check ${operand}`, !refused(operand))
  check('Windows home comparison is case-insensitive', isDangerousRemovalPath('c:/uSeRs/pRoOf'))
  const checker = createPathChecker('rm')
  for (const path of ['C:\\Windows', 'C:/Windows', '/c/Windows', 'C:\\Users', 'C:/Users', '/c/Users', 'c:/users/proof']) {
    const result = checker(['-rf', path], 'C:\\work\\project', getEmptyToolPermissionContext())
    check(`Windows critical-path permission card ${path}`, result.behavior === 'ask' && result.message.includes('critical system directory'))
  }
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' })
  getPlatform.cache.set(undefined, 'macos')
  process.env.HOME = '/Users/proof'
  for (const operand of ['/', '~', '$HOME', '/Users/proof', '/Users', '/System']) check(`Mac refusal unchanged ${operand}`, refused(operand))
  for (const operand of ['/c', '/c/', '/c/Users/Proof', '/private/tmp/proof', '/Users/proof/project']) check(`Mac non-refusal unchanged ${operand}`, !refused(operand))
  check('Mac home comparison remains case-sensitive', !isDangerousRemovalPath('/Users/PROOF'))
} finally {
  Object.defineProperty(process, 'platform', descriptor)
  getPlatform.cache.delete(undefined)
  if (home === undefined) delete process.env.HOME
  else process.env.HOME = home
  if (profile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = profile
}
console.log(`${failures ? 'FAIL' : 'PASS'} windows-removal-roots: ${checks - failures}/${checks}`)
process.exitCode = failures ? 1 : 0
