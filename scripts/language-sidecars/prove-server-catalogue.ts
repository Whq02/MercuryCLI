#!/usr/bin/env bun
// ============================================================================
//  scripts/language-sidecars/prove-server-catalogue.ts — the DETECT-ONLY
//  locally-installed-server catalogue with three-state honesty:
//    catalogue presence ≠ binary presence ≠ initialized capability.
//
//    1. catalogue integrity — unique ids/labels, every row carries binaries
//       + languages + an install remedy;
//    2. an ABSENT binary reads 'unavailable' with the remedy;
//    3. a PRESENT binary reads 'configured' (never 'ready') and the detail
//       names the DETECT-ONLY posture + the wiring path;
//    4. nothing in the catalogue path spawns a process (probe = PATH walk).
// ============================================================================

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_LSP ??= '1'

const { SERVER_CATALOGUE, probeCatalogueEntry, serverCatalogueRecords } = await import(
  '../../src/services/lsp/serverCatalogue.ts'
)

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

// 1: integrity
{
  const ids = SERVER_CATALOGUE.map(e => e.id)
  check('unique ids', new Set(ids).size === ids.length)
  check('every row carries binaries + languages + remedy', SERVER_CATALOGUE.every(e => e.binaries.length > 0 && e.languages.length > 0 && e.remedy.length > 0))
  check('catalogue covers the brief families (≥16 rows)', SERVER_CATALOGUE.length >= 16, String(SERVER_CATALOGUE.length))
}

// 2+3: three-state honesty over a controlled PATH
{
  const fakeBin = mkdtempSync(join(tmpdir(), 'vista-catalogue-bin-'))
  writeFileSync(join(fakeBin, 'gopls'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(fakeBin, 'gopls'), 0o755)
  const prevPath = process.env.PATH
  process.env.PATH = fakeBin
  try {
    const records = serverCatalogueRecords()
    check('one record per catalogue row', records.length === SERVER_CATALOGUE.length)
    const gopls = records.find(r => r.id === 'catalogue:lsp:gopls')
    check('present binary reads CONFIGURED (never ready)', gopls?.state === 'configured', JSON.stringify(gopls))
    check(
      'configured detail names the not-offered posture + the wiring path',
      !!gopls && gopls.detail.includes('not offered here') && gopls.detail.includes('MERCURY_LSP_SERVERS'),
    )
    const rust = records.find(r => r.id === 'catalogue:lsp:rust-analyzer')
    check('absent binary reads UNAVAILABLE', rust?.state === 'unavailable')
    check('unavailable carries the install remedy', !!rust?.remedy && rust.remedy.length > 0)
    check('no record ever reads ready', records.every(r => (r.state as string) !== 'ready'))
  } finally {
    process.env.PATH = prevPath
  }
}

// 4: probe is a PATH walk, not a spawn (structural)
{
  const src = await Bun.file(join(import.meta.dir, '..', '..', 'src', 'services', 'lsp', 'serverCatalogue.ts')).text()
  check('catalogue never spawns (no child_process import)', !src.includes('child_process'))
  const probe = probeCatalogueEntry(SERVER_CATALOGUE[0]!)
  check('probe returns entry identity', probe.entry.id === SERVER_CATALOGUE[0]!.id)
}

if (failures > 0) {
  console.error(`\nserver catalogue: ${failures} FAILURES`)
  process.exit(1)
}
console.log('\nserver catalogue: green')
