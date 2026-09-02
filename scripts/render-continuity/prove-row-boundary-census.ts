#!/usr/bin/env bun
// ============================================================================
//  prove-row-boundary-census — every transcript-row mount is contained.
//
//  The law: <MessageRow> renders arbitrary per-message content (tool cards,
//  attachments, foreign records); one poisoned row's render throw must cost
//  ONE ROW, never the session. Messages.tsx learned this the hard way (its
//  own comment records the React #300 session-kill) and wraps every mount in
//  SentryErrorBoundary. The board's live chat-preview pane (SessionMirror)
//  mounted the identical component BARE — the same poisoned row that
//  degrades to one quiet line in the main transcript ended the whole
//  session when viewed through the mirror instead.
//
//  §1 every file that mounts <MessageRow> is inventoried
//  §2 every mount file carries a SentryErrorBoundary wrap beside the mount
//     (structural: the boundary opens within the 30 lines above the mount)
// ============================================================================
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// The mount census: files under src/ containing a <MessageRow JSX mount.
const hits = execSync(`grep -rln '<MessageRow' src/components src/screens src/tools 2>/dev/null || true`, {
  cwd: ROOT,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean)
  .sort()

// §1 the inventory: a NEW mount file reds here until it is added WITH its
// boundary wrap (checked in §2 — adding a row is a conscious act, not a bump).
const INVENTORY = ['src/components/Messages.tsx', 'src/components/concourse/SessionMirror.tsx']
t('§1 the MessageRow mount census matches the inventory', JSON.stringify(hits) === JSON.stringify(INVENTORY), `found: ${hits.join(', ') || '(none)'}`)

// §2 each mount sits under a boundary
for (const file of INVENTORY) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n')
  const mounts: number[] = []
  lines.forEach((l, i) => {
    if (l.includes('<MessageRow') && !l.includes('import')) mounts.push(i)
  })
  t(`§2 ${file} mounts MessageRow at least once`, mounts.length > 0)
  for (const at of mounts) {
    const above = lines.slice(Math.max(0, at - 30), at).join('\n')
    t(`§2 ${file}:${at + 1} mount is contained (SentryErrorBoundary opens above it)`, above.includes('<SentryErrorBoundary'), 'a bare MessageRow mount — one poisoned row would end the session here')
  }
}

console.log(failures === 0 ? 'ROW-BOUNDARY CENSUS: ALL PASS' : 'ROW-BOUNDARY CENSUS: RED')
process.exit(failures)
