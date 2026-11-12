import type { EnterpriseGateway } from '../gatewayTrust.js'
import type { OAuthTokens } from '../../services/oauth/types.js'

export interface SecureStorageData {
  claudeAiOauth?: OAuthTokens
  enterpriseGateway?: EnterpriseGateway
  gatewayTrust?: Record<string, string>
  mcpOAuth?: Record<string, unknown>
  mcpOAuthClientConfig?: Record<string, unknown>
  extensionSecrets?: Record<string, Record<string, string>>
  trustedDeviceToken?: string
}

export interface SecureStorage {
  name: string
  read(): SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): { success: boolean; warning?: string; code?: string }
  delete(): boolean
}

export type ProtectorAnswer = { ok: true; bytes: Buffer } | { ok: false; why: string; final: boolean }

export interface SystemProtector {
  readonly scheme: string
  protect(secret: Buffer): ProtectorAnswer
  unprotect(token: Buffer): ProtectorAnswer
  protectAsync(secret: Buffer): Promise<ProtectorAnswer>
  unprotectAsync(token: Buffer): Promise<ProtectorAnswer>
}
