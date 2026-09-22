#!/usr/bin/env bun
import { finish, proveHoldRoad, proveWallReads, proveWindowFact, type Fixture, type LimitWindow } from './lane-wall-rig.ts'

let window: LimitWindow = { state: 'clear' }
const fixture: Fixture = { family: 'huggingface', window: () => window }
const setWindow = (w: LimitWindow): void => {
  window = w
}

proveWallReads(fixture, 'Hugging Face', setWindow)
proveWindowFact('huggingface', 'Hugging Face')
await proveHoldRoad(fixture, 'Hugging Face', setWindow, 'huggingface-shell')
finish()
