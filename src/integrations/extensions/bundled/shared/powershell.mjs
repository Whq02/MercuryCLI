export function powershellEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
}
