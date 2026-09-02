/**
 * The channel — Mercury's connection primitive, in its own home.
 *
 * Four leaf modules with no imports from the rest of the estate and no
 * room vocabulary in their APIs (the Frame envelope's `room` FIELD is the one
 * deliberate carry-over: it is the on-disk/wire field name, and renaming it
 * re-keys every stored CRC — the next builder re-cuts the envelope by
 * decision, not by drift):
 *
 *   sealedChannel.ts — protocol v3: the token-rooted AEAD handshake + the
 *                      per-direction counter-nonce sealed link
 *   frame.ts         — the envelope + CRC + canonical encoding + decode
 *   hlc.ts           — hybrid logical clock + principal-derived node ids
 *   signing.ts       — frame signing (HMAC today; the authenticated-bytes
 *                      contract other signers reuse)
 */

export {
  SEALED_PROTOCOL_V,
  type SealedKeys,
  type HelloMessage,
  type ChallengeMessage,
  type AuthMessage,
  type BoxMessage,
  type AuthPayload,
  type SealedFailure,
  SealedLink,
  SealedLinkError,
  buildAuth,
  buildChallenge,
  buildHello,
  deriveInviteHint,
  deriveSealedKeys,
  isAuthMessage,
  isBoxMessage,
  isChallengeMessage,
  isHelloMessage,
  isLoopbackHost,
  mintHandshakeNonce,
  openAuthBox,
  parseHandshakeNonce,
} from './sealedChannel.js'

export {
  FRAME_VERSION,
  type Principal,
  type FrameKind,
  type Frame,
  type FrameDraft,
  type FrameDecodeFailure,
  type FrameDecodeResult,
  isFrameKind,
  isFrameKindShape,
  bodyCapForKind,
  bodyCapViolation,
  crc32Hex,
  canonicalFrameJson,
  sealFrame,
  encodeFrameLine,
  decodeFrameLine,
} from './frame.js'

export {
  type HlcState,
  type DecodedHlc,
  createHlcState,
  encodeHlc,
  decodeHlc,
  hlcTick,
  hlcObserve,
  compareHlc,
  sanitizeHlcNode,
  principalNode,
} from './hlc.js'

export {
  OPERATOR_SIG_PREFIX,
  mintSharedSecret,
  authenticatedBytes,
  signFrame,
  verifyFrameSig,
  isOperatorSignedFrame,
  signFrameAsOperator,
  verifyOperatorFrameSig,
} from './signing.js'
