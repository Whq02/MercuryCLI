import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'crew-clock-'))
process.env.MERCURY_CONFIG_DIR = home
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const React = (await import('react')).default
const { renderToAnsiString } = await import('../../src/utils/staticRender.tsx')
const { MessageMetaProvider, formatClock } = await import('../../src/components/messages/TranscriptNameplate.tsx')
const { UserTextMessage } = await import('../../src/components/messages/UserTextMessage.tsx')
const completed = '2026-10-13T12:00:00.000Z'
const delivered = '2026-10-13T12:00:27.000Z'
const paint = async (expanded: boolean): Promise<string> => renderToAnsiString(React.createElement(MessageMetaProvider, { message: { type: 'attachment', timestamp: delivered, attachment: { type: 'queued_command', commandMode: 'task-notification', sentAt: completed, deliveredAt: delivered } }, children: React.createElement(UserTextMessage, { addMargin: false, param: { type: 'text', text: '<task-notification><task-id>quick</task-id><status>completed</status><summary>Crewmate "quick work" completed</summary><result>Done.</result></task-notification>' }, verbose: expanded, notice: true, noticeSentAt: completed, noticeDeliveredAt: delivered }) }), 120)
let failed = 0
for (const expanded of [false, true]) {
  const frame = (await paint(expanded)).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  const row = frame.split('\n').find(line => line.includes('[Crewmate]')) ?? ''
  const ok = row.includes(formatClock(completed)!) && !row.includes(formatClock(delivered)!)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${expanded ? 'expanded' : 'folded'} crew notice carries its completion stamp: ${row.trim()}`)
  if (!ok) failed++
}
rmSync(home, { recursive: true, force: true })
console.log(`${failed === 0 ? 'PASS' : 'FAIL'} crew completion stamp`)
process.exit(failed === 0 ? 0 : 1)
