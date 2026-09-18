#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { CONFIG_HOME, RUNTIME_CWD, scenario, cleanupScenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { projectSlug } from '../../src/utils/sessionStoragePortable.ts'
import { BOOT_ENV_VERSION } from '../../src/substrate/startupMenu.ts'

const VSHOT = join(import.meta.dir, 'vshot.py')

type Cell = { c: string }
type Grid = Cell[][]
type Mark = { label: string; atTick: number; grid: Grid }
const text = (g: Grid) => g.map(r => r.map(c => c.c || ' ').join('').replace(/\s+$/, '')).join('\n')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' NOTEPAD LEFTOVERS — an earlier build\'s home boots whole')
console.log('============================================================')

const cfg = scenario('resume-2turn', 120, 40) as Record<string, unknown> & { sends?: unknown[]; total?: number; out?: string }
const out = `/tmp/tabula-leftovers-grid-${process.pid}.json`
cfg.out = out
cfg.sends = [
  { atTick: 34, data: '/submodels\r', mark: 'cockpit' },
  { atTick: 50, data: '\u001b', mark: 'submodels' },
]
cfg.total = 64

const cwd = RUNTIME_CWD.normalize('NFC')
const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
const projectKey = createHash('sha256').update(cwd).digest('hex').slice(0, 16)
const seeded: Array<[string, string]> = []
const seed = (path: string, body: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
  seeded.push([path, body])
}

seed(
  join(process.env.MERCURY_TABULA_DIR!, slug, 'journal.jsonl'),
  [
    { t: '2026-07-08T09:00:00Z', op: 'add', id: 'aa11bb', text: 'ship the telemetry board', pri: 'now' },
    { t: '2026-07-08T09:01:00Z', op: 'add', id: 'bb22cc', text: 'benchmark the pooled gate' },
    { t: '2026-07-08T09:02:00Z', op: 'refine', id: 'aa11bb', refinedText: 'Ship the telemetry board with its proof paths', baseHash: 'x1' },
    { t: '2026-07-08T09:03:00Z', op: 'add', id: 'cc33dd', text: 'retire the old splash rows' },
    { t: '2026-07-08T09:04:00Z', op: 'done', id: 'cc33dd', done: true, via: 'minerva' },
  ]
    .map(e => JSON.stringify(e))
    .join('\n') + '\n',
)
seed(
  join(CONFIG_HOME, 'boot-env.json'),
  JSON.stringify({ version: BOOT_ENV_VERSION, savedAt: '2026-07-08T09:00:00Z', env: { MERCURY_TABULA_MINERVA: '1' } }, null, 2) + '\n',
)
{
  const configPath = join(CONFIG_HOME, '.mercury.json')
  const current = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>) : {}
  seed(
    configPath,
    JSON.stringify({ ...current, subModels: { minerva: 'claude-opus-5', effort: { minerva: 'xhigh' } } }, null, 2) + '\n',
  )
}
seed(
  join(CONFIG_HOME, 'saved-prompts', `${projectSlug(cwd)}.json`),
  JSON.stringify({
    _v: 1,
    drafts: [
      { id: 'sp1', text: 'write the release notes', refinedText: 'Write the release notes with proof paths.', refinedAt: '2026-07-08T09:05:00.000Z', createdAt: '2026-07-08T09:00:00.000Z', updatedAt: '2026-07-08T09:00:00.000Z' },
    ],
  }) + '\n',
)
seed(
  join(CONFIG_HOME, 'minerva-refined', `${projectSlug(cwd)}.json`),
  JSON.stringify({ _v: 1, entries: [{ id: 'r1', original: 'write the release notes', refined: 'Write the release notes with proof paths.', source: 'room', refinedAt: '2026-07-08T09:05:00.000Z' }] }) + '\n',
)
seed(
  join(process.env.MERCURY_CREW_DIR!, `conversations-${projectKey}.json`),
  JSON.stringify({
    _v: 1,
    conversations: {
      'cv-minerva-1': { id: 'cv-minerva-1', kind: 'minerva-refinement', title: 'refined draft', participants: [], lineage: [{ kind: 'parent', conversationId: 'main' }], events: [], createdAt: 1, updatedAt: 1 },
    },
    cursors: {},
  }) + '\n',
)
seed(
  join(process.env.MERCURY_CREW_DIR!, `minerva-staged-${projectKey}.json`),
  JSON.stringify({ _v: 1, drafts: [{ stagedId: 'sd1', state: 'staged', originalText: 'a', refinedText: 'A', conversationId: 'cv-minerva-1', provenance: { source: 'minerva-chat', refinedBy: 'minerva' }, createdAt: 1 }] }) + '\n',
)

const cfgPath = `/tmp/vshot-tabula-leftovers-${process.pid}.json`
writeFileSync(cfgPath, JSON.stringify(cfg))
const env: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: CONFIG_HOME,
  MERCURY_CHANNEL_ROOM: `tabula-leftovers-${process.pid}`,
}
const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf-8', timeout: vshotBudgetMs(90000), env })
check('the drive exits 0', res.status === 0, `status ${res.status}: ${(res.stdout ?? '').slice(-400)} ${(res.stderr ?? '').slice(-400)}`)
const undelivered = /UNDELIVERED-SENDS/.test(res.stdout ?? '')
check('every send was delivered', !undelivered, (res.stdout ?? '').split('\n').filter(l => l.includes('UNDELIVERED')).join(' '))

if (res.status === 0 && !undelivered) {
  const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Grid; marks: Mark[] }
  const cockpit = text(payload.marks.find(m => m.label === 'cockpit')?.grid ?? [])
  const submodels = text(payload.marks.find(m => m.label === 'submodels')?.grid ?? [])
  const final = text(payload.grid)
  check('the cockpit painted (a resumed session with the rail)', cockpit.replace(/\s/g, '').length >= 40 && /RECENT|NEXT/.test(cockpit), cockpit.slice(0, 400))
  check('the TABULA card counts the two open notes', /TABULA · 2/.test(cockpit), cockpit.split('\n').filter(l => /TABULA/.test(l)).join(' | '))
  check("the card shows the operator's wording, never the leftover refinement", /ship the telemetry/.test(cockpit) && !/proof paths/.test(cockpit), cockpit.split('\n').filter(l => /telemetry/.test(l)).join(' | '))
  check('nothing on the cockpit names the curator (its two product spellings)', !/MINERVA|Minerva/.test(cockpit), cockpit.split('\n').filter(l => /MINERVA|Minerva/.test(l)).join(' | '))
  check('the retired boot-env choice raised no error line', !/error|refused|crash/i.test(cockpit), cockpit.split('\n').filter(l => /error|refused|crash/i.test(l)).join(' | '))
  check('/submodels opened on the Console', /CONSOLE — side questions/.test(submodels), submodels.split('\n').slice(4, 10).join(' | '))
  check('…UNSET — the leftover minerva pick is never read', /CONSOLE — side questions · unset · no model pinned/.test(submodels), submodels.split('\n').filter(l => /CONSOLE/.test(l)).join(' | '))
  check('…and the picker names no other container', !/MINERVA|Minerva/.test(submodels))
  check('esc closes it back to the cockpit', /RECENT|NEXT/.test(final) && !/CONSOLE — side questions/.test(final))
  const configPath = join(CONFIG_HOME, '.mercury.json')
  const conversationsPath = join(process.env.MERCURY_CREW_DIR!, `conversations-${projectKey}.json`)
  for (const [path, body] of seeded) {
    if (path === configPath || path === conversationsPath) continue
    check(`leftover untouched after the boot: ${path.split('/').slice(-2).join('/')}`, existsSync(path) && readFileSync(path, 'utf8') === body)
  }
  const configAfter = JSON.parse(readFileSync(configPath, 'utf8')) as { subModels?: Record<string, unknown> }
  check(
    'the leftover container pick and effort survive this build\'s own config writes',
    configAfter.subModels?.minerva === 'claude-opus-5' && (configAfter.subModels?.effort as Record<string, unknown> | undefined)?.minerva === 'xhigh' && configAfter.subModels?.console === undefined,
    JSON.stringify(configAfter.subModels),
  )
  const conversationsAfter = JSON.parse(readFileSync(conversationsPath, 'utf8')) as { conversations?: Record<string, { kind?: string }> }
  check(
    'the leftover minerva-refinement conversation survives beside the conversation this build minted',
    conversationsAfter.conversations?.['cv-minerva-1']?.kind === 'minerva-refinement',
    JSON.stringify(Object.entries(conversationsAfter.conversations ?? {}).map(([id, c]) => [id, c.kind])),
  )
}
cleanupScenario('resume-2turn')

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ' ✅ NOTEPAD LEFTOVERS PASS' : ` ❌ NOTEPAD LEFTOVERS — ${failures} failure(s)`)
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
