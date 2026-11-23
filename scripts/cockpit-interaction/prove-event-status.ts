#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()


t.section('§2 — feed mechanics')
{
  const { notifyRoomStatusFeed, subscribeRoomStatusFeed, _roomStatusFeedListenerCountForTesting } =
    await import('../../src/screen/attention/statusFeed.ts')

  let pings = 0
  const unsub = subscribeRoomStatusFeed(() => {
    pings += 1
  })
  const throwing = subscribeRoomStatusFeed(() => {
    throw new Error('display-only listener misbehaving')
  })
  notifyRoomStatusFeed()
  t.check('notify reaches subscribers', pings === 1, String(pings))
  notifyRoomStatusFeed()
  t.check('a throwing listener never breaks delivery', pings === 2, String(pings))
  throwing()
  unsub()
  t.check('unsubscribe removes the listener', _roomStatusFeedListenerCountForTesting() === 0)
}

t.finish('prove-event-status')
