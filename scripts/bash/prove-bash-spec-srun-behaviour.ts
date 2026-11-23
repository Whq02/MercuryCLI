#!/usr/bin/env bun
import { getCommandSpec } from '../../src/platform/shell/bash/commandSpecs.ts'
import spec from '../../src/platform/shell/bash/specs/srun.ts'

const WHERE = 'the default export of src/platform/shell/bash/specs/srun.ts'
const RECORD = "{\"name\":\"srun\",\"description\":\"Run a command on SLURM cluster nodes\",\"options\":[{\"name\":[\"-n\",\"--ntasks\"],\"description\":\"Number of tasks to run\",\"args\":{\"name\":\"count\"}},{\"name\":[\"-N\",\"--nodes\"],\"description\":\"Number of nodes to allocate\",\"args\":{\"name\":\"count\"}}],\"args\":{\"name\":\"command\",\"isCommand\":true}}"
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('§1 the record')
check('it is the record of srun, member for member and in this order, its words exact', JSON.stringify(spec) === RECORD, `got ${JSON.stringify(spec)}, expected ${RECORD}; see ${WHERE}`)
check('two options that each take a count, tasks before nodes, and an argument that is itself a command', JSON.stringify(spec.args) === JSON.stringify(JSON.parse(RECORD).args) && JSON.stringify(spec.options) === JSON.stringify(JSON.parse(RECORD).options))

console.log('§2 how the command registry serves it')
{
  const served = await getCommandSpec('srun')
  check('asking the registry for srun answers this very record', served === spec, `got ${JSON.stringify(served)}; getCommandSpec in src/platform/shell/bash/commandSpecs.ts must find ${WHERE} by its name before it looks anywhere else`)
  check('and again on a second asking', (await getCommandSpec('srun')) === spec)
}

if (failures > 0) {
  console.error(`\nprove-bash-spec-srun-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-bash-spec-srun-behaviour: all green')
