#!/usr/bin/env bun
// ============================================================================
//  scripts/pulse/matrix/prove-provider-adapters.ts — scene 14: "each
//  currently integrated provider adapter", honestly scoped.
//
//  STATUS: LIVE — structural, runs against current HEAD.
//
//  The truth: the 1P Anthropic path is the adapter every PTY scene in this
//  matrix exercises end-to-end (ANTHROPIC_BASE_URL → the fixture server →
//  the real SDK client). The openai/zai engine lanes are DEFAULT-ON
// but the matrix runs them uncredentialed: HONEST unavailable
//  slots — available:false with the stable credential codes, zero models.
//  This file pins that honesty under a hermetic home so the matrix's
//  Anthropic-only scene set stays justified.
//
//  Run:  ~/.bun/bin/bun run scripts/pulse/matrix/prove-provider-adapters.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, section, finish } from '../lib/proveKit.ts'

// Hermetic bracket (the ambient-state law): with the engines gate retired,
// availability is credential truth — a developer machine's REAL OpenAI auth
// store or ZAI key must never flip these assertions.
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'pulse-adapters-home-'))
delete process.env.OPENAI_API_KEY
delete process.env.ZAI_API_KEY

section('anthropic — the one live adapter (the path every PTY scene drives)')
{
  const { anthropicStatus, listAnthropicModels } = await import(
    '../../../src/utils/router/providers/anthropic.ts'
  )
  const status = anthropicStatus()
  check('anthropic reports available', status.available === true, JSON.stringify(status))
  const models = listAnthropicModels()
  check('…and lists real models', models.length > 0, String(models.length))
  check(
    'never a Haiku row (the mechanical floor)',
    models.every(m => !/haiku/i.test(String((m as { id?: string }).id ?? ''))),
  )
}

section('openai / zai — honest uncredentialed slots (no fake scenes)')
{
  const { openaiStatus, listOpenaiModels } = await import(
    '../../../src/utils/router/providers/openai.ts'
  )
  const o = openaiStatus()
  check('openai declares unavailable', o.available === false, JSON.stringify(o))
  check(
    "…with the stable reason code 'no-account:openai'",
    (o as { reason?: string }).reason === 'no-account:openai',
    JSON.stringify(o),
  )
  check('openai lists zero models', listOpenaiModels().length === 0)

  const { zaiStatus, listZaiModels } = await import(
    '../../../src/utils/router/providers/zai.ts'
  )
  const z = zaiStatus()
  check('zai declares unavailable', z.available === false, JSON.stringify(z))
  check(
    "…with the stable reason code 'no-api-key:zai'",
    (z as { reason?: string }).reason === 'no-api-key:zai',
    JSON.stringify(z),
  )
  check('zai lists zero models', listZaiModels().length === 0)
}

finish('PULSE provider adapters (scene 14)')
