#!/usr/bin/env bun
import { finish, proveHoldRoad, proveWallReads, proveWindowFact, type Fixture, type LimitWindow } from './lane-wall-rig.ts'

let window: LimitWindow = { state: 'clear' }
const fixture: Fixture = { family: 'openrouter', window: () => window }
const setWindow = (w: LimitWindow): void => {
  window = w
}

proveWallReads(fixture, 'OpenRouter', setWindow)
proveWindowFact('openrouter', 'OpenRouter')
await proveHoldRoad(fixture, 'OpenRouter', setWindow, 'openrouter-shell')
finish()
