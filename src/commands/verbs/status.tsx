import React from 'react'

import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { getAccountInformation } from '../../models/sign-in/lifecycle/oauthLifecycle.js'

import { getMTLSConfig, getMTLSReadErrors, mtlsReadFailureSentence } from '../../platform/network/mtls.js'
import { extraCaCertsStatusLine } from '../../platform/network/caCerts.js'
import { getProxyUrl } from '../../platform/network/proxy.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'


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
