#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const read = (p: string): string => readFileSync(path.join(ROOT, p), 'utf8')

let fail = 0
const t = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

const READY_FLAG_RE = /setTimeout\s*\(\s*\(\)\s*=>\s*set\w*(Ready|Buffer|Armed)/i

{
  const src = read('src/components/mercury-ui/useFlatList.ts')
  t('useFlatList: ↵ dispatches the primary (activate)', src.includes("action === 'activate'"))
  t(
    'useFlatList: event-identity launch gate (not wall-clock, not a ready flag)',
    src.includes('useOpenEventGate') && !src.includes('Date.now() - mountedAt'),
  )
  t('useFlatList: no setTimeout ready-flag', !READY_FLAG_RE.test(src))
  t(
    "useFlatList: esc/← close ungated (before the gate check)",
    src.indexOf("action === 'cancel'") !== -1 && src.indexOf("action === 'cancel'") < src.indexOf('pastGate()'),
  )
}

{
  const src = read('src/commands/health/HealthCertificate.tsx')
  t('HealthCertificate: ↵ is the primary (expand evidence)', src.includes('key.return'))
  t(
    'HealthCertificate: mount-TIMESTAMP buffer',
    src.includes('mountedAt') && /Date\.now\(\) - mountedAt\.current/.test(src),
  )
  t('HealthCertificate: no setTimeout ready-flag', !READY_FLAG_RE.test(src))
  t(
    'HealthCertificate: footer leads nav then ↵ primary (gated on rows to select)',
    /checks\.length > 0 \? '↑↓ select · ⇞⇟ page · ↵ evidence · '/.test(src),
  )
}

{
  const src = read('src/components/mercury-ui/parity/DaemonView.tsx')
  t('DaemonView: useOpenEventGate (the one seam)', src.includes('useOpenEventGate('))
  t('DaemonView: no setTimeout ready-flag', !READY_FLAG_RE.test(src))
}

{
  const src = read('src/components/mercury-ui/NavigablePanes.tsx')
  t(
    'NavigablePanes: action hints derive from when(selectedRow)',
    src.includes('a.when(selectedRow)') && src.includes('actionHints'),
  )
  const view = src.indexOf("'↵/→ view'")
  const acts = src.indexOf('actionHints,')
  const section = src.indexOf("'tab/1-9 section'")
  const close = src.indexOf("'esc close'")
  t(
    'NavigablePanes: footer order nav → actions → section → close',
    view > 0 && view < acts && acts < section && section < close,
    `view@${view} actions@${acts} section@${section} close@${close}`,
  )
}

process.exit(fail)
