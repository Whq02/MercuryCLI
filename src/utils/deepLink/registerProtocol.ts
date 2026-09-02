/**
 * OS protocol-handler identity constants for the deep-link scheme.
 *
 * The registration machinery itself (macOS bundle writer, Linux desktop
 * entry, Windows registry, currency check, auto-registration) is not built
 * in this tree — nothing calls it. This module remains as the identity
 * owner: Mercury registers only its own scheme under its own handler
 * identity and never competes with another tool for the legacy
 * scheme.
 */

export const MACOS_BUNDLE_ID = 'com.mercury.url-handler'
export const APP_NAME = 'Mercury URL Handler'
