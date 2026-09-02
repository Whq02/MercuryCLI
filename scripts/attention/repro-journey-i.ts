#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/repro-journey-i.ts — Journey I reproducer.
//  Pins row (EXPECT-RED until Wave C lands).
//
//  The gap this repro pins, named verbatim by integrations/acp/README.md:
//  images `promptCapabilities.image = false`; plan / usage / config-option
//  session updates "not yet" (message + tool updates only — acpServer emits
//  only agent_message_chunk / tool_call / tool_call_update). extends
//  acpServer.ts (never forks the query loop) and flips the README rows.
//  Source pins are loose on the spec's exact kind names, tight on emission.
// ============================================================================
import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const src = readFileSync('src/services/acp/acpServer.ts', 'utf8')
const readme = readFileSync('integrations/acp/README.md', 'utf8')

t.section('Journey I — the four mosaic ACP partials are closed')
t.check(
  'promptCapabilities declares image support',
  /image:\s*true/.test(src),
  'promptCapabilities.image is still false',
)
t.check(
  'acpServer emits a plan session update',
  /sessionUpdate:\s*'plan'/.test(src),
)
t.check(
  'acpServer emits a usage-class session update',
  /sessionUpdate:\s*'[a-z_]*usage[a-z_]*'/.test(src),
)
t.check(
  'acpServer emits a config-option-class session update',
  /sessionUpdate:\s*'[a-z_]*(config|mode|option)[a-z_]*'/.test(src),
)
t.check(
  'the README capability table no longer rows the partials as "not yet"',
  !/not yet/.test(readme),
  'README still names open partials',
)

t.finish('repro-journey-i')
