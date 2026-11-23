#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

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

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setOriginalCwd(longCwd)
const { pdfPageOutputDir, removePDFPages } = await import('../../src/tools/kit/pdf.ts')

console.log('[1] the page directory sits at the temp root and never carries the working folder')
{
  const dir = pdfPageOutputDir()
  console.log(`  working folder: ${longCwd.length} chars · page directory: ${dir}`)
  check('the directory is a direct child of the temp root', dirname(dir) === tmpdir(), `${dir} — pdfPageOutputDir in src/tools/kit/pdf.ts must join tmpdir() directly with the directory name, never the working folder`)
  check('its name is short and its own', /^mercury-pdf-[0-9a-f-]{36}$/.test(basename(dir)), `${basename(dir)} — pdfPageOutputDir in src/tools/kit/pdf.ts must name the directory mercury-pdf-<randomUUID()>`)
  check('the working folder is no part of it', !dir.includes(pad.slice(0, 20)) && !dir.includes(home), `${dir} — pdfPageOutputDir in src/tools/kit/pdf.ts must not build the path from the working folder or the config home`)
  const other = pdfPageOutputDir()
  check('every call mints a fresh directory', other !== dir, `two calls returned ${dir} — pdfPageOutputDir in src/tools/kit/pdf.ts must put a fresh randomUUID() in each name`)
}

console.log('[2] the page path spelled on Windows stays under the 260-character limit for a 120-character working folder')
{
  const windowsShaped = `C:\\Users\\operator\\AppData\\Local\\Temp\\${basename(pdfPageOutputDir())}\\page-001.jpg`
  console.log(`  ${windowsShaped.length} chars · ${windowsShaped}`)
  check('the page path the renderer receives is under the limit', windowsShaped.length < 260, `${windowsShaped.length} chars — shorten the directory name pdfPageOutputDir returns in src/tools/kit/pdf.ts`)
  check('and it is independent of the working folder\'s length', windowsShaped.length < 120, `${windowsShaped.length} chars — pdfPageOutputDir in src/tools/kit/pdf.ts must not depend on the working folder`)
}

console.log('[3] a page directory is removed once its images are read')
{
  const dir = pdfPageOutputDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'page-001.jpg'), 'not really a jpeg')
  await removePDFPages(dir)
  check('the directory and its pages are gone', !existsSync(dir), `${dir} still exists — removePDFPages in src/tools/kit/pdf.ts must remove the directory recursively`)
  let threw: string | null = null
  try {
    await removePDFPages(join(tmpdir(), 'mercury-pdf-never-made'))
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err)
  }
  check('removing a directory that is not there is quiet', threw === null, threw ?? '')
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
