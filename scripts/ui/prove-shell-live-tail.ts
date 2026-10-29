#!/usr/bin/env bun

import { deepStrictEqual, strictEqual } from 'node:assert'
import stripAnsi from 'strip-ansi'
import { shellLiveTailBudget, shellLiveTailLines } from '../../src/components/shell/liveShellTail.ts'
import { normalizeMessages } from '../../src/utils/messages/normalize.ts'
import { createUserMessage } from '../../src/utils/messages/factories.ts'

strictEqual(shellLiveTailBudget(120, 40), 6)
strictEqual(shellLiveTailBudget(80, 24), 3)
strictEqual(shellLiveTailBudget(120, 16), 2)
strictEqual(shellLiveTailBudget(80, 10), 0)
deepStrictEqual(shellLiveTailLines('', 6), [])
deepStrictEqual(shellLiveTailLines('output\n', 0), [])
deepStrictEqual(shellLiveTailLines('CODE-1234\nopen https://example.invalid\n', 6), ['CODE-1234', 'open https://example.invalid'])
deepStrictEqual(shellLiveTailLines('a\r\nb\r\n', 6), ['a', 'b'])
deepStrictEqual(shellLiveTailLines(Array.from({ length: 400 }, (_, n) => `\r${n}%`).join(''), 6), ['399%'])
deepStrictEqual(shellLiveTailLines('long progress\r2%\r', 6), ['2%'])
deepStrictEqual(shellLiveTailLines('first\n\nlast\n', 3), ['first', '', 'last'])
deepStrictEqual(shellLiveTailLines(Array.from({ length: 12 }, (_, n) => `line-${n + 1}\n`).join(''), 3), ['line-10', 'line-11', 'line-12'])
const green = '\u001b[32m'
const reset = '\u001b[0m'
const coloured = shellLiveTailLines(`${green}old\rnew\nlast${reset}\n`, 1)
strictEqual(stripAnsi(coloured[0]!), 'last')
strictEqual(coloured[0]!.startsWith(green), true)
const controls = shellLiveTailLines('\u001b]2;bad-title\u0007\u001b[2J\u001b[Hsafe\u0007\u0008\u001bPdevice\u001b\\\u001b[?25l\n', 6)
deepStrictEqual(controls, ['safe'])
deepStrictEqual(shellLiveTailLines('界e\u0301\t字\u001b[', 6), ['界e\u0301\t字'])
const first = createUserMessage({ content: [{ type: 'text', text: 'paste' }, { type: 'text', text: '<bash-input>echo same</bash-input>' }] })
const second = createUserMessage({ content: '<bash-input>echo same</bash-input>' })
const normalized = normalizeMessages([first, second])
strictEqual(normalized[1]!.sourceUuid, first.uuid)
strictEqual(normalized[2]!.sourceUuid, second.uuid)
strictEqual(normalized[1]!.uuid === first.uuid, false)
strictEqual(normalized[2]!.sourceUuid === normalized[1]!.sourceUuid, false)
console.log('SHELL LIVE TAIL: row budgets, last lines, CR progress, colour, control stripping, blanks, Unicode, partial escape, and normalized input identity PASS')
