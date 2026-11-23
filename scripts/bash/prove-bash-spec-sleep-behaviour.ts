#!/usr/bin/env bun
import { getCommandSpec } from '../../src/platform/shell/bash/commandSpecs.ts'
import spec from '../../src/platform/shell/bash/specs/sleep.ts'

const WHERE = 'the default export of src/platform/shell/bash/specs/sleep.ts'
const RECORD = "{\"name\":\"sleep\",\"description\":\"Pause for a duration\",\"args\":{\"name\":\"duration\",\"description\":\"How long to pause \u2014 bare seconds, or with a 5s/2m/1h suffix\",\"isOptional\":false}}"
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('§1 the record')
check('it is the record of sleep, member for member and in this order, its words exact', JSON.stringify(spec) === RECORD, `got ${JSON.stringify(spec)}, expected ${RECORD}; see ${WHERE}`)
check('its one argument, the duration, is required', JSON.stringify(spec.args) === JSON.stringify(JSON.parse(RECORD).args) && JSON.stringify(spec.options) === JSON.stringify(JSON.parse(RECORD).options))

console.log('§2 how the command registry serves it')
{
  const served = await getCommandSpec('sleep')
  check('asking the registry for sleep answers this very record', served === spec, `got ${JSON.stringify(served)}; getCommandSpec in src/platform/shell/bash/commandSpecs.ts must find ${WHERE} by its name before it looks anywhere else`)
  check('and again on a second asking', (await getCommandSpec('sleep')) === spec)
}

if (failures > 0) {
  console.error(`\nprove-bash-spec-sleep-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-bash-spec-sleep-behaviour: all green')
