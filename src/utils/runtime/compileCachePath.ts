
export const WIN32_COMPILE_CACHE_DIR_MAX = 200

export function compileCacheDirUsable(dir: string, platform: string = process.platform): boolean {
  if (platform !== 'win32') return true
  if (dir.startsWith('\\\\?\\')) return true
  return dir.length <= WIN32_COMPILE_CACHE_DIR_MAX
}
