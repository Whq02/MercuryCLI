// =============================================================================
// secureStorage/types.ts — the shared SecureStorage contract
//
// A type-only module with no on-disk source resolves to the
// build's empty gated stub, so `SecureStorageData` was effectively `any`. It is
// reconstructed here as a real, honest interface so the storage backends
// (keychain / plaintext / fallback) and the auth + gateway-trust layers share a
// typed shape. Type-only: stripped at build, zero runtime cost.
// =============================================================================

import type { EnterpriseGateway } from '../gatewayTrust.js'
import type { OAuthTokens } from '../../services/oauth/types.js'

/**
 * The decrypted contents of the credential store (`.credentials.json` /
 * keychain blob). All fields optional — a fresh install has none.
 */
export interface SecureStorageData {
  /** The active claude.ai OAuth tokens (access/refresh/expiry/scopes/sub). */
  claudeAiOauth?: OAuthTokens
  /**
   * A stored enterprise cloud-gateway session. DORMANT: nothing in Mercury
   * writes this today; present so the gateway-trust restore path is typed and
   * future-proof. See utils/gatewayTrust.ts.
   */
  enterpriseGateway?: EnterpriseGateway
  /**
   * Pinned TLS fingerprints for enterprise gateways: host -> sha256 fingerprint
   * (lowercase hex, no colons). Pin-on-first-trust; verified on restore. Also
   * dormant today. See utils/gatewayTrust.ts.
   */
  gatewayTrust?: Record<string, string>
  // --- MCP / extension credential maps (keyed by server-key or extension id) ---
  // The per-entry credential blobs are dynamically shaped (OAuth client
  // id/secret + tokens, IDP configs, extension option secrets), so the value type
  // is left open. Reconstructed from the consumers in services/mcp/auth.ts,
  // mcp/xaaIdpLogin.ts and extensions/options.ts — the original
  // field types are typed here. Type-only, zero runtime cost.
  /** Per-MCP-server OAuth state (clientId/clientSecret + access/refresh tokens). */
  mcpOAuth?: Record<string, any>
  /** Per-MCP-server OAuth dynamic-client-registration config. */
  mcpOAuthClientConfig?: Record<string, any>
  /** Per-MCP-server cross-account IDP session data. */
  mcpXaaIdp?: Record<string, any>
  /** Per-MCP-server cross-account IDP config. */
  mcpXaaIdpConfig?: Record<string, any>
  /** Per-extension stored secrets (extension id -> option key -> value). */
  extensionSecrets?: Record<string, Record<string, string>>
  /** Bridge trusted-device token (device-bound auth for peer sessions). */
  trustedDeviceToken?: string
}

/**
 * Pluggable credential backend (macOS keychain, plaintext file, or a
 * primary-with-fallback composite). Sync + async read variants; the async
 * variants avoid blocking on a keychain `security` subprocess.
 */
export interface SecureStorage {
  /** Backend name (for telemetry / fallback composition). */
  name: string
  /** Synchronous read. Returns null on miss / unreadable store. */
  read(): SecureStorageData | null
  /** Asynchronous read. Returns null on miss / unreadable store. */
  readAsync(): Promise<SecureStorageData | null>
  /** Replace the stored data. `success` is false if the write failed (or was
   *  refused because the existing store could not be read — a one-field
   *  rewrite over a failed read would drop every other credential). `code`
   *  carries the errno class when the store could name one, so a caller can
   *  tell a refused write from a corrupt store. */
  update(data: SecureStorageData): { success: boolean; warning?: string; code?: string }
  /** Delete the entire store. Returns true on success (or already-absent). */
  delete(): boolean
}
