import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js'
import { Box, Text, useInput } from '../ink.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { ProductLockup } from './mercury-ui/components.js'
import { GLYPH, branchChip, displayWidth, truncateToWidth } from './mercury-ui/glyphs.js'
import { paneWindow } from './mercury-ui/geometry.js'
import { decodeNavKey } from './mercury-ui/navSemantics.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { estateGroundBg } from '../utils/mercuryTokens.js'
import { childPath, filterRows, flattenTree, parentPath, sortEntries, type GitMark, type TreeEntry, type TreeRow } from '../utils/files/fileTree.js'
import { readFileTreeGit, type FileTreeGit } from '../utils/files/fileTreeGit.js'

export const FILES_MENU_WIDTH = 70
export const FILES_MENU_CHROME_ROWS = 8
export const FILES_MENU_TITLE_VIEW = 'files'
export const FILES_MENU_FILTER_PLACEHOLDER = 'filter by name'
export const FILES_MENU_HINT = '↑↓ move · ↵ open · → ← unfold · / filter · esc or click outside closes'

export function cutToWidth(text: string, width: number): string {
  if (displayWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = displayWidth(ch)
    if (used + w > width) break
    out += ch
    used += w
  }
  return out
}

export function readFolder(root: string, dir: string): TreeEntry[] {
  try {
    const entries: TreeEntry[] = []
    for (const dirent of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (dirent.name === '.git') continue
      entries.push({ name: dirent.name, path: childPath(dir, dirent.name), dir: dirent.isDirectory() })
    }
    return sortEntries(entries)
  } catch {
    return []
  }
}

export function folderLineFor(root: string, git: FileTreeGit | null): string {
  const name = basename(root).toUpperCase()
  if (git === null) return name
  const chip = git.branch !== '' ? ` · ${branchChip(git.branch)}` : ''
  return `${name}${chip} · ${git.marks.size} changed`
}

type Props = {
  root: string
  width: number
  rowBudget: number
  onClose: () => void
  onPick: (path: string) => void
}

export function MercuryFilesMenu({ root, width, rowBudget, onClose, onPick }: Props): React.ReactNode {
  const token = useRegisterOverlay('files-menu')
  const tok = useMercuryTokens()
  const { accent } = useSessionAccent()
  const pastOpenEvent = useOpenEventGate()
  const [children, setChildren] = useState<Map<string, TreeEntry[]>>(() => new Map([['', readFolder(root, '')]]))
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [cursor, setCursor] = useState(0)
  const [filter, setFilter] = useState('')
  const [filterFocus, setFilterFocus] = useState(false)
  const [git, setGit] = useState<FileTreeGit | null>(null)

  useEffect(() => {
    let alive = true
    void readFileTreeGit(root).then(state => {
      if (alive) setGit(state)
    })
    return () => {
      alive = false
    }
  }, [root])

  const rows = useMemo(() => filterRows(flattenTree(children, open), filter), [children, open, filter])
  const cursorIndex = Math.min(cursor, Math.max(0, rows.length - 1))
  const win = paneWindow(rows.length, cursorIndex, Math.max(1, rowBudget))
  const inner = Math.max(8, width - 4)
  const ground = estateGroundBg(tok)

  const unfold = (row: TreeRow): void => {
    if (!children.has(row.path)) {
      setChildren(previous => {
        const next = new Map(previous)
        next.set(row.path, readFolder(root, row.path))
        return next
      })
    }
    setOpen(previous => new Set(previous).add(row.path))
  }
  const fold = (row: TreeRow): void => {
    setOpen(previous => {
      const next = new Set(previous)
      next.delete(row.path)
      return next
    })
  }
  const activate = (index: number): void => {
    const row = rows[index]
    if (!row) return
    if (row.dir) {
      if (row.open) fold(row)
      else unfold(row)
      return
    }
    onPick(row.path)
  }

  useInput((input, key, event) => {
    const consume = (): void => event.stopImmediatePropagation()
    if (key.escape) {
      if (token !== null && !isTopOverlayNow(token)) return
      consume()
      if (filterFocus || filter !== '') {
        setFilter('')
        setFilterFocus(false)
        return
      }
      onClose()
      return
    }
    const action = decodeNavKey(input, key, { orientation: 'vertical', hierarchy: true })
    if (action === 'movePrevious' || action === 'moveNext') {
      consume()
      const step = action === 'moveNext' ? 1 : -1
      setCursor(Math.max(0, Math.min(rows.length - 1, cursorIndex + step)))
      return
    }
    if (action === 'first') {
      consume()
      setCursor(0)
      return
    }
    if (action === 'last') {
      consume()
      setCursor(Math.max(0, rows.length - 1))
      return
    }
    const row = rows[cursorIndex]
    if (action === 'enterChild') {
      consume()
      if (!row || !row.dir) return
      if (!row.open) {
        unfold(row)
        return
      }
      const next = rows[cursorIndex + 1]
      if (next && next.depth > row.depth) setCursor(cursorIndex + 1)
      return
    }
    if (action === 'leaveChild') {
      consume()
      if (!row) return
      if (row.dir && row.open) {
        fold(row)
        return
      }
      const parent = parentPath(row.path)
      if (parent === '') return
      const parentIndex = rows.findIndex(candidate => candidate.path === parent)
      if (parentIndex !== -1) setCursor(parentIndex)
      return
    }
    if (action === 'activate') {
      consume()
      if (!pastOpenEvent()) return
      activate(cursorIndex)
      return
    }
    if (filterFocus) {
      if (key.backspace || key.delete) {
        consume()
        setFilter(current => current.slice(0, -1))
        return
      }
      if (input !== '' && !key.ctrl && !key.meta && !key.tab) {
        consume()
        if (!pastOpenEvent()) return
        setFilter(current => `${current}${input}`)
        setCursor(0)
      }
      return
    }
    if (input === '/' && !key.ctrl && !key.meta) {
      consume()
      if (!pastOpenEvent()) return
      setFilterFocus(true)
    }
  })

  const markWidth = 2
  const nameWidth = inner - markWidth
  const renderRow = (row: TreeRow, index: number): React.ReactNode => {
    const selected = index === cursorIndex
    const indent = '  '.repeat(row.depth)
    const lead = selected ? `${GLYPH.prompt} ` : row.dir ? (row.open ? '▾ ' : '▸ ') : '  '
    const budget = Math.max(1, nameWidth - displayWidth(indent) - 2)
    const name = truncateToWidth(row.name, budget)
    const pad = ' '.repeat(Math.max(0, budget - displayWidth(name)))
    const mark: GitMark | undefined = row.dir ? undefined : git?.marks.get(row.path)
    return (
      <InteractiveRow
        key={row.path}
        id={`files:row:${row.path}`}
        selected={selected}
        onSelect={() => setCursor(index)}
        onActivate={() => activate(index)}
        width={inner}
        height={1}
      >
        <Text wrap="truncate-end">
          <Text>{indent}</Text>
          <Text color={selected ? accent : tok.textMuted}>{lead}</Text>
          <Text color={selected || row.dir ? tok.textPrimary : tok.textSecondary}>{name}</Text>
          <Text>{pad}</Text>
          <Text color={tok.warning}>{mark ?? ' '}</Text>
          <Text> </Text>
        </Text>
      </InteractiveRow>
    )
  }

  return (
    <Box
      flexDirection="column"
      width={width}
      flexShrink={0}
      borderStyle="round"
      borderColor={tok.borderStrong}
      paddingX={1}
      opaque={true}
      {...(ground !== undefined ? { backgroundColor: ground } : {})}
    >
      <ProductLockup view={FILES_MENU_TITLE_VIEW} separator=" · " />
      <Box height={1}>
        <Text color={tok.textMuted} wrap="truncate-end">{folderLineFor(root, git)}</Text>
      </Box>
      <Box height={1} />
      {rows.slice(win.start, win.end).map((row, i) => renderRow(row, win.start + i))}
      <Box height={1} />
      <Box height={1}>
        <Text wrap="truncate-end">
          <Text color={filterFocus ? accent : tok.textMuted}>/ </Text>
          {filter !== '' ? <Text color={tok.textPrimary}>{filter}</Text> : <Text color={tok.textMuted}>{FILES_MENU_FILTER_PLACEHOLDER}</Text>}
        </Text>
      </Box>
      <Box height={1} width={inner + 1} marginRight={-1}>
        <Text color={tok.textMuted}>{cutToWidth(FILES_MENU_HINT, inner + 1)}</Text>
      </Box>
    </Box>
  )
}
