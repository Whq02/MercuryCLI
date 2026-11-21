import React from 'react'

import { flagEnv } from '../substrate/flagRegistry.js'
import { Text } from '../ink.js'
import { getAccountInformation } from '../services/auth/oauthLifecycle.js'

import { getMTLSConfig, getMTLSReadErrors, mtlsReadFailureSentence } from '../utils/mtls.js'
import { extraCaCertsStatusLine } from '../utils/caCerts.js'
import { getProxyUrl } from '../utils/proxy.js'
import { familyDisplayName } from '../services/providers/accountSlots.js'
import {
  presenceIdentityWords,
  providerFamilyPresences,
  type ProviderFamilyPresence,
} from '../services/providers/providerUsage.js'
import { activeWalletEntry, walletEntries, type WalletEntry } from '../services/wallet/wallet.js'
import { resolveProviderUsability } from '../services/providers/providerUsability.js'
import { hostEnv } from '../utils/hostEnv.js'


type Property = {
  label?: string
  value: React.ReactNode | string[]
}

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
  const isDemo = reads?.isDemo ?? Boolean(flagEnv('MERCURY_DEMO'))
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
    const words = isDemo ? family.credentialLabel : presenceIdentityWords(family)
    rows.push({
      label: name,
      value: <Text>{words ?? active?.label ?? entries[0]!.label}</Text>,
    })
    if (!isDemo && family.identity !== undefined && family.credentialLabel !== undefined) {
      rows.push({ label: '', value: <Text dimColor>via · {family.credentialLabel}</Text> })
    } else if (active?.identity?.email && !isDemo) {
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
  const isDemo = Boolean(flagEnv('MERCURY_DEMO'))
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
  if (hostEnv().ANTHROPIC_BASE_URL) {
    properties.push({ label: 'Anthropic base URL', value: <Text>{hostEnv().ANTHROPIC_BASE_URL!}</Text> })
  }
  const proxyUrl = getProxyUrl()
  if (proxyUrl) {
    properties.push({ label: 'Proxy', value: <Text>{proxyUrl}</Text> })
  }
  if (hostEnv().NODE_EXTRA_CA_CERTS) {
    properties.push({ label: 'Additional CA cert(s)', value: <Text>{extraCaCertsStatusLine() ?? hostEnv().NODE_EXTRA_CA_CERTS!}</Text> })
  }
  const mtlsConfig = getMTLSConfig()
  const mtlsErrors = new Map(getMTLSReadErrors().map(failure => [failure.variable, failure]))
  const certErr = mtlsErrors.get('MERCURY_CLIENT_CERT')
  if (certErr !== undefined) {
    properties.push({ label: 'mTLS client cert', value: <Text>{mtlsReadFailureSentence(certErr)}</Text> })
  } else if (mtlsConfig?.cert && flagEnv('MERCURY_CLIENT_CERT')) {
    properties.push({ label: 'mTLS client cert', value: <Text>{flagEnv('MERCURY_CLIENT_CERT')}</Text> })
  }
  const keyErr = mtlsErrors.get('MERCURY_CLIENT_KEY')
  if (keyErr !== undefined) {
    properties.push({ label: 'mTLS client key', value: <Text>{mtlsReadFailureSentence(keyErr)}</Text> })
  } else if (mtlsConfig?.key && flagEnv('MERCURY_CLIENT_KEY')) {
    properties.push({ label: 'mTLS client key', value: <Text>{flagEnv('MERCURY_CLIENT_KEY')}</Text> })
  }
  return properties
}
