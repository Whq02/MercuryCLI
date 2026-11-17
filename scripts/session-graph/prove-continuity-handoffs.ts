#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()

const composer = await import('../../src/input-core/composer-document.ts')
const picker = await import('../../src/services/crew/targetPicker.ts')

t.section('§4 — per-conversation draft identity on the ONE document owner')
{
  const a = composer.conversationScope('cv-aaa')
  const b = composer.conversationScope('cv-bbb')
  const aReply = composer.conversationScope('cv-aaa', 'reply')
  t.check('two conversations key two DIFFERENT scopes', a !== b)
  t.check('the composer family stays distinct within one conversation', a !== aReply)
  const docA = composer.createComposerDocument(a)
  const docB = composer.createComposerDocument(b)
  const withChip = composer.addShelfItem(docA, { kind: 'resource', ref: 'mercury://artifact/x', label: 'x' })
  t.check(
    'adding to one conversation shelf never touches the other (value semantics + distinct scopes)',
    withChip.items.length === 1 && docB.items.length === 0 && withChip.scope !== docB.scope,
  )
  t.check(
    "the shelf vocabulary carries 'resource' (stored once, carried by ref)",
    (composer.SHELF_ITEM_KINDS as readonly string[]).includes('resource'),
  )
}

t.section('§5 — the ONE crewmate target picker')
{
  const snapshot = {
    v: 1 as const,
    version: 1,
    refreshedAt: Date.now(),
    members: [
      {
        agentId: 'cw-mainmainmain' as never,
        displayName: 'Mercury',
        label: 'Mercury',
        visualToken: 'crew-0',
        presence: { state: 'online' as const, source: 'session', observedAt: Date.now() },
        roles: [],
        sessions: [],
        refs: [],
      },
      {
        agentId: 'cw-adapteragent' as never,
        displayName: 'Atlas',
        label: 'Atlas',
        visualToken: 'crew-1',
        presence: { state: 'unknown' as const, source: 'adapter:claude-code:unobserved', observedAt: Date.now() },
        roles: [],
        sessions: [],
        refs: [],
      },
    ],
    sources: {
      identity: { state: 'ready' as const },
      party: { state: 'ready' as const },
      workbench: { state: 'ready' as const },
    },
  }
  const rows = picker.targetPickerRows(snapshot as never)
  t.check('every directory member gets a row (the full picker view)', rows.length === 2)
  const main = rows.find(r => (r.agentId as string) === 'cw-mainmainmain')
  const external = rows.find(r => (r.agentId as string) === 'cw-adapteragent')
  t.check(
    'the main agent is dispatchable via its local queue',
    main?.dispatchable === true && main.endpoint === 'local-queue',
  )
  t.check(
    'an unattached external agent is NOT dispatchable (no guaranteed-refusal advertising)',
    external?.dispatchable === false && external.endpoint === 'none',
  )
  const targets = picker.dispatchableTargets(snapshot as never)
  t.check('dispatchableTargets is exactly the sendable subset', targets.length === 1 && targets[0]!.agentId === main!.agentId)
  t.check('a null snapshot yields an empty picker (honest absence)', picker.targetPickerRows(null).length === 0)
}

t.finish('prove-continuity-handoffs')
