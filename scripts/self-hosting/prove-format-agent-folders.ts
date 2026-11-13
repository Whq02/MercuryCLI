#!/usr/bin/env bun
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { checker, count, guideBattery, openWorld } from './instructionWorld.ts'

const world = openWorld('format-agent-folders')
const { check, section, close } = checker()

try {
  guideBattery({ world, check, section, file: '.agents/AGENTS.md', convention: 'agent-folders' })
  guideBattery({ world, check, section, file: '.agent/AGENTS.md', convention: 'agent-folders' })

  section('both folder spellings beside the root AGENTS.md: every one loads, the root first, the singular before the plural')
  const all = world.project({ 'AGENTS.md': 'root-needle\n', '.agent/AGENTS.md': 'singular-needle\n', '.agents/AGENTS.md': 'plural-needle\n' })
  const d1 = world.drive(all)
  check('three files compose in a fixed order', JSON.stringify(d1.paths) === JSON.stringify([join(all, 'AGENTS.md'), join(all, '.agent/AGENTS.md'), join(all, '.agents/AGENTS.md')]), d1.paths.join(', '))
  check('the root AGENTS.md keeps its own convention and the folder files name theirs', d1.entries.map(e => e.convention).join(',') === 'agents-md,agent-folders,agent-folders', JSON.stringify(d1.entries))

  if (process.platform !== 'win32') {
    section('a folder guide that is a link to the root AGENTS.md composes its text once')
    const linked = world.project({ 'AGENTS.md': 'linked-needle\n' })
    mkdirSync(join(linked, '.agents'), { recursive: true })
    symlinkSync(join('..', 'AGENTS.md'), join(linked, '.agents/AGENTS.md'))
    const d2 = world.drive(linked)
    check('one copy composes', count(d2.first, 'linked-needle') === 1, d2.first)
  }
} finally {
  world.close()
}
close('format-agent-folders')
