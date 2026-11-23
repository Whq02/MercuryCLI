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
  return nodeText(value)
}

function nodeText(value: React.ReactNode): string {
  if (value === null || value === undefined || typeof value === 'boolean') return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(nodeText).join('')
  if (React.isValidElement<{ children?: React.ReactNode }>(value)) {
    return nodeText(value.props.children)
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
  const isDemo = Boolean(flagEnv('MERCURY_DEMO'))
  const rows: Property[] = []
  if (account.subscription) {
    rows.push({ label: 'Login method', value: `${account.subscription} Account` })
  }
  if (account.tokenSource) {
    rows.push({ label: 'Auth token', value: account.tokenSource })
  }
  if (account.apiKeySource) {
    rows.push({ label: 'API key', value: account.apiKeySource })
  }
  if (account.organization && !isDemo) {
    rows.push({ label: 'Organization', value: account.organization })
  }
  if (account.email && !isDemo) {
    rows.push({ label: 'Email', value: account.email })
  }
  return rows
}

export function buildAPIProviderProperties(): Property[] {
  const rows: Property[] = []
  const baseUrl = hostEnv().ANTHROPIC_BASE_URL
  if (baseUrl) {
    rows.push({ label: 'Anthropic base URL', value: baseUrl })
  }
  const proxyUrl = getProxyUrl()
  if (proxyUrl) {
    rows.push({ label: 'Proxy', value: proxyUrl })
  }
  const extraCaPath = hostEnv().NODE_EXTRA_CA_CERTS
  if (extraCaPath) {
    rows.push({ label: 'Additional CA cert(s)', value: extraCaCertsStatusLine() ?? extraCaPath })
  }
  const mtlsConfig = getMTLSConfig()
  const mtlsErrors = getMTLSReadErrors()
  const certError = mtlsErrors.find(failure => failure.variable === 'MERCURY_CLIENT_CERT')
  const keyError = mtlsErrors.find(failure => failure.variable === 'MERCURY_CLIENT_KEY')
  if (certError) {
    rows.push({ label: 'mTLS client cert', value: mtlsReadFailureSentence(certError) })
  } else if (mtlsConfig?.cert) {
    const certPath = flagEnv('MERCURY_CLIENT_CERT')
    if (certPath) {
      rows.push({ label: 'mTLS client cert', value: certPath })
    }
  }
  if (keyError) {
    rows.push({ label: 'mTLS client key', value: mtlsReadFailureSentence(keyError) })
  } else if (mtlsConfig?.key) {
    const keyPath = flagEnv('MERCURY_CLIENT_KEY')
    if (keyPath) {
      rows.push({ label: 'mTLS client key', value: keyPath })
    }
  }
  return rows
}
