#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, REPO } from './lib/harness.ts'

armEnvironment()
const { AstEditTool } = await import(join(REPO, 'src/tools/AstEditTool/AstEditTool.ts'))
const { AstSearchTool } = await import(join(REPO, 'src/tools/AstSearchTool/AstSearchTool.ts'))
const { pathInAllowedWorkingPath, checkWritePermissionForTool, describeWriteScope, allWorkingDirectories } = await import(join(REPO, 'src/utils/permissions/filesystem.ts'))
const { resetCwdIfOutsideProject } = await import(join(REPO, 'src/tools/BashTool/utils.ts'))
const { setCwd } = await import(join(REPO, 'src/utils/Shell.ts'))
const { getCwd } = await import(join(REPO, 'src/utils/cwd.ts'))
const { getEmptyToolPermissionContext } = await import(join(REPO, 'src/Tool.ts'))

const estate = realpathSync(mkdtempSync(join(tmpdir(), 'declared-scope-')))
const project = join(estate, 'project')
const sibling = join(estate, 'sibling-worktree')
const stranger = join(estate, 'stranger')
mkdirSync(join(project, 'src'), { recursive: true })
mkdirSync(join(sibling, 'src'), { recursive: true })
mkdirSync(join(stranger, 'src'), { recursive: true })
const SOURCE = 'export function normaliseRecord(record: { label: string }) {\n  return record.label.trim()\n}\nexport const total = normaliseRecord({ label: " a " })\n'
writeFileSync(join(project, 'src', 'records.ts'), SOURCE)
writeFileSync(join(sibling, 'src', 'records.ts'), SOURCE)
writeFileSync(join(stranger, 'src', 'records.ts'), SOURCE)
await enterRoot(project)
const tools = [AstSearchTool, AstEditTool]

const declaring = (dirs: string[]) => new Map(dirs.map(d => [d, { path: d, source: 'cliArg' as const }]))
const contextWith = (dirs: string[]): ReturnType<typeof getEmptyToolPermissionContext> => ({
  ...getEmptyToolPermissionContext(),
  additionalWorkingDirectories: declaring(dirs) as never,
})

section('§1 — the predicate every writer reads')
const bare = contextWith([])
const declared = contextWith([sibling])
check('the launch directory is inside the scope', pathInAllowedWorkingPath(join(project, 'src', 'records.ts'), bare))
check('an undeclared sibling is outside it', !pathInAllowedWorkingPath(join(sibling, 'src', 'records.ts'), bare))
check('a declared sibling is inside it', pathInAllowedWorkingPath(join(sibling, 'src', 'records.ts'), declared))
check('a declaration is exact: another sibling stays outside', !pathInAllowedWorkingPath(join(stranger, 'src', 'records.ts'), declared))
check('a traversal out of a declared directory is outside', !pathInAllowedWorkingPath(join(sibling, '..', 'stranger', 'src', 'records.ts'), declared))
check('the scope lists the launch directory and the declaration', [...allWorkingDirectories(declared)].join(',') === `${project},${sibling}`)
const words = describeWriteScope(declared)
check('the scope in words names both directories and both doors', words.includes(project) && words.includes('(the launch directory)') && words.includes(sibling) && words.includes('/add-dir <dir>') && words.includes('--add-dir <dir>'), words)

section('§2 — the structural editor: refused outside the declaration, applied inside it')
const PATTERN = 'normaliseRecord($$$ARGS)'
const REWRITE = 'normalizeRecord($$$ARGS)'
{
  const prover = await makeContext(tools, { allow: ['AstEdit'] })
  const dry = await drive(AstEditTool, { pattern: PATTERN, rewrite: REWRITE, path: sibling }, prover)
  const token = /plan: (ae-[0-9a-f]{12})/.exec(dry.text)?.[1] ?? ''
  check('a dry run over the undeclared sibling plans (reads are not the write scope)', !dry.isError && token !== '', dry.text.slice(0, 300))
  const before = readFileSync(join(sibling, 'src', 'records.ts'), 'utf8')
  const refused = await drive(AstEditTool, { pattern: PATTERN, rewrite: REWRITE, path: sibling, apply: true, plan: token }, prover)
  check('the apply into the undeclared sibling is refused', refused.isError && refused.text.includes("outside the session's write scope"), refused.text.slice(0, 400))
  check('…naming the file, the scope and both doors', refused.text.includes('src/records.ts') && refused.text.includes(`The session's write scope is ${project} (the launch directory)`) && refused.text.includes('/add-dir <dir>') && refused.text.includes('--add-dir <dir>'), refused.text.slice(0, 500))
  check('…and ZERO bytes changed', readFileSync(join(sibling, 'src', 'records.ts'), 'utf8') === before)
  check('the whole-tool allow needed no ask for the refusal', refused.asks.length === 0, JSON.stringify(refused.asks))

  const declaredProver = await makeContext(tools, { allow: ['AstEdit'] })
  ;(declaredProver.ctx.getAppState() as { toolPermissionContext: { additionalWorkingDirectories: unknown } }).toolPermissionContext.additionalWorkingDirectories = declaring([sibling])
  const dry2 = await drive(AstEditTool, { pattern: PATTERN, rewrite: REWRITE, path: sibling }, declaredProver)
  const token2 = /plan: (ae-[0-9a-f]{12})/.exec(dry2.text)?.[1] ?? ''
  const applied = await drive(AstEditTool, { pattern: PATTERN, rewrite: REWRITE, path: sibling, apply: true, plan: token2 }, declaredProver)
  check('the same apply into the DECLARED sibling lands', !applied.isError && applied.data?.state === 'applied', applied.text.slice(0, 300))
  check('…and the file carries the rewrite', readFileSync(join(sibling, 'src', 'records.ts'), 'utf8').includes('normalizeRecord({ label: " a " })'))
  check('the declaration is exact: the other sibling is still refused', (await (async () => {
    const d = await drive(AstEditTool, { pattern: PATTERN, rewrite: REWRITE, path: stranger }, declaredProver)
    const t = /plan: (ae-[0-9a-f]{12})/.exec(d.text)?.[1] ?? ''
    const a = await drive(AstEditTool, { pattern: PATTERN, rewrite: REWRITE, path: stranger, apply: true, plan: t }, declaredProver)
    return a.isError && a.text.includes("outside the session's write scope") && readFileSync(join(stranger, 'src', 'records.ts'), 'utf8') === SOURCE
  })()))

  const deniedProver = await makeContext(tools, { allow: ['AstEdit'], deny: [`Edit(/${join(sibling, 'src', 'records.ts')})`] })
  ;(deniedProver.ctx.getAppState() as { toolPermissionContext: { additionalWorkingDirectories: unknown } }).toolPermissionContext.additionalWorkingDirectories = declaring([sibling])
  const dry3 = await drive(AstEditTool, { pattern: REWRITE, rewrite: PATTERN, path: sibling }, deniedProver)
  const token3 = /plan: (ae-[0-9a-f]{12})/.exec(dry3.text)?.[1] ?? ''
  const beforeDeny = readFileSync(join(sibling, 'src', 'records.ts'), 'utf8')
  const denied = await drive(AstEditTool, { pattern: REWRITE, rewrite: PATTERN, path: sibling, apply: true, plan: token3 }, deniedProver)
  check('a deny rule inside a declared directory still refuses (a declaration never outranks a deny)', denied.isError && denied.text.includes('has been denied'), denied.text.slice(0, 300))
  check('…with zero writes', readFileSync(join(sibling, 'src', 'records.ts'), 'utf8') === beforeDeny)
}

section('§3 — a declaration widens the scope, never the consent')
{
  const shim = { name: 'Edit', getPath: (input: { file_path: string }) => input.file_path } as never
  const inside = checkWritePermissionForTool(shim, { file_path: join(sibling, 'src', 'records.ts') }, declared)
  check('a write into a declared directory is still an ask by default', inside.behavior === 'ask', inside.behavior)
  const outside = checkWritePermissionForTool(shim, { file_path: join(stranger, 'src', 'records.ts') }, declared)
  check('…as is a write outside it (the scope decides the backstop, the ladder decides the consent)', outside.behavior === 'ask', outside.behavior)
}

section("§4 — the shell's directory persists inside a declaration and resets outside")
{
  setCwd(sibling)
  const reset = resetCwdIfOutsideProject(bare as never)
  check('a move into an undeclared sibling is reset to the launch directory', reset === true && getCwd() === project, getCwd())
  setCwd(sibling)
  const kept = resetCwdIfOutsideProject(declared as never)
  check('a move into a declared sibling persists', kept === false && getCwd() === sibling, getCwd())
  setCwd(project)
}

section('§5 — the launch option and the changeset tool say the same thing')
{
  const main = readFileSync(join(REPO, 'src/main.tsx'), 'utf8')
  check("--add-dir says a directory joins the session's scope for reads, writes and the shell's directory", /--add-dir <directories\.\.\.>', "Additional working directories: each joins the session's scope for reads, writes and the shell's directory/.test(main))
  const changeset = readFileSync(join(REPO, 'src/tools/ChangeSetTool/ChangeSetTool.ts'), 'utf8')
  check('the changeset tool reads the same predicate and names the scope in its refusal', changeset.includes('return pathInAllowedWorkingPath(abs, permCtx)') && changeset.includes('describeWriteScope(permCtx)'))
}

finish('DECLARED-WRITE-SCOPE')
