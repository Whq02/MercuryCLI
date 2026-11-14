#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'remote-read-ledger-')))
const project = join(scratch, 'project')
mkdirSync(project, { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BARE = '1'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(project)

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { cacheKeys, cloneFileStateCache, createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { generateFileAttachment, getChangedFiles } = await import('../../src/utils/attachments/fileAttachments.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
const { setCwdState, setOriginalCwd } = await import('../../src/bootstrap/state.ts')
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
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const REMOTE = 'ssh://web1/etc/hosts'
const HOME_FORM = 'ssh://deploy@web1:2222/~/notes/today.md'
const state = (content: string, timestamp = 1_000) => ({ content, timestamp, offset: 0, limit: undefined })
const contextWith = (cache: ReturnType<typeof createFileStateCacheWithSizeLimit>) =>
  ({
    messages: [],
    readFileState: cache,
    abortController: new AbortController(),
    updateFileHistoryState: () => {},
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  }) as never

try {
  section('§1 the key a read is kept under')
  {
    const cache = createFileStateCacheWithSizeLimit(100)
    cache.set(REMOTE, state('127.0.0.1 localhost\n'))
    cache.set(HOME_FORM, state('today\n'))
    check('a remote path is kept under the path itself, both slashes', JSON.stringify(cacheKeys(cache).sort()) === JSON.stringify([REMOTE, HOME_FORM].sort()), JSON.stringify(cacheKeys(cache)))
    check('and is found, known and removed by that path', cache.get(REMOTE)?.content === '127.0.0.1 localhost\n' && cache.has(HOME_FORM) && cache.delete(HOME_FORM) && !cache.has(HOME_FORM) && cache.size === 1)
    check('the one-slash spelling a local path of that look collapses to is another key', cache.get('ssh:/web1/etc/hosts') === undefined && !cache.has(normalize(REMOTE)))
    const copy = cloneFileStateCache(cache)
    check('a copy of the ledger holds it under the same key', JSON.stringify(cacheKeys(copy)) === JSON.stringify([REMOTE]) && copy.get(REMOTE)?.content === '127.0.0.1 localhost\n')
    const local = createFileStateCacheWithSizeLimit(100)
    local.set(join(project, 'src', '..', 'a.txt'), state('a\n'))
    local.set('relative//b.txt', state('b\n'))
    check('a local path is kept normalised, as before', JSON.stringify(cacheKeys(local).sort()) === JSON.stringify([join(project, 'a.txt'), normalize('relative/b.txt')].sort()) && local.get(join(project, '.', 'a.txt'))?.content === 'a\n' && local.has('relative/b.txt'), JSON.stringify(cacheKeys(local)))
  }

  section('§2 the look for files changed between turns')
  {
    const cache = createFileStateCacheWithSizeLimit(100)
    cache.set(REMOTE, state('127.0.0.1 localhost\n'))
    const found = await getChangedFiles(contextWith(cache))
    check('a remote read is not looked for on this disk, and stays in the ledger', found.length === 0 && cache.get(REMOTE)?.content === '127.0.0.1 localhost\n', `${JSON.stringify(found).slice(0, 200)} kept: ${cache.has(REMOTE)}`)
    if (process.platform === 'win32') console.log('  [SKIP] a local file under the one-slash spelling: a folder cannot be named ssh: on Windows')
    else {
      mkdirSync(join(project, 'ssh:', 'web1', 'etc'), { recursive: true })
      writeFileSync(join(project, 'ssh:', 'web1', 'etc', 'hosts'), 'a LOCAL file that happens to stand at the collapsed spelling\n')
      const shadowed = await getChangedFiles(contextWith(cache))
      check('with a local file standing at the collapsed spelling, nothing of it is reported as the remote file changing', shadowed.length === 0 && cache.get(REMOTE)?.content === '127.0.0.1 localhost\n', JSON.stringify(shadowed).slice(0, 300))
    }
    const localFile = join(project, 'watched.txt')
    writeFileSync(localFile, 'one\ntwo\n')
    utimesSync(localFile, new Date(5_000_000), new Date(5_000_000))
    const watched = createFileStateCacheWithSizeLimit(100)
    watched.set(localFile, state('one\n', 1_000))
    const changed = await getChangedFiles(contextWith(watched))
    check('a local file changed since its read is still reported', changed.length === 1 && (changed[0] as { type: string; filename: string }).type === 'edited_text_file' && (changed[0] as { filename: string }).filename === localFile, JSON.stringify(changed).slice(0, 300))
  }

  section('§3 the files read again after a fold, and a mention')
  {
    const context = contextWith(createFileStateCacheWithSizeLimit(100))
    const afterFold = await generateFileAttachment(REMOTE, context, 'compact', { limit: 2000 })
    const mentioned = await generateFileAttachment(REMOTE, context, 'at-mention')
    check('a remote path is not read again after a fold, nor attached by a mention, whatever stands on this disk', afterFold === null && mentioned === null, JSON.stringify(afterFold ?? mentioned).slice(0, 300))
    const localFile = join(project, 'kept.txt')
    writeFileSync(localFile, 'kept\n')
    const local = await generateFileAttachment(localFile, context, 'compact', { limit: 2000 })
    check('a local file is read again after a fold, as before', local !== null && (local as { type: string }).type === 'file' && (local as { filename: string }).filename === localFile, JSON.stringify(local).slice(0, 200))
  }
} finally {
  process.chdir(tmpdir())
  removeScratch(scratch)
}

console.log(`\nremote read ledger: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)
