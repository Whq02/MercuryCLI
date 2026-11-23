#!/usr/bin/env bun

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_LSP ??= '1'

const { SERVER_CATALOGUE, probeCatalogueEntry, serverCatalogueRecords } = await import(
  '../../src/integrations/lsp/serverCatalogue.ts'
)

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

{
  const ids = SERVER_CATALOGUE.map(e => e.id)
  check('unique ids', new Set(ids).size === ids.length, 'two rows of SERVER_CATALOGUE in src/integrations/lsp/serverCatalogue.ts share an id: ' + ids.filter((id, i) => ids.indexOf(id) !== i).join(', '))
  check(
    'every row carries binaries + languages + remedy',
    SERVER_CATALOGUE.every(e => e.binaries.length > 0 && e.languages.length > 0 && e.remedy.length > 0),
    'a row of SERVER_CATALOGUE in src/integrations/lsp/serverCatalogue.ts has an empty binaries, languages or remedy: ' +
      SERVER_CATALOGUE.filter(e => !(e.binaries.length > 0 && e.languages.length > 0 && e.remedy.length > 0)).map(e => e.id).join(', '),
  )
  check(
    'catalogue covers the brief families (≥16 rows)',
    SERVER_CATALOGUE.length >= 16,
    String(SERVER_CATALOGUE.length) + ' rows; rows were removed from SERVER_CATALOGUE in src/integrations/lsp/serverCatalogue.ts, restore them',
  )
}

{
  const fakeBin = mkdtempSync(join(tmpdir(), 'vista-catalogue-bin-'))
  const goplsBin = join(fakeBin, process.platform === 'win32' ? 'gopls.cmd' : 'gopls')
  writeFileSync(goplsBin, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n')
  if (process.platform !== 'win32') chmodSync(goplsBin, 0o755)
  const prevPath = process.env.PATH
  process.env.PATH = fakeBin
  try {
    const records = serverCatalogueRecords()
    check(
      'one record per catalogue row',
      records.length === SERVER_CATALOGUE.length,
      `${records.length} records for ${SERVER_CATALOGUE.length} rows; serverCatalogueRecords in src/integrations/lsp/serverCatalogue.ts must map every SERVER_CATALOGUE row to one record (it returns none when MERCURY_LSP is off)`,
    )
    const gopls = records.find(r => r.id === 'catalogue:lsp:gopls')
    check('present binary reads CONFIGURED (never ready)', gopls?.state === 'configured', JSON.stringify(gopls) + ' | serverCatalogueRecords in src/integrations/lsp/serverCatalogue.ts must give state configured when the binary is on PATH (the test puts a fake gopls there)')
    check(
      'configured detail names the not-offered posture + the wiring path',
      !!gopls && gopls.detail.includes('not offered here') && gopls.detail.includes('MERCURY_LSP_SERVERS'),
      'the detail text of the binary-present, no-root-marker branch in serverCatalogueRecords (src/integrations/lsp/serverCatalogue.ts) must say not offered here and name MERCURY_LSP_SERVERS; got ' + JSON.stringify(gopls?.detail),
    )
    const rust = records.find(r => r.id === 'catalogue:lsp:rust-analyzer')
    check(
      'absent binary reads UNAVAILABLE',
      rust?.state === 'unavailable',
      JSON.stringify(rust) + ' | serverCatalogueRecords in src/integrations/lsp/serverCatalogue.ts must give state unavailable when no binary resolves (rust-analyzer may be installed in a place the probe finds besides PATH)',
    )
    check(
      'unavailable carries the install remedy',
      !!rust?.remedy && rust.remedy.length > 0,
      'the unavailable record from serverCatalogueRecords in src/integrations/lsp/serverCatalogue.ts must set remedy from remedyFor(entry)',
    )
    check(
      'no record ever reads ready',
      records.every(r => (r.state as string) !== 'ready'),
      'serverCatalogueRecords in src/integrations/lsp/serverCatalogue.ts may only return configured or unavailable; ready is for a live server: ' + records.filter(r => (r.state as string) === 'ready').map(r => r.id).join(', '),
    )
  } finally {
    process.env.PATH = prevPath
    rmSync(fakeBin, { recursive: true, force: true })
  }
}

{
  const probe = probeCatalogueEntry(SERVER_CATALOGUE[0]!)
  check('probe returns entry identity', probe.entry.id === SERVER_CATALOGUE[0]!.id, 'probeCatalogueEntry in src/integrations/lsp/serverCatalogue.ts must return the entry it was given')
}

if (failures > 0) {
  console.error(`\nserver catalogue: ${failures} FAILURES`)
  process.exit(1)
}
console.log('\nserver catalogue: green')
