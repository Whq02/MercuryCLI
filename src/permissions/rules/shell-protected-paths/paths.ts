import { protectedPathForms as pathFormsOf, mercurySecretPath as secretPathOf, credentialStorePath as storePathOf, spelling } from '../protectedPaths.js'
import { placedUnder } from '../runtimeProtection.js'
export { spelling }

export const mercurySecretPath = (path: string, cwd?: string): string | null => secretPathOf(placedUnder(path, cwd), cwd)
export const credentialStorePath = (path: string, cwd?: string): string | null => storePathOf(placedUnder(path, cwd), cwd)
export const protectedPathForms = (path: string, cwd?: string): string[] => pathFormsOf(placedUnder(path, cwd), cwd)
