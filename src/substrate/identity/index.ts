/**
 * Operator identity — the substrate's answer to "who is the operator".
 *
 * The records that key on it — transcripts' authors, conversation
 * participants, read cursors, the room ACL's owner compares, the keychain's
 * pin-spelling adoption — share this one home.
 */

export type { Principal } from './principal.js'
export {
  operatorPrincipal,
  legacyOperatorPrincipalId,
  legacyOperatorPrincipalIds,
  isLegacyOperatorPrincipalId,
  rawPinOperatorPrincipalId,
  principalIdOwnsRecord,
  assistantPrincipal,
} from './identity.js'
export { type RekeyResult, rekeyLegacyOperatorIds } from './rekey.js'
export {
  type OperatorAccountFact,
  type OperatorAccountFacts,
  type OperatorIdentityView,
  operatorAccountFacts,
  operatorIdentity,
} from './accountFacts.js'
export {
  OPERATOR_KEY_VERSION,
  type OperatorKey,
  type OperatorKeyFileV1,
  operatorKeyPath,
  deriveOperatorIdFromPublicKey,
  ensureOperatorKey,
  operatorKeyId,
  operatorPublicKeyRaw,
  signAsOperator,
  verifyOperatorSignature,
} from './operatorKey.js'
