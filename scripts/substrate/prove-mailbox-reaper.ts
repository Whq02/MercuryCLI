import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'mercury-reaper-'))
process.env.MERCURY_CONFIG_DIR = tmp

const {
  writeToMailbox,
  readMailbox,
  markMessagesAsRead,
  markSpecificMessageAsRead,
} = await import('../../src/utils/teammateMailbox.ts')

let failures = 0
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}`)
  if (!cond) failures++
}
const TEAM = 'reaper-team'

{
  for (let i = 0; i < 210; i++) {
    await writeToMailbox('worker', { from: 'lead', text: `old ${i}`, timestamp: `t${i}` }, TEAM)
  }
  await markMessagesAsRead('worker', TEAM)
  for (let i = 0; i < 40; i++) {
    await writeToMailbox('worker', { from: 'lead', text: `fresh ${i}`, timestamp: `f${i}` }, TEAM)
  }
  const box = await readMailbox('worker', TEAM)
  const unread = box.filter(m => !m.read)
  const read = box.filter(m => m.read)
  ok(unread.length === 40, `§1 all 40 unread survive compaction (got ${unread.length})`)
  ok(read.length <= 100, `§2 read history capped at 100 (got ${read.length})`)
  ok(
    read.length > 0 && read[read.length - 1]!.text === 'old 209',
    '§2 the NEWEST read messages are the ones kept',
  )
  ok(
    box.length <= 140,
    `§2 box bounded (got ${box.length}, was 250 pre-compaction)`,
  )
}

{
  await writeToMailbox('solo', { from: 'a', text: 'one', timestamp: 'ts1' }, TEAM)
  await writeToMailbox('solo', { from: 'a', text: 'two', timestamp: 'ts2' }, TEAM)
  await markSpecificMessageAsRead('solo', TEAM, { from: 'a', text: 'two', timestamp: 'ts2' })
  const box = await readMailbox('solo', TEAM)
  ok(
    box.find(m => m.text === 'two')?.read === true &&
      box.find(m => m.text === 'one')?.read === false,
    '§3 exactly the key-matched message is marked read',
  )
}

rmSync(tmp, { recursive: true, force: true })
if (failures > 0) {
  console.error(`prove-mailbox-reaper: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('prove-mailbox-reaper: ALL GREEN')
