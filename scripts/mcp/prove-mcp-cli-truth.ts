#!/usr/bin/env bun
// ============================================================================
//  prove-mcp-cli-truth — the mcp CLI's three small lies stay dead.
//
//  §1 `mcp get` printed Authorization/header VALUES in full on stdout while
//     the one redaction owner (describeHeadersRedacted) sat imported one
//     module over — names ride, credential values mask, on every surface.
//  §2 `mcp add-json` computed schema validation and then persisted the RAW
//     object regardless, using the verdict only to pick a word in the
//     success line — the write gates on the schema now, refusing with the
//     issues named.
//  §3 the 'user' scope receipt named `<home>/config.json`, a file that has
//     never existed — the path reads the real file's one resolver
//     (getGlobalMercuryFile: legacy .config.json if present, else
//     .mercury<suffix>.json).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const handlers = readFileSync(join(ROOT, 'src/cli/handlers/mcp.tsx'), 'utf8')
const utils = readFileSync(join(ROOT, 'src/services/mcp/utils.ts'), 'utf8')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

t('§1 get prints headers through the one redaction owner', handlers.includes('describeHeadersRedacted(config.headers)'))
t('§1 …never a bare value write', !handlers.includes('`    ${key}: ${value}\\n`'))
t('§2 the add-json write sits behind the schema verdict', /if \(!validated\.success\) \{[\s\S]{0,400}?\}\s*\n\s*await addMcpConfig\(name, parsed, scope\)/.test(handlers))
t('§2 …refusing with the issues named', handlers.includes('does not match the server schema'))
t('§3 the user-scope path reads the real file resolver', utils.includes('return getGlobalMercuryFile()'))
t("§3 …never the phantom config.json", !utils.includes('/config.json`'))

console.log(failures === 0 ? 'MCP CLI TRUTH: ALL PASS' : 'MCP CLI TRUTH: RED')
process.exit(failures)
