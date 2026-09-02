#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checker } from '../engine-durability/harness.ts'
import { runArtifactArena, grabScreens, requireDist } from '../streaming/artifactArena.ts'

const t = checker()
requireDist()

const EMIT = process.argv.includes('--emit-evidence')

const HELD_ROW = 'hold this row through the sweep'
const run = await runArtifactArena({
  turns: [{ kind: 'text', text: 'held.' }],
  sends: [`3000:${HELD_ROW}`, '3600:\\r', '6500:/workbench', '7200:\\r'],
  resizes: ['9500:120:40', '11000:80:30', '12500:120:40'],
  seconds: 15,
  cols: 140,
  rows: 40,
  keep: true,
})

const flat = (rows: string[]): string => rows.join('\n')

t.section('§1 — the prompts panel survives the full geometry sweep')
{
  const wide = grabScreens(run, 140, 40, [-1])
  void wide
  const at120 = grabScreens(run, 120, 40, [-1])[0]!
  const at80 = grabScreens(run, 80, 30, [-1])[0]!
  const text120 = flat(at120.rows)
  const text80 = flat(at80.rows)
  t.check('the panel is open at 120 after the sweep (the PROMPTS tab strip)', /PROMPTS/.test(text120), text120.slice(0, 80))
  t.check('the tab strip survives at 120 (SAVED PROMPTS)', /SAVED PROMPTS/.test(text120))
  t.check('the tab strip survives at 80 (narrow sheds columns, never tabs)', /PROMPTS/.test(text80))
}

t.section('§2 — selection identity holds (the row key, not the index)')
{
  const at120 = grabScreens(run, 120, 40, [-1])[0]!
  const selectedLine = at120.rows.find(r => r.includes('▸') && r.includes(HELD_ROW))
  t.check(
    'the selection pointer sits ON the sent prompt’s row after three geometry changes',
    selectedLine !== undefined,
    selectedLine ?? `no ▸-pointed row carrying '${HELD_ROW}' — ▸ rows: ${at120.rows.filter(r => r.includes('▸')).map(r => r.trim()).join(' | ') || 'none'}`,
  )
  const text = flat(at120.rows)
  t.check('the footer still teaches the panel verbs (esc close)', /esc close/.test(text))
  t.check('no blank frame settled (the two-phase capture law)', at120.rows.some(r => r.trim() !== ''))
}


t.finish('prove-resize-continuity')
