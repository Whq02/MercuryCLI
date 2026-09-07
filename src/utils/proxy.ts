import axios, { type InternalAxiosRequestConfig } from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher, type Dispatcher } from 'undici'

import { logForDebugging } from './debug.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { apiTimeoutMsOverride } from './envValidation.js'
import { getCACertificates } from './caCerts.js'
import { isEnvTruthy } from './envUtils.js'
import { getMTLSAgent, getMTLSConfig, getTLSFetchOptions } from './mtls.js'


type EnvLike = Record<string, string | undefined>

export function getProxyUrl(env: EnvLike = process.env): string | undefined {
  return env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || undefined
}

export function getNoProxy(env: EnvLike = process.env): string | undefined {
  return env.no_proxy || env.NO_PROXY || undefined
}

export function shouldBypassProxy(url: string, noProxy: string | undefined = getNoProxy()): boolean {
  if (!noProxy || noProxy.trim() === '') return false
  if (noProxy.trim() === '*') return true
  let host: string
  let port: number
  try {
    const parsed = new URL(url)
    host = parsed.hostname.toLowerCase()
    port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return false
  }
  const entries = noProxy
    .split(/[\s,]+/)
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry !== '')
  for (const entry of entries) {
    if (entry.includes(':')) {
      if (entry === `${host}:${port}`) return true
      continue
    }
    if (entry.startsWith('.')) {
      const bare = entry.slice(1)
      if (host === bare || host.endsWith(entry)) return true
      continue
    }
    if (host === entry) return true
  }
  return false
}


type ParsedIp = { bytes: number[]; family: 4 | 6 }

function parseIp(input: string): ParsedIp | null {
  const host = input.replace(/^\[|\]$/g, '')
  if (host.includes(':')) return parseIpv6(host)
  return parseIpv4(host)
}

function parseIpv4(host: string): ParsedIp | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    const value = Number(part)
    if (value < 0 || value > 255) return null
    bytes.push(value)
  }
  return { bytes, family: 4 }
}

function parseIpv6(host: string): ParsedIp | null {
  const [head, tail] = host.split('::')
  const parseGroups = (segment: string): number[] | null => {
    if (segment === '') return []
    const groups: number[] = []
    for (const raw of segment.split(':')) {
      if (raw.includes('.')) {
        const v4 = parseIpv4(raw)
        if (v4 === null) return null
        groups.push((v4.bytes[0] << 8) | v4.bytes[1], (v4.bytes[2] << 8) | v4.bytes[3])
        continue
      }
      if (!/^[0-9a-f]{1,4}$/i.test(raw)) return null
      groups.push(parseInt(raw, 16))
    }
    return groups
  }
  const headGroups = parseGroups(head ?? '')
  if (headGroups === null) return null
  let all: number[]
  if (tail === undefined) {
    if (headGroups.length !== 8) return null
    all = headGroups
  } else {
    const tailGroups = parseGroups(tail)
    if (tailGroups === null) return null
    const fill = 8 - headGroups.length - tailGroups.length
    if (fill < 0) return null
    all = [...headGroups, ...new Array(fill).fill(0), ...tailGroups]
  }
  const bytes: number[] = []
  for (const group of all) {
    bytes.push((group >> 8) & 0xff, group & 0xff)
  }
  return { bytes, family: 6 }
}

export function ipInCidr(host: string, cidr: string): boolean {
  const slash = cidr.lastIndexOf('/')
  const network = slash === -1 ? cidr : cidr.slice(0, slash)
  const parsedHost = parseIp(host)
  const parsedNetwork = parseIp(network)
  if (parsedHost === null || parsedNetwork === null) return false
  if (parsedHost.family !== parsedNetwork.family) return false
  const familyBits = parsedHost.family === 4 ? 32 : 128
  const prefix = slash === -1 ? familyBits : Number(cidr.slice(slash + 1))
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > familyBits) return false
  if (prefix === 0) return true
  let bitsLeft = prefix
  for (let index = 0; index < parsedHost.bytes.length && bitsLeft > 0; index++) {
    const take = Math.min(8, bitsLeft)
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff
    if ((parsedHost.bytes[index] & mask) !== (parsedNetwork.bytes[index] & mask)) return false
    bitsLeft -= take
  }
  return true
}

export function shouldBypassProxyWithCidr(url: string, noProxy: string | undefined): boolean {
  if (shouldBypassProxy(url, noProxy)) return true
  if (!noProxy) return false
  let host: string
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return false
  }
  if (parseIp(host) === null) return false
  const entries = noProxy
    .split(/[\s,]+/)
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry !== '')
  for (const entry of entries) {
    if (entry.includes('/')) {
      if (ipInCidr(host, entry)) return true
      continue
    }
    if (parseIp(entry) !== null && ipInCidr(host, entry)) return true
  }
  return false
}


export type TransportKnobs = {
  connectTimeoutMs: number
  maxConnections: number
  headersTimeoutMs: number
  bodyTimeoutMs: number
  keepAliveTimeoutMs: number
}

function positiveIntFromFlag(name: string, fallback: number): number {
  const raw = flagEnv(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function apiBudgetMs(): number {
  return apiTimeoutMsOverride() ?? 600_000
}

export function resolveTransportKnobs(): TransportKnobs {
  const budget = apiBudgetMs()
  return {
    connectTimeoutMs: positiveIntFromFlag('MERCURY_CONNECT_TIMEOUT_MS', 30_000),
    maxConnections: positiveIntFromFlag('MERCURY_MAX_CONNECTIONS', 16),
    headersTimeoutMs: budget,
    bodyTimeoutMs: budget,
    keepAliveTimeoutMs: 30_000,
  }
}

type AgentOptions = {
  connect: { timeout: number; cert?: string; key?: string; passphrase?: string; ca?: string[] }
  connections: number
  headersTimeout: number
  bodyTimeout: number
  keepAliveTimeout: number
  pipelining: number
}

export function buildApiAgentOptions(): AgentOptions {
  const knobs = resolveTransportKnobs()
  const mtls = getMTLSConfig()
  const ca = getCACertificates()
  return {
    connect: {
      timeout: knobs.connectTimeoutMs,
      ...(mtls?.cert ? { cert: mtls.cert } : {}),
      ...(mtls?.key ? { key: mtls.key } : {}),
      ...(mtls?.passphrase ? { passphrase: mtls.passphrase } : {}),
      ...(ca ? { ca } : {}),
    },
    connections: knobs.maxConnections,
    headersTimeout: knobs.headersTimeoutMs,
    bodyTimeout: knobs.bodyTimeoutMs,
    keepAliveTimeout: knobs.keepAliveTimeoutMs,
    pipelining: 1,
  }
}

let apiDispatcher: Dispatcher | null = null

export function getApiDispatcher(): Dispatcher {
  if (apiDispatcher === null) {
    const options = buildApiAgentOptions()
    apiDispatcher = new Agent(options as never)
    logForDebugging(
      `api dispatcher: connect ${options.connect.timeout}ms · ${options.connections} conns/origin · headers/body ${options.headersTimeout}ms · keep-alive ${options.keepAliveTimeout}ms`,
    )
  }
  return apiDispatcher
}

export function _resetApiDispatcherForTesting(): void {
  apiDispatcher = null
}

export function getApiFetch(): typeof fetch {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') return fetch
  return undiciFetch as unknown as typeof fetch
}


let keepAliveDisabled = false

export function disableKeepAlive(): void {
  keepAliveDisabled = true
  apiDispatcher = null
}

export function resetApiConnectionPool(): void {
  apiDispatcher = null
}

export function _resetKeepAliveForTesting(): void {
  keepAliveDisabled = false
}


function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

export function getProxyFetchOptions(opts?: { forAnthropicAPI?: boolean }): Record<string, unknown> {
  const base: Record<string, unknown> = {}
  if (keepAliveDisabled) base.keepalive = false

  const isBun = isBunRuntime()

  if (opts?.forAnthropicAPI === true && isBun) {
    const socket = process.env.MERCURY_API_UNIX_SOCKET
    if (socket) return { ...base, unix: socket }
  }

  const proxyUrl = getProxyUrl()
  if (proxyUrl) {
    if (isBun) return { ...base, proxy: proxyUrl, ...getTLSFetchOptions() }
    return { ...base, dispatcher: getProxyAgent(proxyUrl) }
  }
  if (isBun) return { ...base, ...getTLSFetchOptions() }
  return { ...base, dispatcher: getApiDispatcher() }
}


export function getAddressFamily(options: { family?: number | string }): number {
  const family = options.family
  if (family === 0 || family === 4 || family === 6) return family
  if (family === 'IPv6') return 6
  if (family === 'IPv4' || family === undefined) return 4
  throw new Error(`Unsupported address family: ${String(family)}`)
}


function tlsConnectMaterial(): Record<string, unknown> | undefined {
  const mtls = getMTLSConfig()
  const ca = getCACertificates()
  if (!mtls && !ca) return undefined
  return {
    ...(mtls?.cert ? { cert: mtls.cert } : {}),
    ...(mtls?.key ? { key: mtls.key } : {}),
    ...(mtls?.passphrase ? { passphrase: mtls.passphrase } : {}),
    ...(ca ? { ca } : {}),
  }
}

function noProxyUppercaseFirst(env: EnvLike = process.env): string | undefined {
  return env.NO_PROXY || env.no_proxy || undefined
}

type ProxyDispatcherOptions = {
  httpProxy: string
  httpsProxy: string
  noProxy?: string
  connect: Record<string, unknown>
  requestTls?: Record<string, unknown>
  connections: number
  headersTimeout: number
  bodyTimeout: number
  keepAliveTimeout: number
  pipelining: number
}

export function buildProxyAgentOptions(uri: string): ProxyDispatcherOptions {
  const knobs = resolveTransportKnobs()
  const tls = tlsConnectMaterial()
  const noProxy = noProxyUppercaseFirst()
  return {
    httpProxy: uri,
    httpsProxy: uri,
    ...(noProxy !== undefined ? { noProxy } : {}),
    connect: { timeout: knobs.connectTimeoutMs, ...(tls ?? {}) },
    ...(tls ? { requestTls: tls } : {}),
    connections: knobs.maxConnections,
    headersTimeout: knobs.headersTimeoutMs,
    bodyTimeout: knobs.bodyTimeoutMs,
    keepAliveTimeout: knobs.keepAliveTimeoutMs,
    pipelining: 1,
  }
}

let proxyDispatcherCache = new Map<string, Dispatcher>()
let tunnelAgentCache = new Map<string, HttpsProxyAgent<string>>()

export function getProxyAgent(uri: string): Dispatcher {
  const cached = proxyDispatcherCache.get(uri)
  if (cached !== undefined) return cached
  const agent = new EnvHttpProxyAgent(buildProxyAgentOptions(uri) as never)
  proxyDispatcherCache.set(uri, agent)
  return agent
}

function buildTunnelAgentOptions(): Record<string, unknown> {
  const options: Record<string, unknown> = { ...(tlsConnectMaterial() ?? {}) }
  if (isEnvTruthy(process.env.MERCURY_PROXY_RESOLVES_HOSTS)) {
    options.lookup = (
      hostname: string,
      lookupOptions: { family?: number | string; all?: boolean },
      callback: (...args: unknown[]) => void,
    ): void => {
      const family = getAddressFamily(lookupOptions)
      if (lookupOptions?.all) callback(null, [{ address: hostname, family }])
      else callback(null, hostname, family)
    }
  }
  return options
}

function createTunnelAgent(uri: string): HttpsProxyAgent<string> {
  return new HttpsProxyAgent(uri, buildTunnelAgentOptions() as never)
}

function getTunnelAgent(uri: string): HttpsProxyAgent<string> {
  const cached = tunnelAgentCache.get(uri)
  if (cached !== undefined) return cached
  const agent = createTunnelAgent(uri)
  tunnelAgentCache.set(uri, agent)
  return agent
}

export function getWebSocketProxyAgent(url: string): HttpsProxyAgent<string> | undefined {
  const proxyUrl = getProxyUrl()
  if (!proxyUrl || shouldBypassProxy(url)) return undefined
  return getTunnelAgent(proxyUrl)
}

export function getWebSocketProxyUrl(url: string): string | undefined {
  const proxyUrl = getProxyUrl()
  if (!proxyUrl || shouldBypassProxy(url)) return undefined
  return proxyUrl
}

function proxyRouteInterceptor(
  tunnel: HttpsProxyAgent<string>,
  mtlsAgent: ReturnType<typeof getMTLSAgent>,
): (config: InternalAxiosRequestConfig) => InternalAxiosRequestConfig {
  return config => {
    const bypass = shouldBypassProxy(config.url ?? '')
    config.httpAgent = bypass ? undefined : tunnel
    config.httpsAgent = bypass ? mtlsAgent : tunnel
    return config
  }
}

let globalInterceptorId: number | null = null

export function configureGlobalAgents(): void {
  if (globalInterceptorId !== null) {
    axios.interceptors.request.eject(globalInterceptorId)
    globalInterceptorId = null
  }
  axios.defaults.proxy = undefined
  axios.defaults.httpAgent = undefined
  axios.defaults.httpsAgent = undefined

  const proxyUrl = getProxyUrl()
  const mtlsAgent = getMTLSAgent()
  if (proxyUrl) {
    axios.defaults.proxy = false
    globalInterceptorId = axios.interceptors.request.use(
      proxyRouteInterceptor(getTunnelAgent(proxyUrl), mtlsAgent),
    )
    setGlobalDispatcher(getProxyAgent(proxyUrl))
    return
  }
  if (mtlsAgent) {
    axios.defaults.httpsAgent = mtlsAgent
    const { dispatcher } = getTLSFetchOptions()
    if (dispatcher) setGlobalDispatcher(dispatcher)
  }
}

export function clearProxyCache(): void {
  proxyDispatcherCache = new Map()
  tunnelAgentCache = new Map()
  logForDebugging('proxy: cache cleared')
}
