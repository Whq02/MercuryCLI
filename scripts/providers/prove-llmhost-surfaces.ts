import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from './lib/llmhostFixture.ts'

const f = await llmhostFixture()
try {
  const { builtinCommands, commandSeat, sessionSeatCommandTable } = await import(`${f.root}/src/commands/catalogue/commands.ts`)
  const { effectiveCatalogue } = await import(`${f.root}/src/commands/catalogue/effectiveCatalogue.ts`)
  const { COMMAND_DOMAINS } = await import(`${f.root}/src/screen/help/commandDomains.ts`)
  const commands = builtinCommands()
  const command = commands.find((row: any) => row.name === 'llmhost')
  assert.ok(command, 'the live command catalogue contains llmhost')
  assert.equal(commandSeat(command), 'screen')
  assert.equal(command.userPrivate, true)
  assert.ok(!sessionSeatCommandTable(commands).some((row: any) => row.name === 'llmhost'), 'src/commands/catalogue/commands.ts sessionSeatCommandTable must exclude screen-private llmhost command')
  const rows = effectiveCatalogue().filter((row: any) => row.name === 'llmhost')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].visibility, 'normal')
  assert.equal(rows[0].enabled, true)
  assert.ok(COMMAND_DOMAINS.find((row: any) => row.key === 'config').names.includes('llmhost'), 'src/screen/help/commandDomains.ts config domain missing llmhost')
  assert.ok(existsSync(join(f.root, 'docs/LLM-HOST.md')), 'docs/LLM-HOST.md user guide missing')
  const { generateSettingsJSONSchema } = await import(`${f.root}/src/platform/settings/schemaOutput.ts`)
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'scripts/settings/settings-schema.json'), 'utf8')), JSON.parse(generateSettingsJSONSchema()), 'the generated settings snapshot matches the live schema')
  const { surfaceCensus } = await import(`${f.root}/scripts/compositor/prove-surface-census.ts`)
  assert.ok(surfaceCensus(f.root).includes('`/llmhost`'), 'the surface census includes the new command')
  console.log('LLMHOST SURFACES GREEN — live catalogue, private command, help category, README, user guide, generated schema and surface row')
} finally { f.close() }
