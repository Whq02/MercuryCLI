#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const R = await import('../../src/services/workbench/returnState.ts')

t.section('§1 — the seam')
{
  R._resetReturnStateForTesting()
  t.check('empty at start', R.restoreReturnState('workbench') === null)
  R.captureReturnState('workbench', { rowKey: 'at:thread:x', drafts: { dispatch: 'run it' }, atMs: 1 })
  R.captureReturnState('workflows', { rowKey: 'wf_1', atMs: 2 })
  const a = R.restoreReturnState('workbench')
  const b = R.restoreReturnState('workbench')
  t.check('restore is an idempotent read', a !== null && a === b && a!.rowKey === 'at:thread:x')
  t.check('surfaces are independent', R.restoreReturnState('workflows')?.rowKey === 'wf_1')
  R.clearReturnState('workbench')
  t.check('clear consumes one surface only', R.restoreReturnState('workbench') === null && R.restoreReturnState('workflows') !== null)
  R._resetReturnStateForTesting()
}

t.section('§2 — the surface retired (the prompts panel has no deep-links)')
{
  const panel = readFileSync('src/components/prompts-panel/PromptsPanel.tsx', 'utf8')
  t.check('the prompts panel never touches the return-state seam', !panel.includes('returnState'))
  const { execSync } = await import('node:child_process')
  const consumers = execSync("grep -rl 'captureReturnState(' src --include='*.ts' --include='*.tsx' || true", { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter(f => f !== 'src/services/workbench/returnState.ts')
  t.check('no surface captures a return origin (the seam has no product consumer)', consumers.length === 0, consumers.join(', ') || 'none')
}

t.section('§3 — the retired verb is gone from the Action Graph')
{
  const ag = readFileSync('src/keybindings/actionGraph.ts', 'utf8')
  t.check("the Action Graph no longer names 'board:attach' (retired with the WORK panel)", !/['"]board:attach['"]/.test(ag))
  t.check("the prompts panel's own rows stand in its place", /['"]prompts:expand['"]/.test(ag) && /['"]prompts:send-saved['"]/.test(ag))
}

t.finish('prove-attach-return')
