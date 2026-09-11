#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'inline-render-safety-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { getAllBaseTools } = await import('../../src/tools.ts')
const { Box } = await import('../../src/ink.js')
const websearch = await import('../../src/tools/WebSearchTool/UI.tsx')
const webfetch = await import('../../src/tools/WebFetchTool/UI.tsx')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

function findBox(node: unknown): boolean {
  if (node == null || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some(findBox)
  const el = node as { type?: unknown; props?: { children?: unknown } }
  if (el.type === Box) return true
  return el.props !== undefined ? findBox(el.props.children) : false
}

const RICH_INPUT = {
  url: 'https://docs.example/page',
  prompt: 'summarize the page',
  query: 'terminal harness',
  allowed_domains: ['docs.example'],
  blocked_domains: ['ads.example'],
  file_path: '/tmp/x.txt',
  path: '/tmp',
  command: 'ls',
  pattern: 'x',
  description: 'a probe',
  content: 'body',
  old_string: 'a',
  new_string: 'b',
}

{
  const tools = getAllBaseTools()
  t('§1 the registry resolved a real catalogue', tools.length > 20, `${tools.length} tools`)
  const offenders: string[] = []
  for (const tool of tools) {
    const fn = (tool as unknown as Record<string, unknown>).renderToolUseMessage
    if (typeof fn !== 'function') continue
    for (const verbose of [false, true]) {
      try {
        const out = (fn as (input: unknown, opts: unknown) => unknown).call(tool, RICH_INPUT, { verbose, theme: 'dark' })
        if (findBox(out)) offenders.push(`${tool.name} (verbose=${verbose})`)
      } catch {
      }
    }
  }
  t('§1 no built-in returns a Box from its use line', offenders.length === 0, offenders.join(', '))
}

{
  const ws = websearch.renderToolUseMessage({ query: 'q', allowed_domains: ['a.example'], blocked_domains: ['b.example'] }, { verbose: true } as never)
  t('§2 WebSearch verbose is a plain string', typeof ws === 'string')
  t('§2 …carrying the query and both domain lines', typeof ws === 'string' && ws.includes('"q"') && ws.includes('allowed domains: a.example') && ws.includes('blocked domains: b.example'))
  const wf = webfetch.renderToolUseMessage({ url: 'https://x.example', prompt: 'p' }, { verbose: true } as never)
  t('§2 WebFetch verbose is a plain string', typeof wf === 'string')
  t('§2 …carrying the url and prompt lines', typeof wf === 'string' && wf.includes('url: https://x.example') && wf.includes('prompt: p'))
  const wsQuiet = websearch.renderToolUseMessage({ query: 'q' }, { verbose: false } as never)
  t('§2 the quiet arms stay unchanged', wsQuiet === '"q"' && webfetch.renderToolUseMessage({ url: 'u' }, { verbose: false } as never) === 'u')
}

{
  const { readFileSync } = await import('node:fs')
  const src = (rel: string): string => readFileSync(new URL(`../../src/${rel}`, import.meta.url), 'utf8')
  const wrapWalk = (body: string): boolean =>
    body.includes('React.Children.toArray') && body.includes('React.isValidElement(child)') && body.includes('<Text key={`total-')
  const mr = src('components/MessageResponse.tsx')
  t('§3 MessageResponse walks its children total', wrapWalk(mr))
  t('§3 …and BOTH arms consume the walked set (nested and framed)', mr.includes('return <>{total}</>') && mr.includes('{total}\n      </MessageResponseContext.Provider>'))
  const atum = src('components/messages/AssistantToolUseMessage.tsx')
  const progressAt = atum.indexOf('function renderProgressBody')
  const progressBody = atum.slice(progressAt, atum.indexOf('let queuedMessage'))
  t('§3 the progress-body passthrough walks its body total', progressAt !== -1 && wrapWalk(progressBody))
  t('§3 …and the Box consumes the walked set', progressBody.includes('{totalBody}'))
  const byline = src('components/design-system/Byline.tsx')
  t('§3 Byline (the law-giver) still owns its own totality', byline.includes('React.isValidElement(child) ? child : <Text>{child}</Text>'))
}

console.log(failures === 0 ? 'INLINE-RENDER SAFETY: ALL PASS' : 'INLINE-RENDER SAFETY: RED')
process.exit(failures)
