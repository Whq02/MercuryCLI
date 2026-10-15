#!/usr/bin/env bun

import { existsSync, readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const FORBIDDEN_PATHS = ['src/services/workbench/folio.ts']
const FORBIDDEN_PANEL_WORDS = ["id: 'glance'", 'assembleFolio', 'enqueue({']

t.section('§2 — the depth surface is absent; the evidence owners stay')
{
  const panel = readFileSync('src/components/prompts-panel/PromptsPanel.tsx', 'utf8')
  t.check(
    'the prompts panel carries no depth section, opener or rerun enqueue',
    FORBIDDEN_PANEL_WORDS.every(word => !panel.includes(word)),
  )
  const diffCmd = readFileSync('src/commands/diff/diff.tsx', 'utf8')
  t.check('/diff accepts the file argument', diffCmd.includes('initialPath={initialPath}'))
  t.check('the unused assembler does not exist', FORBIDDEN_PATHS.every(path => !existsSync(path)))
}

t.section('§3 — the real-binary depth journey has no surface')
{
  t.check('the prompts panel is the /workbench route', readFileSync('src/commands/workbench/workbench.tsx', 'utf8').includes('PromptsPanel'))
}

t.finish('prove-evidence-folios')
