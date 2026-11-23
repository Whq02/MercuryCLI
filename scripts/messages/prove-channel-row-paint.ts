#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'channel-row-home-'))
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const React = (await import('react')).default
const { renderToString } = await import(join(ROOT, 'src/screen/renderer/staticRender.tsx'))
const { UserTextMessage } = await import(join(ROOT, 'src/screen/messages/UserTextMessage.tsx'))
const { AppStateProvider } = await import(join(ROOT, 'src/screen/app-state/AppState.tsx'))
const { CHANNEL_ARROW } = await import(join(ROOT, 'src/screen/theme/rowGlyphs.ts'))

async function paint(text: string): Promise<string> {
  const row = React.createElement(UserTextMessage, { addMargin: false, param: { type: 'text', text }, verbose: false })
  const frame: string = await renderToString(React.createElement(AppStateProvider, { children: row }), 100)
  return frame.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(line => line.trimEnd()).filter(line => line !== '').join('\n')
}

console.log('a transcript row recorded with the channel tag still paints as a channel row')
const fromUser = await paint('<channel source="local" user="kim">\nship the panel fix once the gate is green\n</channel>')
check('a row that opens with the tag paints the arrow, the source, the user and the words on one line', fromUser === `${CHANNEL_ARROW} local · kim: ship the panel fix once the gate is green`, JSON.stringify(fromUser) + ' - UserTextMessage (src/screen/messages/UserTextMessage.tsx) must hand a row that starts with the channel tag to UserChannelMessage (src/screen/messages/UserChannelMessage.tsx)')
const fromServer = await paint('<channel source="ext:slack-channel:slack">\ndeploy window opens at 15:00 UTC\n</channel>')
check("a row from an extension's server names the server by its last part and no user", fromServer === `${CHANNEL_ARROW} slack: deploy window opens at 15:00 UTC`, JSON.stringify(fromServer) + ' - fix the source and user labels in UserChannelMessage (src/screen/messages/UserChannelMessage.tsx)')
const long = await paint(`<channel source="local">\n${'the gate is green and the panel fix ships today '.repeat(4)}\n</channel>`)
check('long words are cut to one line that ends with an ellipsis', long.split('\n').length === 1 && long.startsWith(`${CHANNEL_ARROW} local: the gate is green`) && long.endsWith('…') && long.length < 80, JSON.stringify(long) + ' - fix the one-line truncation in UserChannelMessage (src/screen/messages/UserChannelMessage.tsx)')
const quoted = await paint('Explain this literal markup: <channel source="local">example</channel>')
check("a prompt that quotes the tag mid-text stays the operator's row: no arrow, the markup shown as typed", !quoted.includes(CHANNEL_ARROW) && quoted.includes('<channel source="local">example</channel>'), JSON.stringify(quoted) + ' - UserTextMessage (src/screen/messages/UserTextMessage.tsx) must route to UserChannelMessage only when the text starts with the channel tag')

console.log(`\nprove-channel-row-paint: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
