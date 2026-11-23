#!/usr/bin/env bun
import { getCommandSpec } from '../../src/platform/shell/bash/commandSpecs.ts'
import spec from '../../src/platform/shell/bash/specs/time.ts'

const WHERE = 'the default export of src/platform/shell/bash/specs/time.ts'
const RECORD = "{\"name\":\"time\",\"description\":\"Measure how long a command takes\",\"args\":{\"name\":\"command\",\"description\":\"The command being timed\",\"isCommand\":true}}"
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('§1 the record')
check('it is the record of time, member for member and in this order, its words exact', JSON.stringify(spec) === RECORD, `got ${JSON.stringify(spec)}, expected ${RECORD}; see ${WHERE}`)
check('its one argument is itself a command', JSON.stringify(spec.args) === JSON.stringify(JSON.parse(RECORD).args) && JSON.stringify(spec.options) === JSON.stringify(JSON.parse(RECORD).options))

console.log('§2 how the command registry serves it')
{
  const served = await getCommandSpec('time')
  check('asking the registry for time answers this very record', served === spec, `got ${JSON.stringify(served)}; getCommandSpec in src/platform/shell/bash/commandSpecs.ts must find ${WHERE} by its name before it looks anywhere else`)
  check('and again on a second asking', (await getCommandSpec('time')) === spec)
}

if (failures > 0) {
  console.error(`\nprove-bash-spec-time-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-bash-spec-time-behaviour: all green')
