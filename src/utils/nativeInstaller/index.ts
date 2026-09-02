/**
 * Native Installer - Public API
 *
 * This barrel is deliberately thin — the
 * surviving surface is the checkInstall stub
 * (startup + /status installation checks — always []) and pidLock.ts,
 * which the plain Doctor screen imports directly.
 */

export { checkInstall, type SetupMessage } from './installer.js'
