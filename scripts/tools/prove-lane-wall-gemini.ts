#!/usr/bin/env bun
import { finish, proveHoldRoad, proveWallReads, proveWindowFact, type Fixture, type LimitWindow } from './lane-wall-rig.ts'

let window: LimitWindow = { state: 'clear' }
const fixture: Fixture = { family: 'gemini', window: () => window }
const setWindow = (w: LimitWindow): void => {
  window = w
}

proveWallReads(fixture, 'Gemini', setWindow)
proveWindowFact('gemini', 'Gemini')
await proveHoldRoad(fixture, 'Gemini', setWindow, 'gemini-shell')
finish()
