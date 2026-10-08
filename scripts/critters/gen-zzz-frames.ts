#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { registerGeneratedAsset, registerOnlyRequested } from '../lib/generated-assets-map.mjs'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env['MERCURY_CONFIG_DIR'] ??= mkdtempSync(join(tmpdir(), 'zzz-frames-'))

const HERE = resolve(import.meta.dir, '..', '..')
const ROW = {
  assets: 'scripts/critters/fixtures/zzz-frames.json',
  generator: 'bun scripts/critters/gen-zzz-frames.ts',
  check: 'bun scripts/critters/prove-critter-sleep.ts',
  sources: 'scripts/critters/gen-zzz-frames.ts scripts/critters/zzzFrames.ts src/utils/cockpit/critterData.ts',
}
if (registerOnlyRequested(ROW)) process.exit(0)
const rerecord = process.argv.includes('--rerecord')
const positional = process.argv.slice(2).filter(arg => arg !== '--rerecord')
const root = resolve(positional[0] ?? HERE)
const out = resolve(positional[1] ?? join(HERE, ROW.assets))
const { CRITTERS } = await import(`${root}/src/utils/cockpit/critterData.ts`)
const forms = new Set(CRITTERS.flatMap((def: { mini?: unknown; squareDock?: unknown; sleep: Record<string, unknown> }) => [
  ...(Array.isArray(def.mini) ? ['mini'] : []),
  ...(Array.isArray(def.squareDock) ? ['square'] : []),
  ...Object.keys(def.sleep),
]))
const existing = existsSync(out) && !rerecord
  ? JSON.parse(readFileSync(out, 'utf8')) as { frames: Array<{ form: string }> }
  : null
let fixture: Record<string, unknown> & { frames: Array<{ form: string }> }
if (existing !== null) {
  fixture = { ...existing, frames: existing.frames.filter(frame => forms.has(frame.form)) }
} else {
  const { composeZzzFrames } = await import('./zzzFrames.ts')
  const sha = execFileSync('git', ['-C', root, 'rev-parse', '--short=9', 'HEAD'], { encoding: 'utf8' }).trim()
  fixture = { base: sha, composedBy: 'scripts/critters/gen-zzz-frames.ts', frames: await composeZzzFrames(root) }
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(fixture, null, 1) + '\n')
if (out === resolve(HERE, ROW.assets)) registerGeneratedAsset(ROW)
console.log(`zzz-frames: ${fixture.frames.length} frame(s), ${existing === null ? 'recorded' : 'retained without recomposing'} → ${out}`)
