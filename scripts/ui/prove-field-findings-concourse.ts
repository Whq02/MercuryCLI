#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-field-findings-concourse-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

try {
  const { enableConfigs } = await import('../../src/platform/settings/config.ts')
  enableConfigs()
  {
    const { regionKeysFor } = await import('../../src/screen/concourse/controlManifest.ts')
    const reducedList = regionKeysFor('list', { newSession: false })
    check(
      'the reduced-stage list drops the full-stage doors (n · r · s · space · newline) and single-↵s the enter',
      !reducedList.some(k => ['n', 'r', 's', 'space', '⇧↵/⌃j'].includes(k.keys)) && reducedList.some(k => k.keys === '↵' && k.label === 'enter session'),
      `reducedList=${JSON.stringify(reducedList)}; fix regionKeysFor with newSession false in src/screen/concourse/controlManifest.ts`,
    )
    const fullList = regionKeysFor('list', { newSession: true })
    check('the full-stage list keeps the whole grammar incl. marks and split', ['↵↵', 'n', 'r', '→', '/', '⌃x ⌃x', 'm', 'space', 's'].every(keys => fullList.some(k => k.keys === keys)), `fullList=${JSON.stringify(fullList.map(k => k.keys))}; fix regionKeysFor with newSession true in src/screen/concourse/controlManifest.ts`)
    check('no region teaches ⌃s', (['list', 'live', 'rail', 'chat'] as const).every(region => !regionKeysFor(region, { newSession: true }).some(k => k.keys === '⌃s')), 'a region still lists ⌃s; remove that row from CONCOURSE_REGION_KEYS or regionKeysFor in src/screen/concourse/controlManifest.ts')
  }


  console.log('§4 live meta row: enter-grammar on an empty draft, send only with words held')
  {
    const { CONCOURSE_REGION_KEYS } = await import('../../src/screen/concourse/controlManifest.ts')
    const rows = (declared: ReadonlyArray<{ keys: string; label: string }>): ReadonlyArray<{ keys: string; label: string }> => declared
    check(
      "the manifest leaves the live composer's ↵ to the layout (no ↵ row declared there)",
      rows(CONCOURSE_REGION_KEYS.live).every(k => k.keys !== '↵'),
      'remove the ↵ row from the live entry of CONCOURSE_REGION_KEYS in src/screen/concourse/controlManifest.ts',
    )
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
