import * as React from 'react'
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { marked } from 'marked'
import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js'
import { Box, Text, useInput } from '../ink.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { ProductLockup } from './mercury-ui/components.js'
import { branchChip, displayWidth, truncateToWidth } from './mercury-ui/glyphs.js'
import { POPUP_PAGE_HINT, PopupListViewport, popupListMotion, popupListWindow } from './CustomSelect/popup-list.js'
import ScrollBox, { type ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { InkInstanceContext } from '../ink/components/InkInstanceContext.js'
import { Markdown } from './Markdown.js'
import { readFilesMenuMarkdown, FILE_READER_CHUNK_BYTES, type FileReaderDocument } from '../utils/cockpit/filesMenu.js'
import { MenuFilterLine, cutToWidth, foldLead } from './mercury-ui/menuFold.js'
import { decodeNavKey } from './mercury-ui/navSemantics.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { estateGroundBg } from '../utils/mercuryTokens.js'
import { childPath, filterRows, flattenTree, parentPath, sortEntries, type GitMark, type TreeEntry, type TreeRow } from '../utils/files/fileTree.js'
import { readFileTreeGit, type FileTreeGit } from '../utils/files/fileTreeGit.js'

export const FILES_MENU_WIDTH = 70
export const FILES_MENU_CHROME_ROWS = 9
const FILES_MENU_TITLE_VIEW = 'files'
export const FILES_MENU_FILTER_PLACEHOLDER = 'filter by name'
export const FILES_MENU_HINT = '↑↓ move · ↵ open · → ← unfold · / filter · esc or click outside closes'

export { cutToWidth }

function readFolder(root: string, dir: string): TreeEntry[] {
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

function folderLineFor(root: string, git: FileTreeGit | null): string {
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
  const [reader, setReader] = useState<FileReaderDocument | null>(null)
  const [readHint, setReadHint] = useState(false)

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
  const win = popupListWindow(rows.length, cursorIndex, Math.max(1, rowBudget))
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
    if (reader !== null) return
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
    const target = popupListMotion(input, key, cursorIndex, rows.length, Math.max(1, rowBudget))
    if (target !== null) {
      consume()
      setCursor(target)
      setFilterFocus(false)
      setReadHint(false)
      return
    }
    const row = rows[cursorIndex]
    if (input === 'r' && !key.ctrl && !key.meta && !filterFocus) {
      consume()
      if (!pastOpenEvent()) return
      if (row && !row.dir && /\.md$/i.test(row.path)) {
        setReader(readFilesMenuMarkdown(root, row.path))
        setReadHint(false)
      } else setReadHint(true)
      return
    }
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
  const listWidth = inner - (win.above > 0 || win.below > 0 ? 1 : 0)
  const nameWidth = listWidth - markWidth
  const renderRow = (row: TreeRow, index: number): React.ReactNode => {
    const selected = index === cursorIndex
    const indent = '  '.repeat(row.depth)
    const lead = foldLead({ selected, folder: row.dir, open: row.open })
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
        width={listWidth}
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

  if (reader !== null) return <FilesReader document={reader} width={width} rowBudget={rowBudget} onBack={() => setReader(null)} onPick={() => onPick(reader.path)} />

  const readable = !filterFocus && rows[cursorIndex]?.dir === false && /\.md$/i.test(rows[cursorIndex]?.path ?? '')
  const readWords = readable ? 'r read · ' : readHint ? '.md files only · ' : ''
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
      <PopupListViewport above={win.above} below={win.below} rows={Math.max(1, win.end - win.start)}>
        {rows.slice(win.start, win.end).map((row, i) => renderRow(row, win.start + i))}
      </PopupListViewport>
      <Box height={1} />
      <MenuFilterLine focused={filterFocus} text={filter} placeholder={FILES_MENU_FILTER_PLACEHOLDER} accent={accent} muted={tok.textMuted} primary={tok.textPrimary} />
      <Box height={1} width={inner + 1} marginRight={-1}>
        <Text color={tok.textMuted}>{cutToWidth('↑↓ move · ↵ open · → ← unfold · / filter', inner + 1)}</Text>
      </Box>
      <Text color={tok.textMuted} wrap="truncate-end">{readWords}{POPUP_PAGE_HINT} · esc or click outside closes</Text>
    </Box>
  )
}

function FilesReader({ document, width, rowBudget, onBack, onPick }: {
  document: FileReaderDocument
  width: number
  rowBudget: number
  onBack: () => void
  onPick: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const ground = estateGroundBg(tokens)
  const scroll = useRef<ScrollBoxHandle | null>(null)
  const ink = useContext(InkInstanceContext)
  const height = Math.max(1, rowBudget)
  const [view, setView] = useState({ top: 0, total: 0 })
  const sync = useCallback(() => {
    const body = scroll.current
    if (!body) return
    const total = Math.max(0, Math.ceil(body.getFreshScrollHeight()))
    const top = Math.max(0, Math.min(body.getScrollTop(), total - height))
    setView(previous => previous.top === top && previous.total === total ? previous : { top, total })
  }, [height])
  useLayoutEffect(sync)
  useEffect(() => ink?.subscribeFrame(sync), [ink, sync])
  const below = Math.max(0, view.total - view.top - height)
  const contentWidth = Math.max(1, width - 4 - (view.top > 0 || below > 0 ? 1 : 0))
  const content = useMemo(() => {
    const blocks: React.ReactNode[] = []
    let pending = ''
    const flush = () => {
      if (pending.trim()) blocks.push(<Markdown key={blocks.length}>{pending}</Markdown>)
      pending = ''
    }
    for (const token of marked.lexer(document.text)) {
      if (token.type !== 'paragraph' || !token.tokens?.some(part => part.type === 'image')) {
        pending += token.raw
        continue
      }
      for (const part of token.tokens) {
        if (part.type !== 'image') pending += part.raw
        else {
          flush()
          blocks.push(<Text key={blocks.length} wrap="truncate-end">{[part.text, part.href].filter(Boolean).join(' / ').replace(/\s+/g, ' ')}</Text>)
        }
      }
      pending += '\n\n'
    }
    flush()
    return blocks
  }, [document.text])
  useInput((input, key, event) => {
    if (key.escape || key.leftArrow) {
      event.stopImmediatePropagation()
      onBack()
      return
    }
    if (key.return) {
      event.stopImmediatePropagation()
      onPick()
      return
    }
    const maximum = Math.max(0, view.total - height)
    const next = popupListMotion(input, key, view.top, maximum + 1, height)
    if (next !== null) {
      event.stopImmediatePropagation()
      scroll.current?.scrollTo(next)
    }
  })
  const chunk = document.truncated ? ' · first ' + FILE_READER_CHUNK_BYTES / 1024 + ' KiB' : ''
  const position = view.total === 0 ? '0 of 0' : (view.top + 1) + '–' + Math.min(view.total, view.top + height) + ' of ' + view.total
  return (
    <Box flexDirection="column" width={width} flexShrink={0} borderStyle="round" borderColor={tokens.borderStrong} paddingX={1} opaque {...(ground !== undefined ? { backgroundColor: ground } : {})}>
      <ProductLockup view={FILES_MENU_TITLE_VIEW} separator=" · " />
      <Text color={tokens.textMuted} wrap="truncate-end">{truncateToWidth(document.path, Math.max(1, width - 4 - displayWidth(chunk)))}{chunk}</Text>
      <Box height={1} />
      <PopupListViewport above={view.top} below={below} rows={height}>
        <ScrollBox ref={scroll} width={contentWidth} height={height} flexDirection="column">
          {document.error ? <Text color={tokens.warning}>{document.error}</Text> : content.length ? content : <Text dimColor>Empty file</Text>}
        </ScrollBox>
      </PopupListViewport>
      <Box height={1} />
      <Text color={tokens.textMuted} wrap="truncate-end">↑↓ scroll · {POPUP_PAGE_HINT} · {position}</Text>
      <Text color={tokens.textMuted} wrap="truncate-end">r read · ↵ attach · ← back</Text>
    </Box>
  )
}
