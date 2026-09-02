#!/usr/bin/env bun
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
t('§4 the probe reason clips at a word through the one clipper', handlers.includes('clipToWord(result.reason, 160)'))
t('§4 …never the bare mid-word slice', !handlers.includes('result.reason.slice(0, 160)'))
t('§5 add-json names the matched transport’s field problems', handlers.includes('describeMcpConfigIssues(validated.error.issues, parsed)'))
t('§6 the add verb lists only the writable scopes', utils.includes("OPERATOR_CONFIG_SCOPES: readonly ConfigScope[] = ['local', 'user', 'project']") && !utils.includes("'claudeai',\n  'managed',"))

console.log(failures === 0 ? 'MCP CLI TRUTH: ALL PASS' : 'MCP CLI TRUTH: RED')
process.exit(failures)
