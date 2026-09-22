#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const home = mkdtempSync(join(tmpdir(), 'pdf-page-path-home-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pdf-page-path-cwd-')))
const pad = 'working-folder-'.repeat(20)
const longCwd = join(root, pad.slice(0, Math.max(1, 120 - root.length - 1)))
mkdirSync(longCwd, { recursive: true })
process.chdir(longCwd)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(longCwd)
const { pdfPageOutputDir, removePDFPages } = await import('../../src/utils/pdf.ts')

console.log('[1] the page directory sits at the temp root and never carries the working folder')
{
  const dir = pdfPageOutputDir()
  console.log(`  working folder: ${longCwd.length} chars · page directory: ${dir}`)
  check('the directory is a direct child of the temp root', dirname(dir) === tmpdir(), dir)
  check('its name is short and its own', /^mercury-pdf-[0-9a-f-]{36}$/.test(basename(dir)), basename(dir))
  check('the working folder is no part of it', !dir.includes(pad.slice(0, 20)) && !dir.includes(home), dir)
  const other = pdfPageOutputDir()
  check('every call mints a fresh directory', other !== dir)
}

console.log('[2] the page path spelled on Windows stays under the 260-character limit for a 120-character working folder')
{
  const windowsShaped = `C:\\Users\\operator\\AppData\\Local\\Temp\\${basename(pdfPageOutputDir())}\\page-001.jpg`
  console.log(`  ${windowsShaped.length} chars · ${windowsShaped}`)
  check('the page path the renderer receives is under the limit', windowsShaped.length < 260, `${windowsShaped.length} chars`)
  check('and it is independent of the working folder\'s length', windowsShaped.length < 120)
}

console.log('[3] a page directory is removed once its images are read')
{
  const dir = pdfPageOutputDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'page-001.jpg'), 'not really a jpeg')
  await removePDFPages(dir)
  check('the directory and its pages are gone', !existsSync(dir))
  let threw: string | null = null
  try {
    await removePDFPages(join(tmpdir(), 'mercury-pdf-never-made'))
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err)
  }
  check('removing a directory that is not there is quiet', threw === null, threw ?? '')
  const tool = readFileSync(join(ROOT, 'src/tools/FileReadTool/FileReadTool.ts'), 'utf8')
  check('the Read tool\'s page lane removes the directory after its images are read', /await removePDFPages\(outputDir\)/.test(tool))
  check('the Read tool\'s side-effect extraction removes its directory too', /if \(extraction\?\.success\) await removePDFPages\(extraction\.data\.file\.outputDir\)/.test(tool))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
