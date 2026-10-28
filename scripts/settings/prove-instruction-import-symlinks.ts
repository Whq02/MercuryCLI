import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTally } from '../daemon/dupline-world.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'instruction-links-')))
const project = join(root, 'project')
const outside = join(root, 'outside')
mkdirSync(project)
mkdirSync(outside)
writeFileSync(join(outside, 'private.md'), 'EXTERNAL_SENTINEL\n')
writeFileSync(join(project, 'inside.md'), 'INTERNAL_SENTINEL\n')
symlinkSync(join(outside, 'private.md'), join(project, 'file-link.md'))
symlinkSync(outside, join(project, 'dir-link'), 'junction')
symlinkSync(join(project, 'dir-link'), join(project, 'chain-link'), 'junction')
symlinkSync(join(project, 'inside.md'), join(project, 'inside-link.md'))
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
const previous = process.cwd()
process.chdir(project)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { processInstructionFile } = await import('../../src/services/instructions/discovery.ts')
const tally = makeTally('prove-instruction-import-symlinks')
try {
  for (const target of [join(outside, 'private.md'), './file-link.md', './dir-link/private.md', './chain-link/private.md']) {
    writeFileSync(join(project, 'MERCURY.md'), `Project rules.\n@${target}\n@./inside.md\n`)
    const diagnostics: Array<{ kind: string; detail: string }> = []
    const entries = await processInstructionFile({ isExcluded: () => false } as never, join(project, 'MERCURY.md'), 'Project', new Set(), false, 0, undefined, diagnostics as never)
    const text = JSON.stringify(entries)
    tally.check(`${target}: external content is not composed`, !text.includes('EXTERNAL_SENTINEL'))
    tally.check(`${target}: existing external-import refusal`, diagnostics.some(row => row.kind === 'external-import-blocked' && row.detail === 'outside the instruction roots — composed only after operator approval'))
    tally.check('a legitimate in-project import still loads', text.includes('INTERNAL_SENTINEL'))
  }
  writeFileSync(join(project, 'MERCURY.md'), '@./inside-link.md\n')
  const inside = await processInstructionFile({ isExcluded: () => false } as never, join(project, 'MERCURY.md'), 'Project', new Set(), false)
  tally.check('in-project symlinks still load', JSON.stringify(inside).includes('INTERNAL_SENTINEL'))
  writeFileSync(join(project, 'MERCURY.md'), '@./file-link.md\n')
  const approved = await processInstructionFile({ isExcluded: () => false } as never, join(project, 'MERCURY.md'), 'Project', new Set(), true)
  tally.check('an explicit external-import grant still works', JSON.stringify(approved).includes('EXTERNAL_SENTINEL'))
} finally {
  process.chdir(previous)
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
