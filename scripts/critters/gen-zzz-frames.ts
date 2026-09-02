#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env['MERCURY_CONFIG_DIR'] ??= mkdtempSync(join(tmpdir(), 'zzz-frames-'))

const HERE = resolve(import.meta.dir, '..', '..')
const root = resolve(process.argv[2] ?? HERE)
const out = resolve(process.argv[3] ?? join(HERE, 'scripts/critters/fixtures/zzz-frames.json'))

const { composeZzzFrames } = await import('./zzzFrames.ts')
const sha = execFileSync('git', ['-C', root, 'rev-parse', '--short=9', 'HEAD'], { encoding: 'utf8' }).trim()
const frames = await composeZzzFrames(root)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ base: sha, composedBy: 'scripts/critters/gen-zzz-frames.ts', frames }, null, 1) + '\n')
console.log(`zzz-frames: ${frames.length} frame(s) from ${root} @ ${sha} → ${out}`)
