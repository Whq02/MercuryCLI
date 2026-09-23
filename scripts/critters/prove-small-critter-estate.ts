#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
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

const srcFiles: string[] = []
for await (const p of new Bun.Glob('src/**/*.{ts,tsx}').scan(REPO)) srcFiles.push(p)
const bodies = new Map(srcFiles.map(p => [p, read(p)] as const))
const readersOf = (needle: RegExp): string[] => srcFiles.filter(p => needle.test(bodies.get(p)!))

t.section('§1 — the speech feature has no module, no hook, no flag and no command under src')
t.check('no module under src carries companion in its name', srcFiles.every(p => !/companion/i.test(p)), srcFiles.filter(p => /companion/i.test(p)).join(', '))
t.check('no src file names the speech seam or its hook', readersOf(/companionSignals|useCompanion|CompanionTurn|companionEngine|deckCompanion/).length === 0, readersOf(/companionSignals|useCompanion|CompanionTurn|companionEngine|deckCompanion/).join(', '))
t.check('no command folder is named companion', !existsSync(join(REPO, 'src/commands/companion')))
t.check('the turn-signal seam is the sleep reader\'s one source, named for what it carries', existsSync(join(REPO, 'src/utils/cockpit/turnSignals.ts')) && read('src/utils/cockpit/critterSleep.ts').includes("from './turnSignals.js'") && read('src/screens/REPL.tsx').includes("from '../utils/cockpit/turnSignals.js'"))

t.section('§2 — the big critter is gone: no size setting, no hero art reader, one small sprite')
t.check('no src file reads critterSize or HERO_ART', readersOf(/critterSize|HERO_ART/).length === 0, readersOf(/critterSize|HERO_ART/).join(', '))
const types = read('src/utils/settings/types.ts')
t.check('the settings schema declares sessionsBar and no critterSize', types.includes('sessionsBar: z.boolean()') && !types.includes('critterSize'))
const schema = JSON.parse(read('scripts/settings/settings-schema.json')) as { properties?: Record<string, unknown> }
t.check('the generated settings schema carries sessionsBar and no critterSize', schema.properties !== undefined && 'sessionsBar' in schema.properties && !('critterSize' in schema.properties))
const cd = await import('../../src/utils/cockpit/critterData.ts')
for (const def of cd.CRITTERS) {
  const record = def as unknown as Record<string, unknown>
  t.check(`${def.name}: the record carries the dock grid and no square or compact-mark field`, Array.isArray(record['squareDock']) && record['square'] === undefined && record['markCompact'] === undefined)
  t.check(`${def.name}: the dock grid is six rows of eleven`, def.squareDock.length === 6 && def.squareDock.every(r => r.length === 11))
}
t.check('critterData exports no accessor for the deleted grids', !('squareArtFor' in cd) && !('markCompactArtFor' in cd) && !('SQUARE_ART_LINES' in cd) && !('FLAT_ART_LINES' in cd))
t.check('the two painters read the dock grid as the square form\'s base', read('src/components/mercury-ui/CritterArt.tsx').includes('pose ? pose.art : def.squareDock') && read('src/components/mercury-ui/AnimatedCritterArt.tsx').includes('const gazeGrid = usingSquare ? def.squareDock : null'))
t.check('no mount binds another grid over the def\'s square field', readersOf(/square:\s*squareDockArtFor|square:\s*squareArtFor/).length === 0, readersOf(/square:\s*squareDockArtFor|square:\s*squareArtFor/).join(', '))

t.section('§3 — the command table: /view and /critter stand, /companion does not')
const { builtinCommands, builtInCommandNames } = await import('../../src/commands.ts')
const names = builtInCommandNames()
t.check('/view is a built-in command', names.has('view'))
t.check('/critter is a built-in command', names.has('critter'))
t.check('/companion is no built-in command or alias', !names.has('companion'))
const view = builtinCommands().find(c => c.name === 'view')
t.check('/view takes on|off and sits at the screen seat', view !== undefined && view.type === 'local' && view.argumentHint === '[on|off]' && (view as { seat?: string }).seat === 'screen', JSON.stringify(view && { type: view.type, hint: view.argumentHint }))
const critter = builtinCommands().find(c => c.name === 'critter')
t.check('/critter opens a surface (local-jsx) with no arguments', critter !== undefined && critter.type === 'local-jsx' && critter.argumentHint === undefined)

t.section('§4 — the SESSIONS bar has one switch, read by the tabs and the title\'s click')
const bar = read('src/utils/cockpit/sessionsBar.ts')
t.check('the bar owner exposes isSessionsBarOn, setSessionsBar and subscribeSessionsBar', bar.includes('export function isSessionsBarOn') && bar.includes('export function setSessionsBar') && bar.includes('export function subscribeSessionsBar'))
t.check('the VIEW title\'s click toggles the same switch', /setSessionsBar\(!isSessionsBarOn\(\)\)/.test(read('src/components/HelmCenterHeader.tsx')))
t.check('the command writes the same switch', /setSessionsBar\(/.test(read('src/commands/view/view.ts')))
t.check('the tabs read the switch and no size setting', /useSessionsBar\(\)/.test(read('src/components/mercury-ui/SessionTabs.tsx')) && !/critterSize/.test(read('src/components/mercury-ui/SessionTabs.tsx')))

rmSync(SCRATCH, { recursive: true, force: true })
t.finish('prove-small-critter-estate')
