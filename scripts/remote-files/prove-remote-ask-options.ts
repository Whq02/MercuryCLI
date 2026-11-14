#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { underScratchHome } from './remoteKit.ts'

underScratchHome(import.meta.path)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'remote-ask-options-')))
const project = join(scratch, 'project')
const elsewhere = join(scratch, 'elsewhere', 'notes')
for (const dir of [project, elsewhere]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(project)

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
const { setCwdState, setOriginalCwd } = await import('../../src/bootstrap/state.ts')
const { getFilePermissionOptions } = await import('../../src/components/permissions/FilePermissionDialog/permissionOptions.tsx')
const { generateSuggestions } = await import('../../src/utils/permissions/filesystem.ts')
enableConfigs()
setOriginalCwd(project)
setCwdState(project)

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
const context = getEmptyToolPermissionContext()
const words = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(words).join('')
  if (node !== null && typeof node === 'object' && 'props' in node) return words((node as { props: { children?: unknown } }).props.children)
  return ''
}
const labels = (filePath: string, operationType: 'read' | 'write'): string[] => getFilePermissionOptions({ filePath, toolPermissionContext: context, operationType }).map(option => words(option.label))
const NO = 'No, and tell Mercury what to do differently (esc)'

try {
  const outsideWrite = labels(join(elsewhere, 'a.txt'), 'write')
  const shortcut = /\(([^)]+)\)$/.exec(outsideWrite[1] ?? '')?.[1] ?? 'shift+tab'
  check('a read on another machine offers that host for the session', JSON.stringify(labels('ssh://web1/etc/hosts', 'read')) === JSON.stringify(['Yes', 'Yes, allow reading from web1 for this session', NO]), JSON.stringify(labels('ssh://web1/etc/hosts', 'read')))
  check('an edit on another machine offers all edits on that host', JSON.stringify(labels('ssh://web1/srv/app/config.yml', 'write')) === JSON.stringify(['Yes', `Yes, allow all edits on web1 for this session (${shortcut})`, NO]), JSON.stringify(labels('ssh://web1/srv/app/config.yml', 'write')))
  check('the host is named as it was written, with its account and its port', labels('ssh://deploy@web1:2222/~/notes.md', 'read')[1] === 'Yes, allow reading from deploy@web1:2222 for this session' && labels('SSH://Web1/x', 'write')[1] === `Yes, allow all edits on Web1 for this session (${shortcut})`, `${labels('ssh://deploy@web1:2222/~/notes.md', 'read')[1]} | ${labels('SSH://Web1/x', 'write')[1]}`)
  check('the host list offers yes and no, and nothing for the session', JSON.stringify(labels('ssh://', 'read')) === JSON.stringify(['Yes', NO]), JSON.stringify(labels('ssh://', 'read')))
  const readGrant = generateSuggestions('ssh://web1/etc/hosts', 'read', context)
  const writeGrant = generateSuggestions('ssh://deploy@web1:2222/srv/x', 'write', context)
  check('what the session option grants is a rule for the host: reading for a read', JSON.stringify(readGrant) === JSON.stringify([{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: 'ssh://web1/**' }], behavior: 'allow', destination: 'session' }]), JSON.stringify(readGrant))
  check('and editing, on the host as written, for an edit', JSON.stringify(writeGrant.at(-1)) === JSON.stringify({ type: 'addRules', rules: [{ toolName: 'Edit', ruleContent: 'ssh://deploy@web1:2222/**' }], behavior: 'allow', destination: 'session' }), JSON.stringify(writeGrant))
  check('no rule is offered for the host list or for a path that names no host', generateSuggestions('ssh://', 'read', context).length === 0 && generateSuggestions('ssh:///etc/hosts', 'read', context).length === 0 && generateSuggestions('ssh://', 'write', context).length === 0, JSON.stringify(generateSuggestions('ssh://', 'read', context)))
  check('a local file in the working folder is offered as before', JSON.stringify(labels(join(project, 'a.txt'), 'read')) === JSON.stringify(['Yes', 'Yes, for this session', NO]) && JSON.stringify(labels(join(project, 'a.txt'), 'write')) === JSON.stringify(['Yes', `Yes, allow all edits for this session (${shortcut})`, NO]), `${JSON.stringify(labels(join(project, 'a.txt'), 'read'))} ${JSON.stringify(labels(join(project, 'a.txt'), 'write'))}`)
  check('a local file outside it is offered its folder, as before', JSON.stringify(labels(join(elsewhere, 'a.txt'), 'read')) === JSON.stringify(['Yes', 'Yes, allow reading from notes/ for this session', NO]) && JSON.stringify(outsideWrite) === JSON.stringify(['Yes', `Yes, allow all edits in notes/ for this session (${shortcut})`, NO]), `${JSON.stringify(labels(join(elsewhere, 'a.txt'), 'read'))} ${JSON.stringify(outsideWrite)}`)
  check('a relative folder named ssh: with one slash is a local path', JSON.stringify(labels('ssh:/web1/etc/hosts', 'read')) === JSON.stringify(['Yes', 'Yes, for this session', NO]), JSON.stringify(labels('ssh:/web1/etc/hosts', 'read')))
} finally {
  process.chdir(tmpdir())
  removeScratch(scratch)
}

console.log(`\nremote ask options: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)
