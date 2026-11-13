#!/usr/bin/env bun
import { join } from 'node:path'
import { checker, guideBattery, openWorld } from './instructionWorld.ts'

const world = openWorld('format-copilot')
const { check, section, close } = checker()

try {
  guideBattery({ world, check, section, file: '.github/copilot-instructions.md', convention: 'copilot' })

  section('a copilot-instructions.md outside .github is an ordinary file')
  const stray = world.project({ 'docs/copilot-instructions.md': 'stray-needle\n', 'copilot-instructions.md': 'stray-needle\n' })
  const d1 = world.drive(stray, { classify: [join(stray, 'docs/copilot-instructions.md'), join(stray, 'copilot-instructions.md')] })
  check('nothing composes', d1.first === '', d1.first)
  check('neither classifies as an instruction file', d1.classified[join(stray, 'docs/copilot-instructions.md')] === false && d1.classified[join(stray, 'copilot-instructions.md')] === false)
} finally {
  world.close()
}
close('format-copilot')
