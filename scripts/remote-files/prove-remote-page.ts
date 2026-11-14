#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { enterWorld, localTransportUnavailable, remoteWorld, underScratchHome } from './remoteKit.ts'

const HOME = underScratchHome(import.meta.path)
const ROOT = join(import.meta.dir, '..', '..')
const launch = realpathSync(mkdtempSync(join(tmpdir(), 'remote-page-')))
const project = join(launch, 'project')
mkdirSync(project, { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(launch, 'mercury-home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BARE = '1'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_WARDS']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(project)

const { parseRemotePath } = await import('../../src/services/remoteFiles/target.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
const { setCwdState, setOriginalCwd, setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
const { closeRemoteConnections } = await import('../../src/services/remoteFiles/connection.ts')
setSessionTrustAccepted(true)
enableConfigs()
setOriginalCwd(project)
setCwdState(project)

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

const pagePath = join(ROOT, 'docs', 'REMOTE-FILES.md')
const page = existsSync(pagePath) ? readFileSync(pagePath, 'utf8') : ''
const index = readFileSync(join(ROOT, 'docs', 'README.md'), 'utf8')
type Parsed = { authority: { user?: string; host: string; port?: number }; home: string | null; path: string } | null
const parsed = (written: string): Parsed | string => {
  try {
    return parseRemotePath(written) as Parsed
  } catch (error) {
    return `refused: ${error instanceof Error ? error.message : String(error)}`
  }
}
const shape = (written: string): string => {
  const target = parsed(written)
  return typeof target === 'string' || target === null ? String(target) : JSON.stringify([target.authority.user ?? null, target.authority.host, target.authority.port ?? null, target.home, target.path])
}

section('the page and its place')
check('the index of the documentation names the page', index.includes('- [REMOTE-FILES.md](REMOTE-FILES.md): '), 'no such line in docs/README.md')
check('the page names the five tools that take such a path', page.includes('Read, Edit, Write, Grep and Glob take a path on another machine'), page.slice(0, 200))

section('every path the page writes is a path the grammar takes, with the meaning the page gives it')
const written = [...new Set([...page.matchAll(/ssh:\/\/[^\s"'`,)]*/g)].map(found => found[0].replace(/[.;]$/, '')))]
const patterns = written.filter(path => path.includes('*'))
const paths = written.filter(path => !path.includes('*')).map(path => path.replace(':port/', ':2222/'))
const refused = paths.filter(path => typeof parsed(path) === 'string')
check('each of its example paths parses', paths.length >= 10 && refused.length === 0, `${paths.length} paths; ${refused.map(path => `${path} ${parsed(path)}`).join(' | ')}`)
check('ssh:// alone is the host list and names no file', page.includes('`ssh://` alone') && parsed('ssh://') === null, shape('ssh://'))
const MEANINGS: Array<[string, string]> = [
  ['ssh://web1/srv/app/config.yml', '[null,"web1",null,null,"/srv/app/config.yml"]'],
  ['ssh://deploy@web1:2222/var/log/app.log', '["deploy","web1",2222,null,"/var/log/app.log"]'],
  ['ssh://web1/~/notes.md', '[null,"web1",null,"","notes.md"]'],
  ['ssh://host/~name/x', '[null,"host",null,"name","x"]'],
  ['ssh://host', '[null,"host",null,"",""]'],
  ['ssh://[2001:db8::7]:2222/etc/hosts', '[null,"2001:db8::7",2222,null,"/etc/hosts"]'],
]
for (const [path, meaning] of MEANINGS) check(`${path} is on the page and means what the page says`, page.includes(path) && shape(path) === meaning, `${page.includes(path) ? 'on the page' : 'NOT on the page'}; ${shape(path)}`)
check('the three percent forms the page names: a space, a percent sign, a literal tilde', ['%20', '%25', '%7E'].every(form => page.includes(`\`${form}\``)) && shape('ssh://h/a%20b') === '[null,"h",null,null,"/a b"]' && shape('ssh://h/100%25') === '[null,"h",null,null,"/100%"]' && shape('ssh://h/%7Ex') === '[null,"h",null,null,"/~x"]', `${shape('ssh://h/a%20b')} ${shape('ssh://h/100%25')} ${shape('ssh://h/%7Ex')}`)
check('a path written with a password is refused, as the page says', page.includes('A path written with a password is refused') && String(parsed('ssh://deploy:hunter2@web1/x')).startsWith('refused: ') && !String(parsed('ssh://deploy:hunter2@web1/x')).includes('hunter2'), String(parsed('ssh://deploy:hunter2@web1/x')))

section('the rules the page writes decide what the page says they decide')
const block = /```json\n([\s\S]*?)\n```/.exec(page)?.[1] ?? '{}'
const example = ((): { allow: string[]; deny: string[] } => {
  try {
    const guardrails = (JSON.parse(block) as { guardrails?: { allow?: string[]; deny?: string[] } }).guardrails
    return { allow: guardrails?.allow ?? [], deny: guardrails?.deny ?? [] }
  } catch {
    return { allow: [], deny: [] }
  }
})()
check('its example is settings JSON with the rule lists under guardrails, and every pattern on the page is in a rule or a sentence about one', example.allow.length > 0 && example.deny.length > 0 && patterns.length >= 4, `${block} | ${patterns.join(' ')}`)
type Rules = { allow?: string[]; deny?: string[] }
const contextOf = (rules: Rules) =>
  ({
    messages: [],
    options: { engineModel: 'claude-opus-4-8', tools: [] },
    readFileState: createFileStateCacheWithSizeLimit(100),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default', alwaysAllowRules: rules.allow ? { userSettings: rules.allow } : {}, alwaysDenyRules: rules.deny ? { userSettings: rules.deny } : {} } }),
  }) as never
const decide = async (tool: unknown, input: Record<string, unknown>, rules: Rules): Promise<string> => {
  try {
    return ((await (tool as { checkPermissions(input: never, context: never): Promise<{ behavior: string }> }).checkPermissions(input as never, contextOf(rules))) as { behavior: string }).behavior
  } catch (error) {
    return `thrown: ${error instanceof Error ? error.message : String(error)}`
  }
}
const read = (path: string, rules: Rules = example): Promise<string> => decide(FileReadTool, { file_path: path }, rules)
const edit = (path: string, rules: Rules = example): Promise<string> => decide(FileEditTool, { file_path: path, old_string: 'a', new_string: 'b' }, rules)

try {
  if (localTransportUnavailable() !== null) console.log(`  [SKIP] the rules of the page: ${localTransportUnavailable()}, and the ssh configuration is asked through the kit's stand-in`)
  else {
    const world = await remoteWorld('local', 0, { clientHome: HOME })
    const leave = enterWorld(world)
    try {
      check('the allow of its example lets a file on that host be read', (await read('ssh://web1/srv/app/config.yml')) === 'allow', await read('ssh://web1/srv/app/config.yml'))
      check('its deny of a file name on every host refuses that file on the allowed host and on another', (await read('ssh://web1/srv/app/.env')) === 'deny' && (await read('ssh://db1/srv/.env')) === 'deny', `${await read('ssh://web1/srv/app/.env')} ${await read('ssh://db1/srv/.env')}`)
      check('its deny of edits under a folder refuses an edit there and leaves a read allowed', (await edit('ssh://web1/etc/hosts')) === 'deny' && (await read('ssh://web1/etc/hosts')) === 'allow', `${await edit('ssh://web1/etc/hosts')} ${await read('ssh://web1/etc/hosts')}`)
      check('a host its example does not name asks', example.allow.length > 0 && (await read('ssh://db1/etc/hosts')) === 'ask', await read('ssh://db1/etc/hosts'))
      check('a rule that names a host covers every account and port on it, and one that names them covers them only', (await read('ssh://deploy@web1:2222/x')) === 'allow' && (await read('ssh://deploy@web1:2222/x', { allow: ['Read(ssh://deploy@web1:2222/**)'] })) === 'allow' && (await read('ssh://web1/x', { allow: ['Read(ssh://deploy@web1:2222/**)'] })) === 'ask', `${await read('ssh://deploy@web1:2222/x')} ${await read('ssh://web1/x', { allow: ['Read(ssh://deploy@web1:2222/**)'] })}`)
      check('a rule for a local path never matches a remote path: every local file allowed, and a local deny of a file name, leave the remote file to its own rules', page.includes('A rule for a local path never matches a remote path') && (await read('ssh://web1/etc/hosts', { allow: ['Read(//**)', 'Read(**)'] })) === 'ask' && (await read('ssh://web1/srv/.env', { allow: ['Read(ssh://web1/**)'], deny: ['Read(**/.env)', 'Read(//**/.env)'] })) === 'allow', `${await read('ssh://web1/etc/hosts', { allow: ['Read(//**)', 'Read(**)'] })} ${await read('ssh://web1/srv/.env', { allow: ['Read(ssh://web1/**)'], deny: ['Read(**/.env)', 'Read(//**/.env)'] })}`)
      check('the form the page gives for every host covers every host, and the form it warns of covers none', page.includes('`Read(ssh://*/**)` covers every host') && (await read('ssh://db1/etc/hosts', { allow: ['Read(ssh://*/**)'] })) === 'allow' && (await read('ssh://db1/etc/hosts', { allow: ['Read(ssh://**)'] })) === 'ask', `${await read('ssh://db1/etc/hosts', { allow: ['Read(ssh://*/**)'] })} ${await read('ssh://db1/etc/hosts', { allow: ['Read(ssh://**)'] })}`)
    } finally {
      closeRemoteConnections()
      leave()
      await world.stop()
    }
  }
} finally {
  process.chdir(tmpdir())
  removeScratch(launch)
}

console.log(`\nremote page: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)
