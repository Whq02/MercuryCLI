#!/usr/bin/env bun
// ============================================================================
//  scripts/winreg/dump-concourse-fixture.ts — materialize the §8.1 reference
//  Concourse snapshot (the ONE seed the macOS verify rigs drive) as a JSON
//  file for MERCURY_CONCOURSE_FIXTURE, so the hosted Windows campaign can
//  boot a POPULATED Concourse through the packaged kit. Same registered
//  fixture seam the render/
//  parity scenarios use; never a hand-authored snapshot.
//
//  Usage: bun run scripts/winreg/dump-concourse-fixture.ts <out.json>
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { writeFileSync } from 'node:fs'
import { referenceFixtureSnapshot } from '../notifications/concourseReferenceSeed.ts'

const out = process.argv[2]
if (!out) {
  console.error('dump-concourse-fixture: usage: bun run scripts/winreg/dump-concourse-fixture.ts <out.json>')
  process.exit(2)
}
writeFileSync(out, JSON.stringify(referenceFixtureSnapshot(), null, 1) + '\n')
console.log(`wrote ${out}`)
