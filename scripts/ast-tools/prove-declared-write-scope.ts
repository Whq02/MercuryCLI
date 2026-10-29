#!/usr/bin/env bun
// gate-watch: src/tools/AstEditTool/AstEditTool.ts src/tools/AstSearchTool/AstSearchTool.ts src/utils/permissions/filesystem.ts src/Tool.ts
// gate-watch: src/tools/ChangeSetTool/ChangeSetTool.ts src/services/changeTransaction/snapshotAnchor.ts
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, REPO } from './lib/harness.ts'

const environment = armEnvironment()
const { AstEditTool } = await import(join(REPO, 'src/tools/AstEditTool/AstEditTool.ts'))
const { AstSearchTool } = await import(join(REPO, 'src/tools/AstSearchTool/AstSearchTool.ts'))
const { ChangeSetTool } = await import(join(REPO, 'src/tools/ChangeSetTool/ChangeSetTool.ts'))
const { mintFileAnchor } = await import(join(REPO, 'src/services/changeTransaction/snapshotAnchor.ts'))
const { getEmptyToolPermissionContext } = await import(join(REPO, 'src/Tool.ts'))
const { allWorkingDirectories } = await import(join(REPO, 'src/utils/permissions/filesystem.ts'))
const estate = realpathSync(mkdtempSync(join(tmpdir(), 'starting-folder-structure-')))
const project = join(estate, 'project')
const sibling = join(estate, 'sibling')
mkdirSync(project)
mkdirSync(sibling)
const original = process.cwd()
await enterRoot(project)
const tools = [AstSearchTool, AstEditTool]
const SOURCE = 'export const result = normaliseRecord({ label: " a " })\n'
const PATTERN = 'normaliseRecord($$$ARGS)'
const REWRITE = 'normalizeRecord($$$ARGS)'
try {
  section('one starting folder, ordinary approval outside it')
  check('the automatic root is the starting folder alone', [...allWorkingDirectories(getEmptyToolPermissionContext())].join(',') === project)
  for (const mode of ['default', 'implement', 'sovereign']) {
    for (const [place, directory] of [['inside', project], ['outside', sibling]]) {
      const file = join(directory!, `${mode}.ts`)
      writeFileSync(file, SOURCE)
      const prover = await makeContext(tools, { mode })
      const dry = await drive(AstEditTool, { pattern: PATTERN, rewrite: REWRITE, path: file }, prover)
      const plan = /plan: (ae-[0-9a-f]{12})/.exec(dry.text)?.[1] ?? ''
      check(`${mode} ${place}: a dry run plans without writing`, !dry.isError && plan !== '' && readFileSync(file, 'utf8') === SOURCE, dry.text.slice(0, 180))
      const applied = await drive(AstEditTool, { pattern: PATTERN, rewrite: REWRITE, path: file, apply: true, plan }, prover)
      const asks = mode === 'default' || (mode === 'implement' && place === 'outside') ? 1 : 0
      check(`${mode} ${place}: ${asks} ordinary apply asks`, applied.asks.length === asks, JSON.stringify(applied.asks))
      check(`${mode} ${place}: the approved rewrite lands`, !applied.isError && applied.data?.state === 'applied' && readFileSync(file, 'utf8').includes('normalizeRecord('), applied.text.slice(0, 220))
    }
  }
  section('a multi-file change set follows the same approval, without a folder backstop')
  for (const mode of ['default', 'implement', 'sovereign']) {
    const inside = join(project, `set-${mode}.txt`)
    const outside = join(sibling, `set-${mode}.txt`)
    for (const file of [inside, outside]) writeFileSync(file, 'before\n')
    const prover = await makeContext([ChangeSetTool], { mode })
    for (const file of [inside, outside]) prover.readFileState.set(file, { content: 'before\n', timestamp: Date.now() + 60_000 })
    const changes = [inside, outside].map(file_path => ({ file_path, expected_anchor: mintFileAnchor('before\n'), hunks: [{ lines: '1', replace: 'after' }] }))
    const preview = await drive(ChangeSetTool, { op: 'preview', changes }, prover)
    check(`${mode}: an outside member can be previewed without declaring a directory`, !preview.isError && preview.data?.outcome === 'no-change' && /Prepared plan/.test(preview.text), preview.text.slice(0, 180))
    const applied = await drive(ChangeSetTool, { op: 'apply', changes }, prover)
    check(`${mode}: the set asks ${mode === 'sovereign' ? 'zero times' : 'once'} for its outside member`, applied.asks.length === (mode === 'sovereign' ? 0 : 1), JSON.stringify(applied.asks))
    check(`${mode}: approval applies the whole set`, !applied.isError && [inside, outside].every(file => readFileSync(file, 'utf8') === 'after\n'), applied.text.slice(0, 180))
  }
  const deniedFile = join(sibling, 'declined.ts')
  writeFileSync(deniedFile, SOURCE)
  const deniedProver = await makeContext(tools, { mode: 'implement' })
  const dry = await drive(AstEditTool, { pattern: PATTERN, rewrite: REWRITE, path: deniedFile }, deniedProver)
  const plan = /plan: (ae-[0-9a-f]{12})/.exec(dry.text)?.[1] ?? ''
  const denied = await drive(AstEditTool, { pattern: PATTERN, rewrite: REWRITE, path: deniedFile, apply: true, plan }, deniedProver, { answer: 'deny' })
  check('declining the outside ask leaves every byte untouched', denied.isError && denied.asks.length === 1 && readFileSync(deniedFile, 'utf8') === SOURCE, denied.text.slice(0, 160))
  const blocked = await makeContext(tools, { mode: 'sovereign', deny: [`Edit(/${deniedFile})`] })
  const refused = await drive(AstEditTool, { pattern: PATTERN, rewrite: REWRITE, path: deniedFile, apply: true, plan }, blocked)
  check('an explicit deny rule still wins in Sovereign', refused.isError && readFileSync(deniedFile, 'utf8') === SOURCE, refused.text.slice(0, 160))
} finally {
  process.chdir(original)
  rmSync(estate, { recursive: true, force: true })
  rmSync(environment.home, { recursive: true, force: true })
  rmSync(environment.engineDir, { recursive: true, force: true })
}
finish('STARTING-FOLDER-STRUCTURE')
