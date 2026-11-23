#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const { installedEditorExtensions, locateBridgeVsix, MERCURY_IDE_EXTENSION_ID, BRIDGE_VSIX_NAME } = await import(
  '../../src/commands/verbs/editorExtensionPackage.ts'
)

const scratch = mkdtempSync(join(tmpdir(), 'mercury-editor-package-'))
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
  }
})

t.section('§1 installedEditorExtensions — the editors\' own directories')
{
  const home = join(scratch, 'home')
  mkdirSync(join(home, '.vscode', 'extensions', `${MERCURY_IDE_EXTENSION_ID}-1.0.0`), { recursive: true })
  mkdirSync(join(home, '.vscode', 'extensions', `${MERCURY_IDE_EXTENSION_ID}-1.0.1`), { recursive: true })
  mkdirSync(join(home, '.vscode', 'extensions', 'other.extension-9.9.9'), { recursive: true })
  mkdirSync(join(home, '.cursor', 'extensions', `${MERCURY_IDE_EXTENSION_ID}-0.9.0`), { recursive: true })
  mkdirSync(join(home, '.windsurf', 'extensions'), { recursive: true })
  const found = installedEditorExtensions(home)
  t.check('two editors report the extension', found.length === 2, JSON.stringify(found))
  const vscode = found.find(f => f.editor === 'VS Code')
  t.check('VS Code reports its NEWEST installed version', vscode?.version === '1.0.1', JSON.stringify(vscode))
  t.check('the reported dir is the real extension directory', vscode?.dir === join(home, '.vscode', 'extensions', `${MERCURY_IDE_EXTENSION_ID}-1.0.1`))
  t.check('Cursor reports its version', found.find(f => f.editor === 'Cursor')?.version === '0.9.0')
  t.check('a decoy extension is not Mercury', !JSON.stringify(found).includes('other.extension'))
  t.check('an editor with an empty extensions dir reports nothing', !found.some(f => f.editor === 'Windsurf'))
  t.check('an absent home is an empty list, never a throw', installedEditorExtensions(join(scratch, 'nowhere')).length === 0)
}

t.section('§2 locateBridgeVsix — beside the bundle, else dist/, else null')
{
  const here = process.cwd()
  const empty = join(scratch, 'empty-cwd')
  mkdirSync(empty, { recursive: true })
  process.chdir(empty)
  try {
    t.check('no package anywhere ⇒ null', locateBridgeVsix() === null, String(locateBridgeVsix()))
  } finally {
    process.chdir(here)
  }
  const located = locateBridgeVsix()
  t.check(
    'from the repo root: null, or an existing dist/ package (a built checkout)',
    located === null || located.endsWith(join('dist', BRIDGE_VSIX_NAME)),
    String(located),
  )
}


t.finish('prove-editor-package')
