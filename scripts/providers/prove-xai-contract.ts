#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { getFlagSpec } from '../../src/substrate/flagRegistry.ts'

try {
  assert.ok(getFlagSpec('MERCURY_XAI_API_BASE') !== undefined)
  for (const base of ['MERCURY_XAI_API_BASE', 'MERCURY_XAI_GROK_PROXY_BASE', 'MERCURY_XAI_AUTH_BASE', 'MERCURY_XAI_MANAGEMENT_API_BASE']) {
    assert.ok(getFlagSpec(base) !== undefined, `${base} is registered`)
  }
  assert.ok(getFlagSpec('MERCURY_XAI_MANAGEMENT_API_BASE') !== undefined)
  console.log('[PASS] the xAI base joins the registered hermetic dead-letter census')
} finally { rmSync(proofHome, { recursive: true, force: true }) }
