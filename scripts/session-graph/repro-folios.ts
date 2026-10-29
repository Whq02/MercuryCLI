#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('CS-21 — the journal vocabulary gains threads + scoped decisions')
const contracts = readFileSync('src/utils/artifacts/reviewContracts.ts', 'utf8')
t.check(
  'comments carry parentCommentId (threaded replies)',
  /parentCommentId/.test(contracts),
  'reviewContracts.ts has no reply lineage',
)
t.check(
  'a scoped decision event exists (scope-decision)',
  /scope-decision/.test(contracts),
  'no per-scope accept/request-revision vocabulary',
)
t.check(
  'typed actor refs exist beside legacy string authors (authorRef)',
  /authorRef/.test(contracts),
  'no ActorRef authorship',
)

t.section('CS-21 — folios reach the inbox + the editor wire (journey-final pins, M8)')
{

  let inboxWire = false
  try {
    inboxWire = /review-request|crew\/conversations/.test(readFileSync('src/utils/artifacts/reviewStore.ts', 'utf8'))
  } catch {
    inboxWire = false
  }
  t.check(
    'the review journal reaches the conversation inbox (review-request events, M8)',
    inboxWire,
    'no review→conversation wire yet',
  )

  let acpFolioWire = false
  try {
    acpFolioWire = /_mercury\/crew|foldScopeDecisions|artifact/.test(
      readFileSync('src/services/acp/acpServer.ts', 'utf8'),
    ) && /_mercury\/crew/.test(readFileSync('src/services/acp/acpServer.ts', 'utf8'))
  } catch {
    acpFolioWire = false
  }
  t.check(
    'the editor wire serves the same folio ids and fold (M8)',
    acpFolioWire,
    'acpServer.ts carries no crew/folio wire yet',
  )
}

t.finish('repro-folios')
