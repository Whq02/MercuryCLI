#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 SP-1 — the chat pane ↵ waits out a landing; the legend says so')
{
  const { regionKeysFor } = await import('../../src/components/concourse/controlManifest.ts')
  const landing = regionKeysFor('chat', { newSession: true, chatSession: true, landing: true })
  check('during a landing the chat legend prints no ↵ row (a printed key that does not fire is a lie)', landing.every(k => k.keys !== '↵') && landing.some(k => k.keys === 's'))
  check("with a session focused the row reads '↵ full chat'; with none, '↵ new session'", regionKeysFor('chat', { newSession: true, chatSession: true }).some(k => k.keys === '↵' && k.label === 'full chat') && regionKeysFor('chat', { newSession: true, chatSession: false }).some(k => k.keys === '↵' && k.label === 'new session'))
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check('POISON: the unguarded birth is gone', !screen.includes('else callbacks.newSession?.()'))
  check('the key door is landing-guarded and rides the one birth door', screen.includes('if (hasFocusedSession()) callbacks.exitToChat()\n        else if (!landingInFlight()) armContractAsk()'))
  check('the screen reads the landing fact from the one owner', screen.includes("import { hasFocusedSession, landingInFlight } from '../../services/engine-connector/focusedConnector.js'"))
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check('the legend hands the landing fact to the one resolver', layout.includes("...(region === 'chat' ? { chatSession: chat, landing: landingInFlight() } : {}),"))
  const pane = read('src/components/concourse/SplitChatPane.tsx')
  check("the pane's pointer door stays withdrawn during a landing (the paint the key now agrees with)", pane.includes('{landingInFlight() ? (') && pane.includes('opening the focused chat…'))
}

process.exit(failures === 0 ? 0 : 1)
