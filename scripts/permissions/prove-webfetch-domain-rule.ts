#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(realpathSync(tmpdir()), 'webfetch-domain-rule-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${t}`)

const webFetch = (await import('../../src/tools/WebFetchTool/WebFetchTool.ts')) as { WebFetchTool: { checkPermissions?: (input: unknown, context: unknown) => Promise<unknown> }; webFetchRuleMatches?: (rule: string, request: string) => boolean }
const { WebFetchTool } = webFetch
const webFetchRuleMatches = (rule: string, request: string): boolean => webFetch.webFetchRuleMatches?.(rule, request) ?? false
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getCustomValidation } = await import('../../src/utils/settings/toolValidationConfig.ts')
const validateToolPermissionRule = (tool: string, content: string): { valid: boolean } => getCustomValidation(tool)?.(content) ?? { valid: false }

type Ctx = ReturnType<typeof getEmptyToolPermissionContext>
type Decision = { behavior: string; message?: string; decisionReason?: { type: string; rule?: { ruleValue: { ruleContent?: string } } } }
const ctxWith = (rules: { allow?: string[]; deny?: string[]; ask?: string[] }): Ctx =>
  ({
    ...getEmptyToolPermissionContext(),
    alwaysAllowRules: rules.allow ? { userSettings: rules.allow } : {},
    alwaysDenyRules: rules.deny ? { userSettings: rules.deny } : {},
    alwaysAskRules: rules.ask ? { userSettings: rules.ask } : {},
  }) as unknown as Ctx
const decide = async (url: string, ctx: Ctx): Promise<Decision> => {
  const context = { getAppState: () => ({ toolPermissionContext: ctx }) }
  return (await WebFetchTool.checkPermissions!({ url, prompt: 'summarise' }, context)) as Decision
}
const ruleOf = (d: Decision): string => d.decisionReason?.rule?.ruleValue.ruleContent ?? '(no rule)'

section('§1 the matcher: a domain rule names a host or a host pattern, nothing else widens')
{
  check('an exact domain rule matches its own host', webFetchRuleMatches('domain:example.com', 'domain:example.com'))
  check('an exact domain rule does not match another host', !webFetchRuleMatches('domain:example.com', 'domain:docs.example.com'))
  check('a star rule covers every host under the domain', webFetchRuleMatches('domain:*.example.com', 'domain:docs.example.com') && webFetchRuleMatches('domain:*.example.com', 'domain:a.b.example.com'))
  check('a star rule for the hosts under a domain does not cover the apex', !webFetchRuleMatches('domain:*.example.com', 'domain:example.com'))
  check('a star rule does not cover a look-alike domain', !webFetchRuleMatches('domain:*.example.com', 'domain:notexample.com') && !webFetchRuleMatches('domain:*.example.com', 'domain:example.com.evil.net'))
  check('the dot in the rule is a dot, not any character', !webFetchRuleMatches('domain:*.example.com', 'domain:docsXexample.com'))
  check('a star may sit anywhere in the host pattern', webFetchRuleMatches('domain:docs.*.com', 'domain:docs.example.com') && webFetchRuleMatches('domain:api-*.example.com', 'domain:api-eu.example.com'))
  check('host matching is case-insensitive', webFetchRuleMatches('domain:*.Example.com', 'domain:docs.example.com'))
  check('a degraded input key matches itself alone', webFetchRuleMatches('input:{"url":"x"}', 'input:{"url":"x"}') && !webFetchRuleMatches('input:*', 'input:{"url":"x"}'))
}

section('§2 the tool decides by the rule that covers the host, and names that rule')
{
  const allowed = await decide('https://docs.example.com/guide', ctxWith({ allow: ['WebFetch(domain:*.example.com)'] }))
  check('a fetch under an allowed host pattern is allowed', allowed.behavior === 'allow', JSON.stringify(allowed))
  check('the decision names the rule that covered it', ruleOf(allowed) === 'domain:*.example.com', ruleOf(allowed))
  const apex = await decide('https://example.com/', ctxWith({ allow: ['WebFetch(domain:*.example.com)'] }))
  check('the apex host is not covered by the hosts-under rule: it asks', apex.behavior === 'ask', JSON.stringify(apex))
  const stranger = await decide('https://notexample.com/', ctxWith({ allow: ['WebFetch(domain:*.example.com)'] }))
  check('a look-alike host asks', stranger.behavior === 'ask', JSON.stringify(stranger))
  const exact = await decide('https://example.com/', ctxWith({ allow: ['WebFetch(domain:example.com)'] }))
  check('the exact form still allows its host', exact.behavior === 'allow' && ruleOf(exact) === 'domain:example.com', JSON.stringify(exact))
  const denied = await decide('https://cdn.evil.example/x', ctxWith({ allow: ['WebFetch(domain:*.evil.example)'], deny: ['WebFetch(domain:*.evil.example)'] }))
  check('a deny pattern wins over an allow pattern for the same hosts, and the sentence names the rule', denied.behavior === 'deny' && ruleOf(denied) === 'domain:*.evil.example' && /is denied by the rule WebFetch\(domain:\*\.evil\.example\)/.test(denied.message ?? ''), JSON.stringify(denied))
  const asked = await decide('https://api.example.com/', ctxWith({ allow: ['WebFetch(domain:*.example.com)'], ask: ['WebFetch(domain:api.example.com)'] }))
  check('an exact ask rule for one host wins over the allow pattern around it', asked.behavior === 'ask' && ruleOf(asked) === 'domain:api.example.com', JSON.stringify(asked))
}

section('§3 the validator teaches the forms the tool reads')
{
  const star = validateToolPermissionRule('WebFetch', 'domain:*.example.com')
  check('the hosts-under form validates', star.valid === true, JSON.stringify(star))
  const exact = validateToolPermissionRule('WebFetch', 'domain:example.com')
  check('the exact form validates', exact.valid === true, JSON.stringify(exact))
  const url = validateToolPermissionRule('WebFetch', 'https://example.com')
  check('a URL is refused with the domain form taught', url.valid === false && JSON.stringify(url).includes('domain:'), JSON.stringify(url))
}

console.log(`\n${failures === 0 ? 'prove-webfetch-domain-rule: ALL LAWS HOLD' : `prove-webfetch-domain-rule: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
