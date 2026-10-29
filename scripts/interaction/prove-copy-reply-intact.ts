#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'copy-reply-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_CLIPBOARD_FILE
delete process.env.TMUX
delete process.env.STY
delete process.env.SSH_CONNECTION
delete process.env.TERM_PROGRAM

const { call, collectReplies, copyResultLine, COPY_WORDS, fencedCodeBlocks, lastFencedCodeBlock } = await import('../../src/commands/copy/copy.ts')
const { pbcopyLocaleEnv, SET_CLIPBOARD_SCRIPT, setClipboardWithReceipt, terminalDropsOsc52, windowsClipInput, windowsPowershellEnv, windowsPowershellInput } = await import('../../src/ink/termio/osc.ts')
const { execFileNoThrow } = await import('../../src/utils/execFileNoThrow.ts')
const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.ts')
const { findCommand, getCommands } = await import('../../src/commands.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

type Block = { type: 'text'; text: string } | { type: 'thinking'; thinking: string } | { type: 'tool_use'; id: string; name: string; input: unknown }
const assistant = (id: string, block: Block, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid: `${id}-${Math.random().toString(36).slice(2, 8)}`,
  timestamp: new Date().toISOString(),
  message: { id, role: 'assistant', type: 'message', content: [block], usage: {}, model: 'fixture', stop_reason: null, stop_sequence: null },
  ...extra,
})
const user = (text: string) => ({ type: 'user', uuid: `u-${Math.random().toString(36).slice(2, 8)}`, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } })

const ARABIC_REPLY = [
  'السلام عليكم ورحمة الله وبركاته 🙏',
  '',
  'بخصوص قطعة الأرض: التفاصيل كما طلبت، مع الأرقام بالدينار (JOD) وبالمتر المربع م².',
  '',
  'مع أطيب التحيات،\nوليد 🌿',
].join('\n')

const CODE_REPLY = 'Here is the fence:\n\n```ts\nconst x = "سلام"\nexport default x\n```\n\n    indented, not a fence\n\nand another:\n\n```sh\necho done 🙏\n```\n'

const transcript = [
  user('first'),
  assistant('msg_1', { type: 'thinking', thinking: 'never copied' }),
  assistant('msg_1', { type: 'text', text: 'older reply, first block' }),
  assistant('msg_1', { type: 'text', text: 'older reply, second block' }),
  user('second'),
  assistant('msg_2', { type: 'text', text: CODE_REPLY }),
  assistant('msg_2', { type: 'tool_use', id: 't1', name: 'Read', input: {} }),
  user('tool result'),
  assistant('msg_err', { type: 'text', text: 'API Error: refused' }, { isApiErrorMessage: true, error: 'authentication_failed' }),
  user('third'),
  assistant('msg_3', { type: 'thinking', thinking: 'still never copied' }),
  assistant('msg_3', { type: 'text', text: ARABIC_REPLY }),
] as never[]

section('§1 the replies are assembled from the per-block records, newest first, one API message each')
const replies = collectReplies(transcript)
check('the last reply is the Arabic text exactly (thinking records contribute nothing)', replies[0] === ARABIC_REPLY, JSON.stringify(replies[0]).slice(0, 120))
check('the reply before it is the code reply (its tool_use record contributes nothing)', replies[1] === CODE_REPLY, JSON.stringify(replies[1]).slice(0, 120))
check('two text blocks of one message join with a blank line, in document order', replies[2] === 'older reply, first block\n\nolder reply, second block', JSON.stringify(replies[2]))
check('an API error row is never a reply', replies.length === 3 && !replies.some(r => r.includes('API Error')), String(replies.length))
check('fenced blocks only: the indented block is not one', JSON.stringify(fencedCodeBlocks(CODE_REPLY)) === JSON.stringify(['const x = "سلام"\nexport default x', 'echo done 🙏']), JSON.stringify(fencedCodeBlocks(CODE_REPLY)))
check('/copy code takes the LAST fence of the newest reply that has one (the Arabic reply has none, the code reply does)', lastFencedCodeBlock(replies) === 'echo done 🙏', JSON.stringify(lastFencedCodeBlock(replies)))

section('§2 the result row (every sentence a proposal for the fold)')
const receiptOf = (settled: string[], noRoad: boolean) => ({ sequence: '', settled: settled as never, osc52Emitted: true, noRoad, confirmation: '' })
check('a settled route: copied · N characters, N counted in code points', copyResultLine(receiptOf(['pbcopy'], false), 'a🙏b') === 'copied · 3 characters', copyResultLine(receiptOf(['pbcopy'], false), 'a🙏b'))
check('OSC 52 only: the terminal road is named with what to do if nothing pastes', copyResultLine(receiptOf([], false), 'abc') === COPY_WORDS.copiedThroughTerminal(3) && COPY_WORDS.copiedThroughTerminal(3).startsWith('copied through the terminal · 3 characters'), copyResultLine(receiptOf([], false), 'abc'))
check('no road: the plain failure', copyResultLine(receiptOf([], true), 'abc') === COPY_WORDS.noRoad && COPY_WORDS.noRoad.startsWith('nothing copied'), copyResultLine(receiptOf([], true), 'abc'))

const runCopy = async (messages: unknown[], args: string): Promise<{ row: string | undefined; written: string }> => {
  let row: string | undefined
  let written = ''
  const realWrite = process.stdout.write.bind(process.stdout)
  ;(process.stdout as { write: unknown }).write = (chunk: string | Uint8Array): boolean => {
    written += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }
  try {
    const element = await call(result => { row = result }, { messages } as never, args)
    check(`/copy ${args || '(bare)'} paints no view (the row is the whole answer)`, element === null)
  } finally {
    ;(process.stdout as { write: unknown }).write = realWrite
  }
  return { row, written }
}

section('§3 the refusals name what is missing')
check('no reply yet', (await runCopy([user('hello')], '')).row === COPY_WORDS.noReply)
check('/copy 5 with 3 replies', (await runCopy(transcript, '5')).row === COPY_WORDS.onlyN(3))
check('/copy x is a usage line', (await runCopy(transcript, 'x')).row === COPY_WORDS.usage('x'))
check('/copy code with no fence anywhere', (await runCopy([user('q'), assistant('m', { type: 'text', text: 'no fence here' })], 'code')).row === COPY_WORDS.noCode)

section('§4 the OSC 52 road on a fixture terminal (an ssh session: no native tool is tried)')
{
  process.env.SSH_CONNECTION = '10.0.0.2 51000 10.0.0.1 22'
  process.env.TERM_PROGRAM = 'iTerm.app'
  const { row, written } = await runCopy(transcript, '')
  const expected = `\x1b]52;c;${Buffer.from(ARABIC_REPLY, 'utf8').toString('base64')}\x07`
  check('the OSC 52 sequence carries the reply base64, BEL-terminated', written === expected, JSON.stringify(written.slice(0, 40)))
  const decoded = Buffer.from(written.slice('\x1b]52;c;'.length, -1), 'base64').toString('utf8')
  check('decoding the sequence gives the reply byte-for-byte', decoded === ARABIC_REPLY)
  check('the row says the terminal was asked', row === COPY_WORDS.copiedThroughTerminal([...ARABIC_REPLY].length), String(row))
  process.env.TERM_PROGRAM = 'Apple_Terminal'
  check("Apple's Terminal is known to drop OSC 52", terminalDropsOsc52() === true)
  const dropped = await runCopy(transcript, '')
  check('with no native tool and a terminal that drops OSC 52, the row is the plain failure', dropped.row === COPY_WORDS.noRoad, String(dropped.row))
  delete process.env.SSH_CONNECTION
  delete process.env.TERM_PROGRAM
}

section('§5 the pbcopy locale law')
check('no locale in the child: LC_ALL is set to a UTF-8 locale', JSON.stringify(pbcopyLocaleEnv({})) === JSON.stringify({ LC_ALL: 'en_US.UTF-8' }))
check('LC_ALL=C (which outranks LANG) is overridden', pbcopyLocaleEnv({ LC_ALL: 'C', LANG: 'en_GB.UTF-8' }) !== undefined)
check('a UTF-8 LANG is kept as it is', pbcopyLocaleEnv({ LANG: 'en_GB.UTF-8' }) === undefined)
check('a UTF-8 LC_CTYPE is kept as it is', pbcopyLocaleEnv({ LC_CTYPE: 'UTF-8' }) === undefined)

section("§5c the Windows road's bytes from the Arabic reply: no byte-order mark, the first character first, every character and line end as the reply has them")
{
  const CRLF_REPLY = ARABIC_REPLY.replaceAll('\n', '\r\n')
  const powershell = windowsPowershellInput(ARABIC_REPLY)
  check('Set-Clipboard is handed the reply as UTF-8 with no byte-order mark (the first bytes are the first letter)', powershell.equals(Buffer.from(ARABIC_REPLY, 'utf8')) && !(powershell[0] === 0xef && powershell[1] === 0xbb && powershell[2] === 0xbf), powershell.subarray(0, 4).toString('hex'))
  check('the script decodes those bytes itself and sets the string as it is', SET_CLIPBOARD_SCRIPT.includes('[Console]::OpenStandardInput()') && SET_CLIPBOARD_SCRIPT.includes('UTF8.GetString(') && SET_CLIPBOARD_SCRIPT.includes('Set-Clipboard -Value (') && !SET_CLIPBOARD_SCRIPT.includes('InputEncoding'))
  check('a CRLF reply reaches Set-Clipboard with its CRLF ends; an LF reply with its LF ends', windowsPowershellInput(CRLF_REPLY).toString('utf8') === CRLF_REPLY && powershell.toString('utf8') === ARABIC_REPLY)
  const clip = windowsClipInput(ARABIC_REPLY)
  check('clip.exe is handed UTF-16LE with no byte-order mark: the first code unit is the first letter, not U+FEFF', clip.readUInt16LE(0) === ARABIC_REPLY.charCodeAt(0) && clip.readUInt16LE(0) !== 0xfeff, clip.subarray(0, 4).toString('hex'))
  check('the clip.exe bytes decode to the reply exactly (the emoji surrogate pairs and the line ends included)', clip.toString('utf16le') === ARABIC_REPLY && clip.length === ARABIC_REPLY.length * 2)
  check('a CRLF reply reaches clip.exe with its CRLF ends', windowsClipInput(CRLF_REPLY).toString('utf16le') === CRLF_REPLY)
}

if (process.platform === 'darwin') {
  const utf8 = { ...process.env, LC_ALL: 'en_US.UTF-8' }
  const pbpaste = (): Buffer => execFileSync('pbpaste', [], { env: utf8 })
  const held = pbpaste()
  const restore = (): void => {
    execFileSync('pbcopy', [], { env: utf8, input: held })
  }
  try {
    section('§5b the red baseline on this Mac: pbcopy with no locale turns Arabic and emoji into MacRoman mojibake')
    const kept = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE }
    delete process.env.LANG
    delete process.env.LC_ALL
    delete process.env.LC_CTYPE
    const probe = `${ARABIC_REPLY}\n${process.pid}`
    try {
      const raw = await execFileNoThrow('pbcopy', [], { useCwd: false, input: probe })
      const mangled = pbpaste().toString('utf8')
      check('pbcopy exits 0 either way (nothing on its own says the bytes were mangled)', raw.code === 0)
      check('without a UTF-8 locale the paste is NOT the text (the red the owner saw as ruined formatting)', mangled !== probe, mangled.slice(0, 60))
      const fixed = await execFileNoThrow('pbcopy', [], { useCwd: false, input: probe, env: pbcopyLocaleEnv() })
      check('with the override the paste is the text, byte for byte', fixed.code === 0 && pbpaste().equals(Buffer.from(probe, 'utf8')))
      const road = await setClipboardWithReceipt(probe)
      check('the product road (setClipboardWithReceipt) delivers it intact with no locale in the process', road.settled.includes('pbcopy') && pbpaste().equals(Buffer.from(probe, 'utf8')))
    } finally {
      for (const [name, value] of Object.entries(kept)) if (value !== undefined) process.env[name] = value
    }

    section('§6 the real clipboard on this Mac: /copy delivers the Arabic, emoji, three-paragraph reply byte-identical')
    const { row } = await runCopy(transcript, '')
    const pasted = pbpaste()
    check('pbpaste returns the reply bytes exactly', pasted.equals(Buffer.from(ARABIC_REPLY, 'utf8')), pasted.toString('utf8').slice(0, 80))
    check('the row is copied · N characters', row === COPY_WORDS.copied([...ARABIC_REPLY].length), String(row))
    const code = await runCopy(transcript, 'code')
    check('/copy code delivers the last fence byte-identical', pbpaste().equals(Buffer.from('echo done 🙏', 'utf8')) && code.row === COPY_WORDS.copied([...'echo done 🙏'].length), String(code.row))
    const second = await runCopy(transcript, '2')
    check('/copy 2 delivers the reply before the last', pbpaste().equals(Buffer.from(CODE_REPLY, 'utf8')) && second.row === COPY_WORDS.copied([...CODE_REPLY].length), String(second.row))
    const direct = await setClipboardWithReceipt(ARABIC_REPLY)
    check('the receipt settles on pbcopy with noRoad false', direct.settled.includes('pbcopy') && direct.noRoad === false, JSON.stringify(direct.settled))
  } finally {
    restore()
    check('the clipboard holds what it held before the proof', pbpaste().equals(held))
  }
} else if (process.platform === 'win32') {
  const env = { ...process.env, ...windowsPowershellEnv() }
  const powershell = (script: string, input?: Buffer): string => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env, ...(input === undefined ? {} : { input }) }).trim()
  const READ = '$text = Get-Clipboard -Raw; if ($null -eq $text) { $text = "" }; [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text))'
  const paste = (): string => Buffer.from(powershell(READ), 'base64').toString('utf8')
  const held = paste()
  const restore = (): void => {
    if (held === '') powershell('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()')
    else powershell(SET_CLIPBOARD_SCRIPT, windowsPowershellInput(held))
  }
  try {
    section('§6 the real clipboard on this Windows box: /copy delivers the Arabic, emoji, three-paragraph reply character for character, its first character first')
    const { row } = await runCopy(transcript, '')
    const pasted = paste()
    check('Get-Clipboard returns the reply exactly: no U+FEFF, every character and line end as the reply has them', pasted === ARABIC_REPLY, `first ${JSON.stringify(pasted.slice(0, 1))} · ${pasted.length} of ${ARABIC_REPLY.length} chars · ${JSON.stringify(pasted.slice(0, 60))}`)
    check('the row is copied · N characters', row === COPY_WORDS.copied([...ARABIC_REPLY].length), String(row))
    const code = await runCopy(transcript, 'code')
    check('/copy code delivers the last fence exactly', paste() === 'echo done 🙏' && code.row === COPY_WORDS.copied([...'echo done 🙏'].length), `${JSON.stringify(paste())} · ${String(code.row)}`)
    const direct = await setClipboardWithReceipt(ARABIC_REPLY)
    check('the receipt settles on powershell (Set-Clipboard) with noRoad false', direct.settled.includes('powershell') && direct.noRoad === false, JSON.stringify(direct.settled))
    const crlf = ARABIC_REPLY.replaceAll('\n', '\r\n')
    await setClipboardWithReceipt(crlf)
    check('a CRLF reply arrives with its CRLF ends, an LF reply with its LF ends', paste() === crlf, JSON.stringify(paste().slice(0, 60)))
  } finally {
    restore()
    check('the clipboard holds what it held before the proof', paste() === held)
  }
} else {
  console.log(`  (skip) the real clipboard sections run on macOS (pbcopy) and Windows (Set-Clipboard); this host is ${process.platform}`)
}

section('§7 the chord: ctrl+x y runs /copy; the same chord copies a focused message; the help lists it')
const globalRows = DEFAULT_BINDINGS.find(b => b.context === 'Global')?.bindings ?? {}
const actionRows = DEFAULT_BINDINGS.find(b => b.context === 'MessageActions')?.bindings ?? {}
check("Global 'ctrl+x y' → command:copy", globalRows['ctrl+x y'] === 'command:copy', String(globalRows['ctrl+x y']))
check('no other default binds ctrl+x y', DEFAULT_BINDINGS.every(b => b.context === 'Global' || b.context === 'MessageActions' || b.bindings['ctrl+x y'] === undefined))
check("MessageActions 'ctrl+x y' → messageActions:c (the focused message copies with the same chord)", actionRows['ctrl+x y'] === 'messageActions:c', String(actionRows['ctrl+x y']))
const commands = await getCommands(process.cwd())
check('command:copy resolves to the registered /copy', findCommand('copy', commands)?.name === 'copy')
const help = readFileSync(join(ROOT, 'src/components/HelpV2/ShortcutsTab.tsx'), 'utf8')
check('the help SHORTCUTS tab lists the chord beside the other ctrl+x rows', help.includes("{ action: 'command:copy', context: 'Global', fallback: 'ctrl+x y'"))
const descriptor = readFileSync(join(ROOT, 'src/commands/copy/index.ts'), 'utf8')
check('the /copy help line names the three forms', descriptor.includes('/copy 2') && descriptor.includes('/copy code'))

section('§8 the picker and its setting are gone')
check('src/commands/copy/copy.tsx no longer exists', !existsSync(join(ROOT, 'src/commands/copy/copy.tsx')))
for (const file of ['src/utils/config/schema.ts', 'src/components/Settings/Config.tsx', 'src/commands/copy/copy.ts']) {
  check(`${file} carries no copyFullResponse`, !readFileSync(join(ROOT, file), 'utf8').includes('copyFull' + 'Response'))
}
const sessionsDoc = readFileSync(join(ROOT, 'docs/SESSIONS.md'), 'utf8')
check('docs/SESSIONS.md documents /copy, /copy code and the chord', sessionsDoc.includes('`/copy code`') && sessionsDoc.includes('`ctrl+x y`'))

console.log(failures === 0 ? '\n✅ prove-copy-reply-intact GREEN' : `\n❌ prove-copy-reply-intact RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
