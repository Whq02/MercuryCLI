import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from './lib/llmhostFixture.ts'

const f = await llmhostFixture()
try {
  const { builtinCommands, commandSeat, sessionSeatCommandTable } = await import(`${f.root}/src/commands.ts`)
  const { effectiveCatalogue } = await import(`${f.root}/src/commands/effectiveCatalogue.ts`)
  const { COMMAND_DOMAINS } = await import(`${f.root}/src/components/HelpV2/commandDomains.ts`)
  const commands = builtinCommands()
  const command = commands.find((row: any) => row.name === 'llmhost')
  assert.ok(command, 'the live command catalogue contains llmhost')
  assert.equal(commandSeat(command), 'screen')
  assert.equal(command.userPrivate, true)
  assert.ok(!sessionSeatCommandTable(commands).some((row: any) => row.name === 'llmhost'))
  const rows = effectiveCatalogue().filter((row: any) => row.name === 'llmhost')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].visibility, 'normal')
  assert.equal(rows[0].enabled, true)
  assert.ok(COMMAND_DOMAINS.find((row: any) => row.key === 'config').names.includes('llmhost'))
  const readme = readFileSync(join(f.root, 'README.md'), 'utf8')
  assert.ok(readme.split('\n').some(line => line.startsWith('| config & setup |') && line.includes('`/llmhost`')))
  assert.ok(readme.includes('[docs/LLM-HOST.md](docs/LLM-HOST.md)'))
  assert.ok(readFileSync(join(f.root, 'docs/README.md'), 'utf8').includes('[LLM-HOST.md](LLM-HOST.md)'))
  assert.ok(existsSync(join(f.root, 'docs/LLM-HOST.md')))
  const page = readFileSync(join(f.root, 'docs/LLM-HOST.md'), 'utf8')
  for (const fact of ['SSH tunnel', 'compat/llmhost/<model>', 'sessionAffinityHeader', 'contextWindow', 'Change the address', 'Remove the provider', 'whole-turn tokens/s']) assert.ok(page.includes(fact), `the user page explains ${fact}`)
  const { generateSettingsJSONSchema } = await import(`${f.root}/src/utils/settings/schemaOutput.ts`)
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'scripts/settings/settings-schema.json'), 'utf8')), JSON.parse(generateSettingsJSONSchema()), 'the generated settings snapshot matches the live schema')
  assert.ok(readFileSync(join(f.root, 'scripts/compositor/fixtures/surface-census.md'), 'utf8').includes('`/llmhost`'), 'the generated surface census includes the new command')
  assert.ok(!readFileSync(join(f.root, 'src/commands/localsetup/localsetup.tsx'), 'utf8').includes('llmhost'), 'localsetup has no llmhost door')
  console.log('LLMHOST SURFACES GREEN — live catalogue, private command, help category, README, user guide, generated schema and surface row')
} finally { f.close() }
