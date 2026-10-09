#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-evidence-home-'))
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_EDIT_HUNKS
delete process.env.MERCURY_CHANGE_RECEIPTS
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

const { FileEditTool } = await import(join(SRC, 'tools/FileEditTool/FileEditTool.ts'))
const { getEmptyToolPermissionContext } = await import(join(SRC, 'Tool.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — edit evidence proof exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

const fixtures = mkdtempSync(join(tmpdir(), 'edit-evidence-fixture-'))
type Ctx = { readFileState: Map<string, unknown> }
function makeContext(): Ctx {
  return {
    readFileState: new Map<string, unknown>(),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as never as Ctx
}
function primeRead(ctx: Ctx, path: string): void {
  ctx.readFileState.set(path, { content: readFileSync(path, 'utf8'), timestamp: Date.now() + 60_000, offset: undefined, limit: undefined })
}
async function edit(input: Record<string, unknown>, ctx: Ctx): Promise<{ ok: true; evidence: string; data: Record<string, unknown> } | { ok: false; error: string }> {
  const validation = await (FileEditTool as { validateInput: Function }).validateInput(input, ctx)
  if (validation.result === false) return { ok: false, error: String(validation.message) }
  try {
    const result = await (FileEditTool as { call: Function }).call(input, ctx, null, { uuid: '00000000-0000-0000-0000-000000000003', message: { id: 'msg_fixture' } })
    return { ok: true, evidence: String(result.effect.evidence), data: result.data }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const file = join(fixtures, 'counts.txt')
writeFileSync(file, 'one\ntwo\nthree\nfour\nfive\n')
const ctx = makeContext()
primeRead(ctx, file)
const swap = await edit({ file_path: file, old_string: 'two\nthree\n', new_string: 'TWO\n' }, ctx)
check('the effect evidence counts the added and removed lines of the patch', swap.ok && /\+1\/-2 lines$/.test(swap.evidence), swap.ok ? swap.evidence : swap.error)
primeRead(ctx, file)
const grow = await edit({ file_path: file, old_string: 'five\n', new_string: 'five\nsix\nseven\n' }, ctx)
check('an insertion counts only the added lines', grow.ok && /\+2\/-0 lines$/.test(grow.evidence), grow.ok ? grow.evidence : grow.error)
primeRead(ctx, file)
const shrink = await edit({ file_path: file, old_string: 'six\nseven\n', new_string: '' }, ctx)
check('a deletion counts only the removed lines', shrink.ok && /\+0\/-2 lines$/.test(shrink.evidence), shrink.ok ? shrink.evidence : shrink.error)

const missing = await edit({ file_path: join(fixtures, 'absent.txt'), old_string: 'a', new_string: 'b' }, makeContext())
check('an edit of a file that is not there opens with the same words the Read tool uses', !missing.ok && missing.error.startsWith('There is no file at that path.'), missing.ok ? 'edited' : missing.error)

clearTimeout(guard)
console.log(failures ? `FAIL edit evidence counts: ${failures} failures` : 'PASS edit evidence counts')
process.exit(failures ? 1 : 0)
