#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const REPO = join(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'small-critter-estate-')))
mkdirSync(join(SCRATCH, 'home'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_CONCOURSE_WORKER

const t = checker()
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')



t.section('§2 — the big critter is gone: no size setting, no hero art reader, one small sprite')
const schema = JSON.parse(read('scripts/settings/settings-schema.json')) as { properties?: Record<string, { properties?: Record<string, unknown> }> }
t.check('the generated settings schema carries neither sessionsBar nor critterSize', schema.properties !== undefined && !('sessionsBar' in (schema.properties['view']?.properties ?? {})) && !('critterSize' in schema.properties) && !('critterSize' in (schema.properties['view']?.properties ?? {})))
const cd = await import('../../src/screen/cockpit/critterData.ts')
for (const def of cd.CRITTERS) {
  const record = def as unknown as Record<string, unknown>
  t.check(`${def.name}: the record carries the dock grid and no square or compact-mark field`, Array.isArray(record['squareDock']) && record['square'] === undefined && record['markCompact'] === undefined)
  t.check(`${def.name}: the dock grid is six rows of eleven`, def.squareDock.length === 6 && def.squareDock.every(r => r.length === 11))
}
t.check('critterData exports no accessor for the deleted grids', !('squareArtFor' in cd) && !('markCompactArtFor' in cd) && !('SQUARE_ART_LINES' in cd) && !('FLAT_ART_LINES' in cd))

t.section('§3 — the command table: /critter stands, /view and /companion do not')
const { builtinCommands, builtInCommandNames } = await import('../../src/commands/catalogue/commands.ts')
const names = builtInCommandNames()
t.check('/view is no built-in command or alias', !names.has('view') && builtinCommands().every(c => !(c.aliases ?? []).includes('view')))
t.check('/critter is a built-in command', names.has('critter'))
t.check('/companion is no built-in command or alias', !names.has('companion'))
const critter = builtinCommands().find(c => c.name === 'critter')
t.check('/critter opens a surface (local-jsx) with no arguments', critter !== undefined && critter.type === 'local-jsx' && critter.argumentHint === undefined)


rmSync(SCRATCH, { recursive: true, force: true })
t.finish('prove-small-critter-estate')
