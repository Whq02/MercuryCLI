import chalk from 'chalk'
import React from 'react'

import { GLYPH } from '../components/mercury-ui/glyphs.js'
import { Text } from '../ink.js'
import {
  getInstructionFiles,
  getLargeMemoryFiles,
  MAX_MEMORY_CHARACTER_COUNT,
} from '../services/instructions/engine.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { getAllowedSettingSources } from '../bootstrap/state.js'
import { getAccountInformation } from './auth.js'
import { getHealthDiagnostic } from './healthDiagnostic.js'
import { formatNumber } from './format.js'
import type { IDEExtensionInstallationStatus } from './ide.js'
import { getIdeClientName, isJetBrainsIde, toIDEDisplayName } from './ide.js'
import {
  getDefaultModelDescription,
  getMainLoopModel,
  modelDisplayString,
} from './model/model.js'
import { getMTLSConfig } from './mtls.js'
import { extraCaCertsStatusLine } from './caCerts.js'
import { checkInstall } from './nativeInstaller/index.js'
import { toTildePath } from './path.js'
import { getProxyUrl } from './proxy.js'
import { familyDisplayName } from '../services/providers/accountSlots.js'
import {
  providerFamilyPresences,
  type ProviderFamilyPresence,
} from '../services/providers/providerUsage.js'
import { activeWalletEntry, walletEntries, type WalletEntry } from '../services/wallet/wallet.js'
import { resolveProviderUsability } from '../services/providers/providerUsability.js'
import type { SettingSource } from './settings/constants.js'
import { SETTING_SOURCES } from './settings/constants.js'
import {
  getManagedFileSettingsPresence,
  getPolicySettingsOrigin,
  getSettingsForSource,
  getSettingsWithErrors,
} from './settings/settings.js'
import type { ThemeName } from './theme.js'


export type Property = {
  label?: string
  value: React.ReactNode | string[]
}

export type Diagnostic = React.ReactNode

export function propertyValueToText(value: React.ReactNode | string[]): string {
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value.join(', ')
  return nodeText(value as React.ReactNode)
}

function nodeText(value: React.ReactNode): string {
  if (value === null || value === undefined || typeof value === 'boolean') return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(nodeText).join('')
  if (React.isValidElement(value)) {
    const children = (value.props as { children?: React.ReactNode }).children
    return nodeText(children)
  }
  return ''
}

const IDE_SERVER_NAME = 'ide'

export function buildIDEProperties(
  mcpClients: MCPServerConnection[],
  ideInstallationStatus: IDEExtensionInstallationStatus | null = null,
  theme: ThemeName,
): Property[] {
  void theme
  const ideClient = mcpClients.find(client => client.name === IDE_SERVER_NAME)

  if (ideInstallationStatus) {
    const integrationWord = isJetBrainsIde(ideInstallationStatus.ideType) ? 'plugin' : 'extension'
    const ideName = toIDEDisplayName(
      typeof ideInstallationStatus.ideType === 'string' ? ideInstallationStatus.ideType : null,
    )
    if (ideInstallationStatus.error) {
      return [
        {
          label: 'IDE',
          value: (
            <Text>
              <Text color="error">{GLYPH.fail}</Text> Failed to install the {ideName} {integrationWord}:{' '}
              {ideInstallationStatus.error}
              {'\n'}Restart your IDE and try again.
            </Text>
          ),
        },
      ]
    }
    if (ideInstallationStatus.installed && ideClient && ideClient.type === 'connected') {
      const serverVersion = (ideClient as { serverInfo?: { version?: string } }).serverInfo?.version
      const versionDiffers =
        serverVersion !== undefined &&
        serverVersion !== null &&
        serverVersion !== ideInstallationStatus.installedVersion
      return [
        {
          label: 'IDE',
          value: (
            <Text>
              Connected to the {ideName} {integrationWord} (version {ideInstallationStatus.installedVersion}
              {versionDiffers ? `; server reports ${serverVersion}` : ''})
            </Text>
          ),
        },
      ]
    }
    if (ideInstallationStatus.installed) {
      return [
        {
          label: 'IDE',
          value: (
            <Text>
              {ideName} {integrationWord} installed
            </Text>
          ),
        },
      ]
    }
    return []
  }

  if (ideClient) {
    const displayName = getIdeClientName(ideClient) ?? 'IDE'
    if (ideClient.type === 'connected') {
      return [{ label: 'IDE', value: <Text>Connected to the {displayName} extension</Text> }]
    }
    return [
      {
        label: 'IDE',
        value: (
          <Text>
            <Text color="error">{GLYPH.fail}</Text> {displayName} extension not connected
          </Text>
        ),
      },
    ]
  }
  return []
}

export function buildMcpProperties(clients: MCPServerConnection[] = [], theme: ThemeName): Property[] {
  void theme
  const servers = clients.filter(client => client.name !== IDE_SERVER_NAME)
  if (servers.length === 0) return []
  let connected = 0
  let needsAuth = 0
  let pending = 0
  let failed = 0
  for (const server of servers) {
    if (server.type === 'connected') connected++
    else if (server.type === 'needs-auth') needsAuth++
    else if (server.type === 'pending') pending++
    else failed++
  }
  const parts: React.ReactNode[] = []
  if (connected > 0) {
    parts.push(
      <Text key="connected" color="success">
        {connected} connected
      </Text>,
    )
  }
  if (needsAuth > 0) {
    parts.push(
      <Text key="needs-auth" color="warning">
        {needsAuth} needs auth
      </Text>,
    )
  }
  if (pending > 0) {
    parts.push(
      <Text key="pending" color="inactive">
        {pending} pending
      </Text>,
    )
  }
  if (failed > 0) {
    parts.push(
      <Text key="failed" color="error">
        {failed} failed
      </Text>,
    )
  }
  return [
    {
      label: 'MCP servers',
      value: (
        <Text>
          {parts.map((part, index) => (
            <React.Fragment key={index}>
              {index > 0 ? ', ' : ''}
              {part}
            </React.Fragment>
          ))}{' '}
          <Text color="inactive">Run /mcp for details</Text>
        </Text>
      ),
    },
  ]
}

export async function buildMemoryDiagnostics(): Promise<Diagnostic[]> {
  const files = await getInstructionFiles()
  return getLargeMemoryFiles(files).map(file => (
    <Text key={file.path}>
      Memory file {toTildePath(file.path)} is large ({formatNumber(file.content.length)} chars {'>'}{' '}
      {formatNumber(MAX_MEMORY_CHARACTER_COUNT)}) and will impact performance
    </Text>
  ))
}

const SOURCE_DISPLAY_NAMES: Record<SettingSource, string> = {
  userSettings: 'User',
  projectSettings: 'Project',
  localSettings: 'Local',
  flagSettings: 'Flag',
  policySettings: 'Managed',
}

export function buildSettingSourcesProperties(): Property[] {
  const allowed = new Set(getAllowedSettingSources())
  const names: string[] = []
  for (const source of SETTING_SOURCES) {
    if (!allowed.has(source)) continue
    const settings = getSettingsForSource(source)
    if (!settings || Object.keys(settings).length === 0) continue
    if (source !== 'policySettings') {
      names.push(SOURCE_DISPLAY_NAMES[source])
      continue
    }
    const origin = getPolicySettingsOrigin()
    if (origin === null) continue
    if (origin === 'file') {
      const presence = getManagedFileSettingsPresence()
      if (presence.hasBase && presence.hasDropIns) names.push('Managed (file + drop-ins)')
      else if (presence.hasDropIns) names.push('Managed (drop-ins)')
      else names.push('Managed (file)')
    } else if (origin === 'remote') {
      names.push('Managed (remote)')
    } else if (origin === 'plist') {
      names.push('Managed (plist)')
    } else if (origin === 'hklm') {
      names.push('Managed (HKLM)')
    } else {
      names.push('Managed (HKCU)')
    }
  }
  return [{ label: 'Setting sources', value: names }]
}

export async function buildInstallationDiagnostics(): Promise<Diagnostic[]> {
  const messages = await checkInstall()
  return messages.map((message, index) => <Text key={index}>{message.message}</Text>)
}

export async function buildInstallationHealthDiagnostics(): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = []
  const { errors } = getSettingsWithErrors()
  if (errors.length > 0) {
    const invalidFiles = [...new Set(errors.map(error => error.file).filter((file): file is string => file !== undefined))]
    diagnostics.push(
      <Text key="invalid-settings">
        Invalid settings files will be ignored: {invalidFiles.join(', ')}
      </Text>,
    )
  }
  const health = await getHealthDiagnostic()
  for (const warning of health.warnings) {
    diagnostics.push(<Text key={warning.issue}>{warning.issue}</Text>)
  }
  if (health.hasUpdatePermissions === false) {
    diagnostics.push(
      <Text key="update-permissions">
        Auto-updates do not have write permission; updating requires elevation
      </Text>,
    )
  }
  return diagnostics
}


export function buildProviderAccountBlocks(
  presences: ProviderFamilyPresence[] = providerFamilyPresences(),
  reads?: {
    entries?: () => WalletEntry[]
    activeFor?: (provider: WalletEntry['provider']) => WalletEntry | undefined
    organization?: () => string | undefined
    isDemo?: boolean
    usability?: () => Partial<Record<string, { blockers: string[] }>>
  },
): Property[] {
  const isDemo = reads?.isDemo ?? Boolean(process.env.IS_DEMO)
  const allEntries = reads?.entries ? reads.entries() : walletEntries()
  let usabilityByFamily: Partial<Record<string, { blockers: string[] }>> = {}
  try {
    usabilityByFamily = reads?.usability ? reads.usability() : resolveProviderUsability()
  } catch {
    usabilityByFamily = {}
  }
  const rows: Property[] = []
  for (const family of presences) {
    const name = familyDisplayName(family.id).toLowerCase()
    const entries = allEntries.filter(e => e.provider === family.id)
    if (!family.credentialed && entries.length === 0) {
      const blocker = usabilityByFamily[family.id]?.blockers?.[0]
      rows.push({
        label: name,
        value: <Text dimColor>{blocker ?? 'not logged in — /logins connects'}</Text>,
      })
      continue
    }
    const active =
      entries.length > 0
        ? (reads?.activeFor ?? activeWalletEntry)(entries[0]!.provider)
        : undefined
    rows.push({
      label: name,
      value: <Text>{family.credentialLabel ?? active?.label ?? entries[0]!.label}</Text>,
    })
    if (active?.identity?.email && !isDemo) {
      rows.push({ label: '', value: <Text dimColor>email · {active.identity.email}</Text> })
    }
    if (active?.identity?.plan) {
      rows.push({ label: '', value: <Text dimColor>plan · {active.identity.plan}</Text> })
    }
    if (family.id === 'anthropic') {
      const organization = reads?.organization
        ? reads.organization()
        : getAccountInformation()?.organization
      if (organization && !isDemo) {
        rows.push({ label: '', value: <Text dimColor>org · {organization}</Text> })
      }
    }
    if (entries.length > 1) {
      const activeText = isDemo ? (active?.kind ?? 'none') : (active?.label ?? 'none')
      rows.push({
        label: '',
        value: (
          <Text dimColor>
            sources · {entries.length} — active: {activeText}
          </Text>
        ),
      })
    }
  }
  return rows
}

export function buildAccountProperties(): Property[] {
  const account = getAccountInformation()
  if (!account) return []
  const properties: Property[] = []
  if (account.subscription) {
    properties.push({ label: 'Login method', value: <Text>{account.subscription} Account</Text> })
  }
  if (account.tokenSource) {
    properties.push({ label: 'Auth token', value: <Text>{account.tokenSource}</Text> })
  }
  if (account.apiKeySource) {
    properties.push({ label: 'API key', value: <Text>{account.apiKeySource}</Text> })
  }
  const isDemo = Boolean(process.env.IS_DEMO)
  if (account.organization && !isDemo) {
    properties.push({ label: 'Organization', value: <Text>{account.organization}</Text> })
  }
  if (account.email && !isDemo) {
    properties.push({ label: 'Email', value: <Text>{account.email}</Text> })
  }
  return properties
}

export function buildAPIProviderProperties(): Property[] {
  const properties: Property[] = []
  if (process.env.ANTHROPIC_BASE_URL) {
    properties.push({ label: 'Anthropic base URL', value: <Text>{process.env.ANTHROPIC_BASE_URL}</Text> })
  }
  const proxyUrl = getProxyUrl()
  if (proxyUrl) {
    properties.push({ label: 'Proxy', value: <Text>{proxyUrl}</Text> })
  }
  if (process.env.NODE_EXTRA_CA_CERTS) {
    properties.push({ label: 'Additional CA cert(s)', value: <Text>{extraCaCertsStatusLine() ?? process.env.NODE_EXTRA_CA_CERTS}</Text> })
  }
  const mtlsConfig = getMTLSConfig()
  if (mtlsConfig) {
    if (mtlsConfig.cert && process.env.MERCURY_CLIENT_CERT) {
      properties.push({ label: 'mTLS client cert', value: <Text>{process.env.MERCURY_CLIENT_CERT}</Text> })
    }
    if (mtlsConfig.key && process.env.MERCURY_CLIENT_KEY) {
      properties.push({ label: 'mTLS client key', value: <Text>{process.env.MERCURY_CLIENT_KEY}</Text> })
    }
  }
  return properties
}

export function getModelDisplayLabel(mainLoopModel: string | null): string {
  if (mainLoopModel === null) {
    return `${chalk.bold('Default')} ${getDefaultModelDescription()}`
  }
  return modelDisplayString(mainLoopModel as never)
}
