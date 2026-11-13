#!/usr/bin/env bun
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { checker, contentsOf, count, guideBattery, openWorld, rulesBattery } from './instructionWorld.ts'

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

  rulesBattery({
    world,
    check,
    section,
    convention: 'agent-folders',
    folder: '.agents/rules',
    ext: '.md',
    always: body => `---\nalwaysApply: true\n---\n${body}`,
    scoped: (patterns, body) => `---\nglobs: ${patterns.join(', ')}\nalwaysApply: false\n---\n${body}`,
  })
  rulesBattery({
    world,
    check,
    section,
    convention: 'agent-folders',
    folder: '.agent/rules',
    ext: '.mdc',
    always: body => `---\ntrigger: always_on\n---\n${body}`,
    scoped: (patterns, body) => `---\ntrigger: glob\nglobs: ${patterns.join(',')}\n---\n${body}`,
  })

  section('a rule of a shared folder with no header, and one with only a description')
  const p3 = world.project({
    '.agents/AGENTS.md': 'folder-guide-needle\n',
    '.agents/rules/a-plain.md': 'plain-rule-needle\n',
    '.agents/rules/b-described.md': '---\ndescription: How releases are cut\n---\ndescribed-body-needle\n',
    '.agents/rules/c-manual.md': '---\ntrigger: manual\n---\nmanual-needle\n',
  })
  const d3 = world.drive(p3)
  const expected = [
    contentsOf(join(p3, '.agents/AGENTS.md'), 'folder-guide-needle'),
    contentsOf(join(p3, '.agents/rules/a-plain.md'), 'plain-rule-needle'),
    `Rule files offered by description (not loaded; Read one when its description fits the work):\n- ${join(p3, '.agents/rules/b-described.md')}: How releases are cut`,
  ].join('\n\n')
  check('the guide, the plain rule as general guidance, and one pointer for the described rule', d3.first === expected, d3.first)
  check('a manual rule is never sent', !d3.first.includes('manual-needle'))
} finally {
  world.close()
}
close('format-agent-folders')
