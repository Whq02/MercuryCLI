#!/usr/bin/env bun
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('CS-14 — the conversation registry exists at its pinned owner')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import('../../src/services/crew/conversations.ts')) as Record<string, unknown>
} catch {
  mod = null
}
t.check(
  'src/services/crew/conversations.ts loads',
  mod !== null,
  mod ? 'loaded' : 'module absent — no conversation identity owner',
)
t.check('conversation minting exists (mintConversation)', typeof mod?.mintConversation === 'function')
t.check('lineage edges exist (linkConversation)', typeof mod?.linkConversation === 'function')
t.check(
  'per-operator read cursors exist (readCursorOf + commitReadCursor)',
  typeof mod?.readCursorOf === 'function' && typeof mod?.commitReadCursor === 'function',
)

t.section('CS-15 — the inbox comparator is ONE pure exported function')
let inbox: Record<string, unknown> | null = null
try {
  inbox = (await import('../../src/services/crew/inbox.ts')) as Record<string, unknown>
} catch {
  inbox = null
}
t.check('src/services/crew/inbox.ts loads', inbox !== null)
t.check('compareInboxRows is exported', typeof inbox?.compareInboxRows === 'function')
t.check(
  'the bucket order is exactly needs-you → stalled → ready-to-review → working → completed',
  Array.isArray(inbox?.INBOX_BUCKET_ORDER) &&
    JSON.stringify(inbox?.INBOX_BUCKET_ORDER) ===
      JSON.stringify(['needs-you', 'stalled', 'ready-to-review', 'working', 'completed']),
  Array.isArray(inbox?.INBOX_BUCKET_ORDER) ? (inbox!.INBOX_BUCKET_ORDER as string[]).join(',') : 'absent',
)

t.section('CS-16 — oldest-unread resume is the opening law')
t.check(
  'the resume position resolver exists (oldestUnresolvedOf)',
  typeof inbox?.oldestUnresolvedOf === 'function',
)

t.section('CS-14/16 — every surface rides the ONE registry (journey-final pins)')
{
  const { readFileSync, readdirSync } = await import('node:fs')
  let consoleMints = false
  try {
    const helm = readFileSync('src/utils/cockpit/helmConsole.ts', 'utf8')
    consoleMints = /consoleHandoff|openSideConversation/.test(helm)
  } catch {
    consoleMints = false
  }
  t.check(
    'the Console ask lifecycle mints its conversation identity (M6)',
    consoleMints,
    'helmConsole.ts does not touch the conversation registry yet',
  )
  let minervaHandoff = false
  try {
    const files = readdirSync('src/services/crew')
    minervaHandoff = files.includes('minervaHandoff.ts')
  } catch {
    minervaHandoff = false
  }
  t.check(
    'the Minerva handoff owner exists beside the registry (M6)',
    minervaHandoff,
    'src/services/crew/minervaHandoff.ts absent',
  )
  let acpCursorWire = false
  try {
    const acp = readFileSync('src/services/acp/acpServer.ts', 'utf8')
    acpCursorWire = /readCursorOf|crew\/conversations|_mercury\/crew/.test(acp)
  } catch {
    acpCursorWire = false
  }
  t.check(
    'the editor wire resumes at the shared read cursor (M8)',
    acpCursorWire,
    'acpServer.ts carries no conversation/cursor wire yet',
  )
  const acp = readFileSync('src/services/acp/acpServer.ts', 'utf8')
  t.check(
    'the inbox owner keeps a production consumer after the board retired (the ACP crew wire)',
    /deriveInbox/.test(acp),
    'deriveInbox lost its last consumer',
  )
  const rows = readFileSync('src/components/prompts-panel/rows.ts', 'utf8')
  t.check(
    'the prompts panel keys crew traffic by record identity (never a display index)',
    rows.includes('key: `crew:${block.id}`') && rows.includes('key: `crew:${m.uuid}:${i++}`'),
    'crew traffic rows lack record-identity keys',
  )
}

t.finish('repro-conversations')
