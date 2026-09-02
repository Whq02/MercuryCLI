#!/usr/bin/env bun
// ============================================================================
//  scripts/extensions/prove-command-depth-named.ts — a command .md buried
//  below the one-folder namespace is a NAMED defect, never a silent
//  absence (FC-123). The commands walk loads top-level files and one
//  namespace folder; anything deeper vanished with the same command count
//  and the same contributions hash as if the file were not there —
//  extensions validate could not tell the two trees apart.
//
//  The namespace contract itself stands (one folder deep); what changes
//  is that the exclusion lands in the defects array validate reports,
//  and only when the deeper tree actually holds a .md — an empty folder
//  is not a finding.
//
//  Run: ~/.bun/bin/bun run scripts/extensions/prove-command-depth-named.ts
// ============================================================================
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const manifestMod = await import('../../src/extensions/manifest.ts')
const contributions = await import('../../src/extensions/load/contributions.ts')

const MANIFEST = {
  name: 'depthy',
  version: '1.0.0',
  description: 'depth fixture',
  contributes: { commands: ['commands'] },
}
const md = '---\ndescription: probe\n---\nbody\n'

const buildTree = (withBuried: boolean, withEmptyDeep: boolean): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'depthy-')))
  mkdirSync(join(root, 'commands', 'sub', 'deeper'), { recursive: true })
  writeFileSync(join(root, 'commands', 'top.md'), md)
  writeFileSync(join(root, 'commands', 'sub', 'mid.md'), md)
  if (withBuried) writeFileSync(join(root, 'commands', 'sub', 'deeper', 'buried.md'), md)
  if (withEmptyDeep) mkdirSync(join(root, 'commands', 'sub', 'hollow'), { recursive: true })
  return root
}

const parsed = manifestMod.parseManifestValue(MANIFEST)
if (!parsed.ok) {
  console.log(`  [FAIL] fixture manifest parses — ${parsed.errors.join('; ')}`)
  console.log('\nprove-command-depth-named: 1 FAILURE(S)')
  process.exit(1)
}
const probes = contributions.realProbes()

console.log('§1 the buried file is a NAMED defect')
{
  const root = buildTree(true, false)
  const res = contributions.resolveContributions(parsed.manifest, root, 'depthy@x', probes)
  const names = res.commands.map(c => c.name).sort()
  check(
    'the contract stands: top and one-deep load',
    names.join(',') === 'depthy:sub:mid,depthy:top',
    names.join(','),
  )
  check(
    'the exclusion is a defect naming the buried subtree and the one-folder contract',
    res.defects.some(d => d.includes('sub/deeper') && d.includes('one folder deep')),
    res.defects.join('; ') || '(no defects)',
  )
}

console.log('\n§2 without the buried file the trees are distinguishable (control)')
{
  const root = buildTree(false, false)
  const res = contributions.resolveContributions(parsed.manifest, root, 'depthy@x', probes)
  check('no depth defect when nothing is buried', !res.defects.some(d => d.includes('deeper')), res.defects.join('; '))
}

console.log('\n§3 an empty deep folder is not a finding')
{
  const root = buildTree(false, true)
  const res = contributions.resolveContributions(parsed.manifest, root, 'depthy@x', probes)
  check('an empty nested folder raises nothing', res.defects.length === 0, res.defects.join('; '))
}

console.log(failures === 0 ? '\nprove-command-depth-named: all green' : `\nprove-command-depth-named: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
