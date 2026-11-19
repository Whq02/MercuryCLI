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

{
  const { regionKeysFor } = await import('../../src/components/concourse/controlManifest.ts')
  const reducedList = regionKeysFor('list', { newSession: false })
  check(
    'the reduced-stage list drops the full-stage doors (n · r · s · space · newline) and single-↵s the enter',
    !reducedList.some(k => ['n', 'r', 's', 'space', '⇧↵/⌃j'].includes(k.keys)) && reducedList.some(k => k.keys === '↵' && k.label === 'enter session'),
  )
  const fullList = regionKeysFor('list', { newSession: true })
  check('the full-stage list keeps the whole grammar incl. marks and split', ['↵↵', 'n', 'r', '→', '/', '⌃x ⌃x', 'm', 'space', 's'].every(keys => fullList.some(k => k.keys === keys)))
  check('no region teaches ⌃s', (['list', 'live', 'rail', 'chat'] as const).every(region => !regionKeysFor(region, { newSession: true }).some(k => k.keys === '⌃s')))
}


console.log('§4 live meta row: enter-grammar on an empty draft, send only with words held')
{
  const { CONCOURSE_REGION_KEYS } = await import('../../src/components/concourse/controlManifest.ts')
  const rows = (declared: ReadonlyArray<{ keys: string; label: string }>): ReadonlyArray<{ keys: string; label: string }> => declared
  check(
    "the manifest leaves the live composer's ↵ to the layout (no ↵ row declared there)",
    rows(CONCOURSE_REGION_KEYS.live).every(k => k.keys !== '↵'),
  )
}

process.exit(failures === 0 ? 0 : 1)
