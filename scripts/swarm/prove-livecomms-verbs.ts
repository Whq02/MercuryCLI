#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const TMP = mkdtempSync(join(tmpdir(), 'mercury-livecomms-verbs-'))
process.env.MERCURY_CONFIG_DIR = TMP
process.env.MERCURY_CREWS_DIR = join(TMP, 'crews')
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const store = (await import('../../src/services/crew/liveComms.ts')) as Record<string, unknown>
const verb = <T>(name: string): T => store[name] as T
type Row = { id: string; seq: number; to: string; from: string; text: string; timestamp: string; read?: boolean; delivery?: { id: string; sessionId: string } }
const CREW = 'verbs-crew'
const now = (): string => new Date().toISOString()

console.log('============================================================')
console.log(' LiveComms speaks every message verb itself; the mailbox wrapper is gone')
console.log('============================================================')

section('§1 the wrapper and its mailbox names are gone from the product')
check('src/utils/crewmateMailbox.ts no longer exists (RED on the base: it does)', !existsSync(join(ROOT, 'src/utils/crewmateMailbox.ts')))
function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}
const MAILBOX_VERBS = /\b(writeToMailbox|readMailbox|readUnreadMessages|getMailboxStore|prepareMailboxDelivery|acknowledgeMailboxDelivery|wasMailboxDeliveryHandled|markMessagesAsRead|markMessagesFromAsRead|markSpecificMessageAsRead|markMessagesAsReadByPredicate|sendShutdownRequestToMailbox|getInboxPath|clearMailbox)\b/
const callers = walk(join(ROOT, 'src')).filter(path => MAILBOX_VERBS.test(readFileSync(path, 'utf8'))).map(path => path.slice(ROOT.length + 1))
check('no product file calls a mailbox-named verb (RED on the base: the callers of the wrapper)', callers.length === 0, callers.join(', '))
const importers = walk(join(ROOT, 'src')).filter(path => /crewmateMailbox\.js/.test(readFileSync(path, 'utf8'))).map(path => path.slice(ROOT.length + 1))
check('no product file imports the wrapper', importers.length === 0, importers.join(', '))

section('§2 the store\'s verbs carry the wrapper\'s laws under crew names')
const names = ['sendLiveMessage', 'liveMessagesFor', 'unreadLiveMessagesFor', 'subscribeLiveMessagesFor', 'prepareLiveDelivery', 'wasLiveDeliveryHandled', 'acknowledgeLiveDelivery', 'markLiveMessagesRead', 'markLiveMessagesFromRead', 'markLiveMessageRead', 'markLiveMessagesReadWhere']
const missing = names.filter(name => typeof store[name] !== 'function')
check('every message verb is a function of the store (RED on the base: the store has post/read/mutate only)', missing.length === 0, `missing: ${missing.join(', ')}`)
if (missing.length === 0) {
  const send = verb<(crew: string | undefined, m: { to: string; from: string; text: string; timestamp: string; color?: string; summary?: string }) => Promise<boolean>>('sendLiveMessage')
  const unread = verb<(crew: string | undefined, name: string) => Promise<Row[]>>('unreadLiveMessagesFor')
  const all = verb<(crew: string, name: string) => Promise<Row[]>>('liveMessagesFor')
  const prepare = verb<(crew: string | undefined, name: string, sessionId: string) => Promise<{ id: string; sessionId: string; recovered: boolean; messages: Row[] } | null>>('prepareLiveDelivery')
  const handled = verb<(delivery: { id: string; sessionId: string; recovered: boolean; messages: Row[] }, messages: unknown[]) => Promise<boolean>>('wasLiveDeliveryHandled')
  const acknowledge = verb<(crew: string | undefined, name: string, id: string) => Promise<void>>('acknowledgeLiveDelivery')
  const markAll = verb<(crew: string | undefined, name: string) => Promise<void>>('markLiveMessagesRead')
  const markFrom = verb<(crew: string | undefined, name: string, from: string) => Promise<void>>('markLiveMessagesFromRead')
  const markOne = verb<(crew: string | undefined, name: string, msg: { from: string; text: string; timestamp: string; id?: string }) => Promise<void>>('markLiveMessageRead')
  const markWhere = verb<(crew: string | undefined, name: string, predicate: (m: Row) => boolean) => Promise<void>>('markLiveMessagesReadWhere')
  const subscribe = verb<(crew: string | undefined, name: string, listener: (rows: Row[]) => void, opts?: { immediate?: boolean }) => () => void>('subscribeLiveMessagesFor')

  check('sendLiveMessage answers true on delivery', await send(CREW, { to: 'bob', from: 'alice', text: 'one', timestamp: now(), summary: 'first' }))
  await send(CREW, { to: 'bob', from: 'carol', text: 'two', timestamp: now() })
  await send(CREW, { to: 'alice', from: 'bob', text: 'for alice', timestamp: now() })
  const bobUnread = await unread(CREW, 'bob')
  check('unreadLiveMessagesFor answers the recipient\'s unread rows only, with ids and sequence', bobUnread.length === 2 && bobUnread.every(m => m.to === 'bob' && m.read === false && typeof m.id === 'string' && typeof m.seq === 'number'), JSON.stringify(bobUnread))
  await markOne(CREW, 'bob', { from: 'alice', text: 'one', timestamp: bobUnread[0]!.timestamp, id: bobUnread[0]!.id })
  check('markLiveMessageRead marks exactly the one row', (await unread(CREW, 'bob')).map(m => m.text).join(',') === 'two')
  await send(CREW, { to: 'bob', from: 'carol', text: 'three', timestamp: now() })
  await markFrom(CREW, 'bob', 'carol')
  check('markLiveMessagesFromRead marks one sender\'s rows and no other', (await unread(CREW, 'bob')).length === 0 && (await unread(CREW, 'alice')).length === 1)
  await send(CREW, { to: 'bob', from: 'alice', text: 'four', timestamp: now() })
  await send(CREW, { to: 'bob', from: 'alice', text: 'five', timestamp: now() })
  await markWhere(CREW, 'bob', m => m.text === 'four')
  check('markLiveMessagesReadWhere marks the rows the predicate names and leaves the rest unread', (await unread(CREW, 'bob')).map(m => m.text).join(',') === 'five')
  await markAll(CREW, 'bob')
  check('markLiveMessagesRead marks everything of that name', (await unread(CREW, 'bob')).length === 0 && (await unread(CREW, 'alice')).length === 1)

  const sid = randomUUID()
  const delivery = await prepare(CREW, 'alice', sid)
  check('prepareLiveDelivery stamps one delivery over the unread rows', delivery !== null && delivery.recovered === false && delivery.messages.length === 1 && delivery.sessionId === sid, JSON.stringify(delivery))
  const again = await prepare(CREW, 'alice', sid)
  check('a second prepare recovers the same delivery, never a fresh one', again !== null && delivery !== null && again.id === delivery.id && again.recovered === true)
  check('an unrecorded delivery is not handled', again !== null && !(await handled(again, [])))
  await acknowledge(CREW, 'alice', delivery!.id)
  check('acknowledgeLiveDelivery marks the delivered rows read', (await unread(CREW, 'alice')).length === 0 && (await prepare(CREW, 'alice', sid)) === null)

  let fired: Row[][] = []
  const stop = subscribe(CREW, 'dave', rows => { fired.push(rows) }, { immediate: false })
  await send(CREW, { to: 'erin', from: 'bob', text: 'not for dave', timestamp: now() })
  await new Promise(r => setTimeout(r, 150))
  const beforeOwn = fired.length
  await send(CREW, { to: 'dave', from: 'bob', text: 'for dave', timestamp: now() })
  await new Promise(r => setTimeout(r, 150))
  stop()
  check('subscribeLiveMessagesFor fires for that name\'s rows and not for another name\'s', beforeOwn === 0 && fired.length >= 1 && fired.at(-1)!.every(m => m.to === 'dave') && fired.at(-1)!.some(m => m.text === 'for dave'), `${beforeOwn} then ${fired.length}: ${JSON.stringify(fired.at(-1)?.map(m => m.to))}`)
  check('the rows the store holds are the same records, addressed by name', (await all(CREW, 'dave')).length === 1 && (await all(CREW, 'erin')).length === 1)
}

section('§3 the file poller is gone: it was mounted nowhere, and the store\'s subscription is the one reader road')
check('src/hooks/useInboxPoller.ts no longer exists (RED on the base: it does)', !existsSync(join(ROOT, 'src/hooks/useInboxPoller.ts')))
const pollerNamers = walk(join(ROOT, 'src')).filter(path => /useInboxPoller/.test(readFileSync(path, 'utf8'))).map(path => path.slice(ROOT.length + 1))
check('no product file names the poller', pollerNamers.length === 0, pollerNamers.join(', '))
const subscribers = walk(join(ROOT, 'src')).filter(path => /subscribeLiveMessagesFor\(/.test(readFileSync(path, 'utf8')) && !path.endsWith(join('crew', 'liveComms.ts'))).map(path => path.slice(ROOT.length + 1)).sort()
check('the lead wake, the seat drain, the in-process runner and the crew board subscribe to the store (RED on the base: no such verb)', ['src/cli/print.ts', 'src/daemon/dispatchDrain.ts', 'src/utils/crew/crewClient.ts', 'src/utils/swarm/inProcessRunner.ts'].every(path => subscribers.includes(path)), subscribers.join(', '))

section('§4 nothing wrote an inbox file')
const crews = join(TMP, 'crews')
const inboxFiles = existsSync(crews) ? walk(crews).filter(p => p.includes('inboxes')) : []
check('no inboxes/ file under the crews home', inboxFiles.length === 0, inboxFiles.join(', '))
check('the one crew file holds the rows', existsSync(join(TMP, 'crew', 'livecomms', `${CREW}.json`)))

rmSync(TMP, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ LIVECOMMS SPEAKS EVERY MESSAGE VERB' : `❌ ${failures} LIVECOMMS VERB PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
