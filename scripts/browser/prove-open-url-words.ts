#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'browser-words-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
const { BrowserTool } = await import(join(ROOT, 'src/tools/BrowserTool/BrowserTool.ts'))

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const refusal = await BrowserTool.validateInput({ op: 'open', url: 'file:///tmp/site/index.html' } as never, {} as never)
check('a file:// open is refused', refusal.result === false, JSON.stringify(refusal))
const message = refusal.result === false ? refusal.message : ''
check('the refusal says to serve the folder first and names the Service tool or a loopback server', /serve the folder first \(the Service tool or a loopback server\)/.test(message), message)
check('the refusal says file:// is not supported', /file:\/\/ is not supported/.test(message), message)
const ok = await BrowserTool.validateInput({ op: 'open', url: 'http://127.0.0.1:3000/' } as never, {} as never)
check('an http url passes the url check', ok.result === true || (ok.result === false && !/requires an http/.test(ok.message)), JSON.stringify(ok))

console.log(failures === 0 ? 'PASS: the Browser open refusal says how to serve a folder' : `FAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
