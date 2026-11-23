#!/usr/bin/env bun


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
  const { regionKeysFor } = await import('../../src/screen/concourse/controlManifest.ts')
  const landing = regionKeysFor('chat', { newSession: true, chatSession: true, landing: true })
  check('during a landing the chat legend prints no ↵ row (a printed key that does not fire is a lie)', landing.every(k => k.keys !== '↵') && landing.some(k => k.keys === 's'), 'regionKeysFor in src/screen/concourse/controlManifest.ts must omit the ↵ row for the chat region when landing is true, and keep the s row')
  check("with a session focused the row reads '↵ full chat'; with none, '↵ new session'", regionKeysFor('chat', { newSession: true, chatSession: true }).some(k => k.keys === '↵' && k.label === 'full chat') && regionKeysFor('chat', { newSession: true, chatSession: false }).some(k => k.keys === '↵' && k.label === 'new session'), 'regionKeysFor in src/screen/concourse/controlManifest.ts must label the chat ↵ row full chat when chatSession is true and new session when it is false')
}

process.exit(failures === 0 ? 0 : 1)
