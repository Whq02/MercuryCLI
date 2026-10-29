#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SET_CLIPBOARD_SCRIPT, windowsClipInput, windowsPowershellEnv, windowsPowershellInput } from '../../src/ink/termio/osc.js'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

console.log('── the Windows clipboard encoding law ──')

const SAMPLE = 'em—dash · box ─│╭╮ · accents éüñ · check ✓ · non-BMP \u{10348} · plain ascii\r\nسلام 🙏\n'
{
  const bytes = windowsPowershellInput(SAMPLE)
  check('the Set-Clipboard road is handed UTF-8 bytes with no byte-order mark', !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) && bytes.equals(Buffer.from(SAMPLE, 'utf8')))
  check('the bytes decode to the text exactly, line ends and non-BMP included', bytes.toString('utf8') === SAMPLE)
  check('the script reads its stdin as raw bytes and decodes them as UTF-8 itself (no console code page)', SET_CLIPBOARD_SCRIPT.includes('[Console]::OpenStandardInput()') && SET_CLIPBOARD_SCRIPT.includes('[System.Text.Encoding]::UTF8.GetString(') && !SET_CLIPBOARD_SCRIPT.includes('InputEncoding'))
  check('the script sets the decoded string as it is (Set-Clipboard -Value)', /Set-Clipboard -Value \(\[System\.Text\.Encoding\]::UTF8\.GetString\(\$bytes\.ToArray\(\)\)\)$/.test(SET_CLIPBOARD_SCRIPT))
  const env = windowsPowershellEnv({ PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules', Path: 'C:\\Windows' })
  check("Windows PowerShell does not inherit the session's PSModulePath (PowerShell 7's script modules, which a Restricted policy refuses)", Object.keys(env).length === 1 && 'PSModulePath' in env && env.PSModulePath === undefined, JSON.stringify(env))
  check('the override matches the spelling the environment carries', JSON.stringify(Object.keys(windowsPowershellEnv({ PSMODULEPATH: 'x' }))) === '["PSMODULEPATH"]' && Object.keys(windowsPowershellEnv({ Path: 'x' })).length === 0)
}
{
  const buf = windowsClipInput(SAMPLE)
  check('clip.exe is fed UTF-16LE with no byte-order mark', !(buf[0] === 0xff && buf[1] === 0xfe) && buf.length === SAMPLE.length * 2)
  check('the payload round-trips exactly', buf.toString('utf16le') === SAMPLE)
  check('no UTF-8 bytes leak (an odd length would betray one)', buf.length % 2 === 0)
  check('empty text is empty input', windowsClipInput('').length === 0)
}

const oscSrc = readFileSync(join(ROOT, 'src', 'ink', 'termio', 'osc.ts'), 'utf8')
{
  const winBranch = /case 'win32': \{([\s\S]*?)\n {6}\}/.exec(oscSrc)?.[1] ?? ''
  check('the win32 copyNative branch exists', winBranch !== '')
  const powershellAt = winBranch.indexOf("execFileNoThrow('powershell'")
  const clipAt = winBranch.indexOf("execFileNoThrow('clip'")
  check('Set-Clipboard is the first road, clip.exe the second', powershellAt !== -1 && clipAt !== -1 && powershellAt < clipAt)
  check('the PowerShell child is fed windowsPowershellInput(text) with windowsPowershellEnv()', winBranch.includes('input: windowsPowershellInput(text)') && winBranch.includes('env: windowsPowershellEnv()'))
  check('clip is fed windowsClipInput(text), never the raw string', winBranch.includes('input: windowsClipInput(text)') && !winBranch.includes('input: text'))
  check('the settled route names are the receipt vocabulary', winBranch.includes("return 'powershell'") && winBranch.includes("'clip.exe' : null"))
  check('no byte-order mark is written anywhere in the module', !oscSrc.includes('0xff, 0xfe') && !oscSrc.includes('\\ufeff'))
}

check('OSC 52 payload is base64 of UTF-8', oscSrc.includes("Buffer.from(text, 'utf8').toString('base64')"))

const execSrc = readFileSync(join(ROOT, 'src', 'utils', 'execFileNoThrow.ts'), 'utf8')
check('execFileNoThrow accepts Buffer input (both option types)', (execSrc.match(/input\?: string \| Buffer/g) ?? []).length === 2)

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ CLIPBOARD ENCODING PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
