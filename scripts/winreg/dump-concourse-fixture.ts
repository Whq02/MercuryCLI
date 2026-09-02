#!/usr/bin/env bun

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
