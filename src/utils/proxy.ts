/**
 * Proxy / NO_PROXY resolution, connection budgets, TLS/mTLS wiring, and the
 * AWS client proxy configuration.
 *
 * The explicit API dispatcher replaces the runtime's global connection
 * defaults: the 10-second connect timeout in those defaults was the single
 * largest source of field request failures under a saturated uplink.
 */
import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
// Static, so the bundler inlines undici: a require made through a handle
// built from import.meta.url survives bundling as a runtime lookup beside the
// artifact, where no node_modules exists (BUILD-NOTES.md §undici).
// The one bundled instance serves the dispatcher AND getApiFetch — the
// pairing invariant below.
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher, type Dispatcher } from 'undici'

import { logForDebugging } from './debug.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { apiTimeoutMsOverride } from './envValidation.js'
import { getCACertificates } from './caCerts.js'
import { isEnvTruthy } from './envUtils.js'
import { getMTLSAgent, getMTLSConfig, getTLSFetchOptions } from './mtls.js'

// ---------------------------------------------------------------------------
// Proxy URL + NO_PROXY resolution
// ---------------------------------------------------------------------------

type EnvLike = Record<string, string | undefined>

/** Lowercase wins over uppercase, HTTPS over HTTP. */
export function getProxyUrl(env: EnvLike = process.env): string | undefined {
  return env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || undefined
}

export function getNoProxy(env: EnvLike = process.env): string | undefined {
  return env.no_proxy || env.NO_PROXY || undefined
}

/**
 * Plain NO_PROXY bypass. The wildcard is WHOLE-VALUE: the list bypasses
 * everything only when the entire variable is exactly `*` (a `*` among other
 * entries never matches). That test precedes URL parsing, so it is also the
 * one case where an unparseable URL bypasses.
 */
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

// ---------------------------------------------------------------------------
// CIDR-aware bypass
// ---------------------------------------------------------------------------

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

/** Is `host` inside `cidr`? Malformed input yields false, never throws. */
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

/**
 * The superset bypass matcher: plain bypass first, then CIDR/bare-IP rules
 * (only when the URL host is an IP).
 */
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

// ---------------------------------------------------------------------------
// Transport budgets and the API dispatcher
// ---------------------------------------------------------------------------

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
  // The ONE parser (envValidation) — this site's Number() disagreed with
  // the SDK sites' parseInt on the same spelling, and its `!== 0` guard
  // admitted negatives (TASK-017 S2, api-timeout-ms-three-parsers-no-floor).
  return apiTimeoutMsOverride() ?? 600_000
}

/** A pure read of the resolved budgets. */
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

/** A pure builder so proofs can pin the exact wiring. */
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

/** Constructed once and memoized, from the bundled undici. */
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

/**
 * Runtime pairing invariant: on Node the fetch and the dispatcher must come
 * from the SAME undici instance; under Bun the platform fetch is returned
 * unchanged (its transport ignores dispatchers).
 */
export function getApiFetch(): typeof fetch {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') return fetch
  return undiciFetch as unknown as typeof fetch
}

// ---------------------------------------------------------------------------
// Keep-alive kill switch
// ---------------------------------------------------------------------------

let keepAliveDisabled = false

/** Sticky, process-lifetime: after a stale-pool reset, retries open fresh
 *  connections. */
export function disableKeepAlive(): void {
  keepAliveDisabled = true
  // The actual pool reset. RequestInit.keepalive is the fetch-spec flag, not
  // connection pooling — under undici only a NEW Agent abandons the pooled
  // sockets, so the memoized dispatcher is dropped and the next request
  // builds a fresh pool. The retired agent is abandoned, not close()d:
  // clients built earlier still hold it, and a closing agent would fail
  // their next request mid-flight; its idle sockets self-drain at the
  // keep-alive timeout.
  apiDispatcher = null
}

/** Drop the memoized API dispatcher WITHOUT disabling keep-alive: the next
 *  client build opens a fresh connection pool (keep-alive stays on for it).
 *  The stream-idle watchdog calls this before its reissue and before the
 *  non-streaming fallback — a request that authenticates and then produces
 *  ZERO events can be riding a half-dead pooled socket, and a retry on the
 *  SAME pool parks identically (the GPT→Opus switch-wedge
 *  recurrence shape: every recovery rung hung, a fresh launch worked).
 *  Same abandonment law as disableKeepAlive: the retired agent is never
 *  close()d — earlier clients still hold it; its sockets self-drain. */
export function resetApiConnectionPool(): void {
  apiDispatcher = null
}

export function _resetKeepAliveForTesting(): void {
  keepAliveDisabled = false
}

// ---------------------------------------------------------------------------
// Fetch options selection
// ---------------------------------------------------------------------------

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

/**
 * Select fetch options for a request. `forAnthropicAPI` scopes the
 * unix-socket route: only the provider API client may take the remote-shell
 * auth proxy, whose single fixed upstream would misdeliver any other caller's
 * request. With a proxy: Bun gets the proxy URL plus TLS options, Node the
 * memoized environment-aware proxy dispatcher. With no proxy: Bun gets TLS
 * options only, Node always the explicit API dispatcher.
 */
export function getProxyFetchOptions(opts?: { forAnthropicAPI?: boolean }): Record<string, unknown> {
  const base: Record<string, unknown> = {}
  if (keepAliveDisabled) base.keepalive = false

  const isBun = isBunRuntime()

  if (opts?.forAnthropicAPI === true && isBun) {
    const socket = process.env.ANTHROPIC_UNIX_SOCKET
    if (socket) return { ...base, unix: socket }
  }

  const proxyUrl = getProxyUrl()
  if (proxyUrl) {
    if (isBun) return { ...base, proxy: proxyUrl, ...getTLSFetchOptions() }
    return { ...base, dispatcher: getProxyAgent(proxyUrl) }
  }
  if (isBun) return { ...base, ...getTLSFetchOptions() }
  // Bare Node path carries the API dispatcher (no more global-default ride).
  return { ...base, dispatcher: getApiDispatcher() }
}

// ---------------------------------------------------------------------------
// Address family
// ---------------------------------------------------------------------------

/**
 * Map a requested address family over the DNS lookup-options domain: numeric
 * 0/4/6 pass through, the string `IPv6` maps to 6, `IPv4` and undefined map
 * to 4, anything else throws.
 */
export function getAddressFamily(options: { family?: number | string }): number {
  const family = options.family
  if (family === 0 || family === 4 || family === 6) return family
  if (family === 'IPv6') return 6
  if (family === 'IPv4' || family === undefined) return 4
  throw new Error(`Unsupported address family: ${String(family)}`)
}

// ---------------------------------------------------------------------------
// Agents and axios
// ---------------------------------------------------------------------------

/** The TLS material (mTLS + CA) as connect options, or nothing. */
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

/** The proxy dispatcher's no-proxy list is read UPPERCASE-variable-first —
 *  the OPPOSITE precedence to the shared resolver; inherited and observable
 *  when both spellings differ. */
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

/**
 * A pure builder for the environment-aware proxy dispatcher: both http and
 * https proxies set to the given URI, the same declared budgets as the direct
 * path, TLS material at BOTH the connect level and the tunnel (request-TLS)
 * level — the tunnel level only when TLS material exists.
 */
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

/** Memoized per URI: the ENVIRONMENT-AWARE proxy dispatcher from the bundled
 *  HTTP client library (bundled), which itself honours the no-proxy
 *  list. */
export function getProxyAgent(uri: string): Dispatcher {
  const cached = proxyDispatcherCache.get(uri)
  if (cached !== undefined) return cached
  const agent = new EnvHttpProxyAgent(buildProxyAgentOptions(uri) as never)
  proxyDispatcherCache.set(uri, agent)
  return agent
}

/**
 * The tunnelling agent options: mTLS/CA material folded in, plus — when the
 * proxy-resolves-hosts flag is truthy — a lookup that skips local DNS
 * resolution and hands the hostname to the proxy verbatim, with the address
 * family mapped through the family-mapping helper.
 */
function buildTunnelAgentOptions(extra?: Record<string, unknown>): Record<string, unknown> {
  const options: Record<string, unknown> = { ...(tlsConnectMaterial() ?? {}), ...(extra ?? {}) }
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

/** A tunnelling (CONNECT) HTTPS agent for a proxy URI, mTLS/CA folded in.
 *  Used by websocket proxying, the axios interceptors and the AWS path. */
function createTunnelAgent(uri: string, extra?: Record<string, unknown>): HttpsProxyAgent<string> {
  return new HttpsProxyAgent(uri, buildTunnelAgentOptions(extra) as never)
}

/** The memoized-per-URI tunnelling agent (no per-instance extras). */
function getTunnelAgent(uri: string): HttpsProxyAgent<string> {
  const cached = tunnelAgentCache.get(uri)
  if (cached !== undefined) return cached
  const agent = createTunnelAgent(uri)
  tunnelAgentCache.set(uri, agent)
  return agent
}

/** WebSocket proxy as an agent (Node): the tunnelling factory's agent, or
 *  nothing when no proxy is configured or the URL bypasses. */
export function getWebSocketProxyAgent(url: string): HttpsProxyAgent<string> | undefined {
  const proxyUrl = getProxyUrl()
  if (!proxyUrl || shouldBypassProxy(url)) return undefined
  return getTunnelAgent(proxyUrl)
}

/** WebSocket proxy as a plain URL (Bun's native WebSocket takes a string). */
export function getWebSocketProxyUrl(url: string): string | undefined {
  const proxyUrl = getProxyUrl()
  if (!proxyUrl || shouldBypassProxy(url)) return undefined
  return proxyUrl
}

/**
 * The bypass-aware request interceptor: each request routes to the tunnelling
 * agent, or on bypass to the mTLS agent (https) / direct (http), for BOTH the
 * http and https agents. The bypass test runs on the request's own url field.
 */
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

/**
 * A per-instance axios client with library-level proxying disabled; the
 * optional `extra` is AGENT options merged into the per-instance tunnelling
 * agent's construction (not axios config). With no proxy the mTLS agent is
 * attached when any; with a proxy the bypass-aware interceptor is installed.
 */
export function createAxiosInstance(extra?: Record<string, unknown>): AxiosInstance {
  const instance = axios.create({ proxy: false })
  const proxyUrl = getProxyUrl()
  const mtlsAgent = getMTLSAgent()
  if (!proxyUrl) {
    if (mtlsAgent) instance.defaults.httpsAgent = mtlsAgent
    return instance
  }
  instance.interceptors.request.use(proxyRouteInterceptor(createTunnelAgent(proxyUrl, extra), mtlsAgent))
  return instance
}

let globalInterceptorId: number | null = null

/**
 * Idempotent global reconfiguration: eject any previously installed
 * interceptor and reset the three proxy-related axios defaults first. With a
 * proxy: disable axios' own proxy support (a known library defect), install
 * the bypass-aware interceptor, and set the HTTP library's GLOBAL dispatcher
 * to the environment-aware proxy agent. With no proxy but mTLS: the mTLS
 * agent becomes the axios default AND the mTLS dispatcher the global one.
 */
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

/** Drop memoized proxy agents (both the dispatchers and the tunnels). */
export function clearProxyCache(): void {
  proxyDispatcherCache = new Map()
  tunnelAgentCache = new Map()
  logForDebugging('proxy: cache cleared')
}
