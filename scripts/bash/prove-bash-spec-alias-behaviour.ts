#!/usr/bin/env bun
import { getCommandSpec } from '../../src/platform/shell/bash/commandSpecs.ts'
import spec from '../../src/platform/shell/bash/specs/alias.ts'

const WHERE = 'the default export of src/platform/shell/bash/specs/alias.ts'
const RECORD = "{\"name\":\"alias\",\"description\":\"Create or list command aliases\",\"args\":{\"name\":\"definition\",\"description\":\"Alias definition in the form name=value\",\"isOptional\":true,\"isVariadic\":true}}"
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('§1 the record')
check('it is the record of alias, member for member and in this order, its words exact', JSON.stringify(spec) === RECORD, `got ${JSON.stringify(spec)}, expected ${RECORD}; see ${WHERE}`)
check('its one argument, the definition, may be left out and may be given several times', JSON.stringify(spec.args) === JSON.stringify(JSON.parse(RECORD).args) && JSON.stringify(spec.options) === JSON.stringify(JSON.parse(RECORD).options))

console.log('§2 how the command registry serves it')
{
  const served = await getCommandSpec('alias')
  check('asking the registry for alias answers this very record', served === spec, `got ${JSON.stringify(served)}; getCommandSpec in src/platform/shell/bash/commandSpecs.ts must find ${WHERE} by its name before it looks anywhere else`)
  check('and again on a second asking', (await getCommandSpec('alias')) === spec)
}

if (failures > 0) {
  console.error(`\nprove-bash-spec-alias-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-bash-spec-alias-behaviour: all green')
