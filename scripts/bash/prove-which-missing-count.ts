import assert from 'node:assert/strict'
import { pinSourceRef } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const { interpretCommandResult } = await import('../../src/tools/BashTool/commandSemantics.js')
const { parseForSecurity } = await import('../../src/utils/permissions/decision/commandAnalysis.js')
const result = async (command: string, code: number) => {
  await parseForSecurity(command)
  return interpretCommandResult(command, code, '', '')
}
for (const [command, code] of [
  ['which missing-one missing-two', 2],
  ['which found missing-one missing-two', 2],
  ['which -a missing-one missing-two missing-three', 3],
  ['which --all "missing one" "missing two"', 2],
  ['printf ready; which missing-one missing-two 2>&1', 2],
  ['X=1 env -i which missing-one missing-two', 2],
  ['which -- -one -two', 2],
] as const) assert.deepEqual(await result(command, code), { isError: false, message: 'a name was not found' }, command)
for (const [command, code] of [
  ['which missing-one', 2],
  ['which "one name only"', 2],
  ['which missing-one missing-two', 3],
  ['which --not-an-option missing-one missing-two', 2],
  ['which missing-one missing-two', 126],
  ['which missing-one missing-two', 127],
  ['which missing-one missing-two', 143],
  ['command -v missing-one missing-two', 2],
  ['grep missing-one missing-two', 2],
  ['which missing-one; false', 1],
] as const) assert.equal((await result(command, code)).isError, true, command)
assert.deepEqual(await result('which missing-one', 1), { isError: false, message: 'a name was not found' })
assert.equal((await result('which found', 0)).isError, false)
console.log('PASS GNU which missing-name counts are results; excess status, invalid options and other commands stay errors')
