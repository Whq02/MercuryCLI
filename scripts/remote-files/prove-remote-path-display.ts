#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join, parse, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import React from 'react'
import { underScratchHome } from './remoteKit.ts'

underScratchHome(import.meta.path)
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { getDisplayPath } = await import('../../src/utils/file.ts')
const { FilePathLink } = await import('../../src/components/FilePathLink.tsx')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}

type Painted = { type: unknown; props: { url?: string; fallback?: unknown; children?: unknown } }
const painted = (filePath: string, children?: string): Painted => FilePathLink(children === undefined ? { filePath } : { filePath, children }) as unknown as Painted
const isLink = (element: Painted): boolean => typeof element.type === 'function' && (element.type as { name: string }).name === 'Link'

const REMOTE = ['ssh://web1/etc/hosts', 'ssh://deploy@web1:2222/~/notes/today.md', 'SSH://Web1/srv/app/', 'ssh://[::1]/var/log/system.log', 'ssh://web1/a%20b/c d.txt', 'ssh://web1']

for (const path of REMOTE) {
  const shown = getDisplayPath(path)
  check(`${path} is displayed as it was written`, shown === path, shown)
}

for (const path of REMOTE) {
  const element = painted(path)
  check(`${path} is painted as words and no link`, element.type === React.Fragment && element.props.url === undefined && element.props.children === path, `${isLink(element) ? `a link to ${element.props.url}` : String(element.type)}`)
}
const labelled = painted('ssh://web1/etc/hosts', 'hosts on web1')
check('the words a caller gives for a remote path are the words painted', labelled.type === React.Fragment && labelled.props.children === 'hosts on web1', String(labelled.props.url))

const inside = join(process.cwd(), 'src', 'utils', 'file.ts')
check('a local file under the working folder is displayed relative to it', getDisplayPath(inside) === join('src', 'utils', 'file.ts'), getDisplayPath(inside))
const elsewhere = join(parse(process.cwd()).root, 'no-such-root-folder', 'file.txt')
check('a local file outside it and outside the home is displayed whole', getDisplayPath(elsewhere) === elsewhere, getDisplayPath(elsewhere))
const underHome = join(homedir(), 'no-such-home-folder', 'file.txt')
const homeShown = getDisplayPath(underHome)
check('a local file under the home is displayed from the tilde', homeShown === `~${sep}no-such-home-folder${sep}file.txt` || homeShown === join('no-such-home-folder', 'file.txt') || !underHome.startsWith(homedir() + sep), homeShown)
const oneSlash = getDisplayPath('ssh:/web1/etc/hosts')
check('a relative path whose first folder is named ssh: stays a local path', oneSlash === join('ssh:', 'web1', 'etc', 'hosts'), oneSlash)

for (const path of [inside, elsewhere]) {
  const element = painted(path)
  check(`${path === inside ? 'a local file under the working folder' : 'a local file elsewhere'} is a link to its file URL with the path as its words`, isLink(element) && element.props.url === pathToFileURL(path).href && element.props.fallback === path && element.props.children === path, `${String(element.props.url)}`)
}
const localLabelled = painted(inside, 'file.ts')
check('the words a caller gives for a local path are the link text and its fallback', isLink(localLabelled) && localLabelled.props.url === pathToFileURL(inside).href && localLabelled.props.fallback === 'file.ts' && localLabelled.props.children === 'file.ts', String(localLabelled.props.url))

console.log(`\nremote path display: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)
