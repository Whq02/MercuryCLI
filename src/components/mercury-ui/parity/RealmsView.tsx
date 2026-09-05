import { execFile } from 'node:child_process'
import { subprocessEnv } from '../../../utils/subprocessEnv.js'
import { homedir } from 'node:os'
import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from '../../../ink.js'
import {
  readRealmRegistry,
  realmGitBranch,
  realmRegistryPath,
  recordRealmLaunchIssued,
  type RealmEntry,
  type RealmLedgerRow,
} from '../../../utils/realmRegistry.js'
import { AMBER, FAINT, IVORY, SECOND, TEAL } from '../../mercuryPalette.js'
import {
  CommandCenter,
  EmptyState,
  SectionHeader,
  StateBadge,
  WarningBanner,
} from '../components.js'
import { GLYPH, padTo, truncateToWidth, branchChip } from '../glyphs.js'
import { useSessionAccent } from '../sessionAccent.js'
import { requestPromptPrefill } from '../../../utils/cockpit/helmFocus.js'
import { useModalOrTerminalSize } from '../../../context/modalContext.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { paneWindow } from '../paneWindow.js'
import { useInteractiveList } from '../useInteractiveList.js'
import { InteractiveRow } from '../InteractiveRow.js'


function ago(iso: string | undefined): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'never'
  const m = Math.max(0, Math.floor((Date.now() - t) / 60000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

function tildify(p: string): string {
  const hd = homedir()
  return p.startsWith(hd) ? `~${p.slice(hd.length)}` || '~' : p
}

function probeGitHubAuth(): Promise<{ authed: boolean; note: string }> {
  return new Promise(resolve => {
    try {
      execFile('gh', ['auth', 'status'], { windowsHide: true, timeout: 5000, env: { ...subprocessEnv() } }, err => {
        if (!err) resolve({ authed: true, note: 'GitHub authenticated (gh)' })
        else if ((err as NodeJS.ErrnoException).code === 'ENOENT')
          resolve({ authed: false, note: 'gh CLI not installed — brew install gh, then gh auth login' })
        else resolve({ authed: false, note: 'GitHub not connected — run: gh auth login' })
      })
    } catch {
      resolve({ authed: false, note: 'GitHub not connected — run: gh auth login' })
    }
  })
}

export function RealmsView({ onClose }: { onClose: () => void }): React.ReactNode {
  const accent = useSessionAccent().accent
  const [snap, setSnap] = useState(readRealmRegistry)
  const realms: RealmEntry[] = snap.realms
  const ledger: RealmLedgerRow[] = snap.ledger

  const prefillAndClose = (text: string): undefined => {
    requestPromptPrefill(text)
    onClose()
    return undefined
  }
  const mountedRef = React.useRef(true)
  React.useEffect(() => () => {
    mountedRef.current = false
  }, [])
  const { selectedIndex: sel, note, hints, rowProps } = useInteractiveList({
    rows: realms,
    rowId: r => r.id,
    idNamespace: 'realms',
    onClose,
    actions: [
      {
        key: 'return',
        hint: 'launch command',
        run: r => {
          if (!r) return 'no realms yet — n starts trusting a folder'
          const res = recordRealmLaunchIssued(r.id)
          setSnap(readRealmRegistry())
          if (!res.ok) return res.reason
          return `run in a new terminal:  ${res.message}`
        },
      },
      {
        key: 'n',
        hint: 'new folder',
        run: () => prefillAndClose('/realms add '),
      },
      {
        key: 'g',
        hint: 'clone GitHub',
        run: () => ({
          pending: 'checking GitHub auth (gh)…',
          result: probeGitHubAuth().then(gh => {
            if (!mountedRef.current) return null
            if (!gh.authed) return gh.note
            return prefillAndClose('/realms clone ')
          }),
        }),
      },
      {
        key: 'backspace',
        hint: 'revoke',
        run: r => {
          if (!r) return 'no realms yet — nothing to revoke'
          return prefillAndClose(`/realms revoke ${r.name} `)
        },
      },
    ],
  })

  const { columns: termCols, rows: termRows } = useTerminalSize()
  const availRows = useModalOrTerminalSize({ rows: termRows, columns: termCols }).rows
  const realmWin = paneWindow(realms.length, sel, Math.max(4, availRows - 21))

  return (
    <CommandCenter view="realms" onClose={onClose} captureInput={false} footer={hints}>
      <Box marginTop={1} flexDirection="column">
        {snap.state === 'unavailable' ? (
          <WarningBanner tone="warn" title="realm registry unreadable" detail={snap.reason ?? 'registry unreadable'} />
        ) : (
          <Text>
            <StateBadge state="live" label="realms launcher" />
            <Text color={FAINT}>
              {' '}· {realms.length === 0 ? 'no realms yet' : `${realms.length} trusted`} · registry {tildify(realmRegistryPath())}
            </Text>
          </Text>
        )}
        <Text color={FAINT}>a realm = a trusted project folder · ↵ hands over the exact launch command</Text>
      </Box>

      <SectionHeader count={realms.length}>Trusted realms</SectionHeader>
      {realms.length === 0 ? (
        <EmptyState
          tone="gated"
          glyph="⦿"
          title="no realms yet"
          hint="/realms add <path> trusts a home-rooted folder · g clones from GitHub"
        />
      ) : (
        <>
          {realmWin.above > 0 ? <Text color={FAINT}>{'  '}↑ {realmWin.above} more</Text> : null}
          {realms.map((r, i) => {
            if (i < realmWin.start || i >= realmWin.end) return null
            const branch = realmGitBranch(r.dir)
            const lane = branch ? branchChip(branch) : 'no git'
            const issued = r.issuedCount ? `${ago(r.lastIssuedAt)}` : 'never entered'
            return (
              <InteractiveRow key={r.id} {...rowProps(r, i)}>
                <Text>
                  <Text color={i === sel ? accent : FAINT}>{i === sel ? '▸ ' : '  '}</Text>
                  <Text color={r.issuedCount ? TEAL : SECOND}>{r.issuedCount ? '●' : '○'} </Text>
                  <Text color={i === sel ? IVORY : SECOND}>{padTo(truncateToWidth(r.name, 16), 17)}</Text>
                  <Text color={SECOND}>{padTo(truncateToWidth(lane, 14), 15)}</Text>
                  <Text color={FAINT}>{truncateToWidth(`last ${issued}`, 20)}</Text>
                </Text>
              </InteractiveRow>
            )
          })}
          {realmWin.below > 0 ? <Text color={FAINT}>{'  '}↓ {realmWin.below} more</Text> : null}
        </>
      )}

      {note ? (
        <Box marginTop={1}>
          <Text>
            <StateBadge state="planned" label="" mono />
            <Text color={AMBER}>{truncateToWidth(note, 76)}</Text>
          </Text>
        </Box>
      ) : null}

      <SectionHeader count={ledger.length}>Launch ledger</SectionHeader>
      {ledger.length === 0 ? (
        <Text color={FAINT}>  no entries yet — trusting or entering a realm records here (durable)</Text>
      ) : (
        ledger.slice(0, 3).map((l, i) => (
          <Text key={i} color={SECOND}>
            {'  '}
            <Text color={FAINT}>{padTo(ago(l.at), 10)}</Text>
            {padTo(truncateToWidth(l.realm, 16), 17)}
            <Text color={FAINT}>{truncateToWidth(l.note, 44)}</Text>
          </Text>
        ))
      )}

      <Box marginTop={1}>
        <Text color={FAINT}>
          revoke never deletes files · realm trust is home-rooted
        </Text>
      </Box>
    </CommandCenter>
  )
}
