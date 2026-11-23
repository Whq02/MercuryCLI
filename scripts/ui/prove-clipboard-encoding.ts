#!/usr/bin/env bun
import { SET_CLIPBOARD_SCRIPT, windowsClipInput, windowsPowershellEnv, windowsPowershellInput } from '../../src/screen/renderer/termio/osc.js'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

console.log('── the Windows clipboard encoding law ──')

const SAMPLE = 'em—dash · box ─│╭╮ · accents éüñ · check ✓ · non-BMP \u{10348} · plain ascii\r\nسلام 🙏\n'
{
  const bytes = windowsPowershellInput(SAMPLE)
  check('the Set-Clipboard road is handed UTF-8 bytes with no byte-order mark', !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) && bytes.equals(Buffer.from(SAMPLE, 'utf8')), 'change windowsPowershellInput in src/screen/renderer/termio/osc.ts to return the text as plain UTF-8 bytes with no byte-order mark')
  check('the bytes decode to the text exactly, line ends and non-BMP included', bytes.toString('utf8') === SAMPLE, 'windowsPowershellInput in src/screen/renderer/termio/osc.ts must return bytes that decode back to the exact text')
  check('the script reads its stdin as raw bytes and decodes them as UTF-8 itself (no console code page)', SET_CLIPBOARD_SCRIPT.includes('[Console]::OpenStandardInput()') && SET_CLIPBOARD_SCRIPT.includes('[System.Text.Encoding]::UTF8.GetString(') && !SET_CLIPBOARD_SCRIPT.includes('InputEncoding'), 'change SET_CLIPBOARD_SCRIPT in src/screen/renderer/termio/osc.ts to read raw stdin bytes and decode them with UTF8.GetString, never through InputEncoding')
  check('the script sets the decoded string as it is (Set-Clipboard -Value)', /Set-Clipboard -Value \(\[System\.Text\.Encoding\]::UTF8\.GetString\(\$bytes\.ToArray\(\)\)\)$/.test(SET_CLIPBOARD_SCRIPT), 'SET_CLIPBOARD_SCRIPT in src/screen/renderer/termio/osc.ts must end with Set-Clipboard -Value of the UTF-8 decoded bytes')
  const env = windowsPowershellEnv({ PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules', Path: 'C:\\Windows' })
  check("Windows PowerShell does not inherit the session's PSModulePath (PowerShell 7's script modules, which a Restricted policy refuses)", Object.keys(env).length === 1 && 'PSModulePath' in env && env.PSModulePath === undefined, 'windowsPowershellEnv in src/screen/renderer/termio/osc.ts must return only a PSModulePath key set to undefined: ' + JSON.stringify(env))
  check('the override matches the spelling the environment carries', JSON.stringify(Object.keys(windowsPowershellEnv({ PSMODULEPATH: 'x' }))) === '["PSMODULEPATH"]' && Object.keys(windowsPowershellEnv({ Path: 'x' })).length === 0, 'windowsPowershellEnv in src/screen/renderer/termio/osc.ts must override PSModulePath under the same spelling the given environment uses, and nothing when there is none')
}
{
  const buf = windowsClipInput(SAMPLE)
  check('clip.exe is fed UTF-16LE with no byte-order mark', !(buf[0] === 0xff && buf[1] === 0xfe) && buf.length === SAMPLE.length * 2, 'windowsClipInput in src/screen/renderer/termio/osc.ts must return UTF-16LE with no byte-order mark')
  check('the payload round-trips exactly', buf.toString('utf16le') === SAMPLE, 'windowsClipInput in src/screen/renderer/termio/osc.ts must return UTF-16LE bytes that decode to the exact text')
  check('no UTF-8 bytes leak (an odd length would betray one)', buf.length % 2 === 0, 'windowsClipInput in src/screen/renderer/termio/osc.ts must not emit UTF-8 bytes, the length must be even')
  check('empty text is empty input', windowsClipInput('').length === 0, 'windowsClipInput in src/screen/renderer/termio/osc.ts must return an empty buffer for empty text')
}


console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ CLIPBOARD ENCODING PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
