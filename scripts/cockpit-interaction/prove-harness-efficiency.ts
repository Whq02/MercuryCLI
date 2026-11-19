#!/usr/bin/env bun

process.env.MERCURY_DESKTOP_DRIVER = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getAllBaseTools, getTools } = await import('../../src/tools.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')

t.section('row 2 — the request pool is measured, and dead bytes are gone')

t.finish('prove-harness-efficiency')
