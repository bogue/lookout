// Tiny flag parser: enough for `lookout review reviewed --pr 42 --json`, no dependency.
export type Args = {
  path: string[] // positional words, e.g. ['review', 'stage', 'reviewed']
  flags: Record<string, string | true>
}

export const parseArgs = (argv: string[]): Args => {
  const path: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      path.push(a)
      continue
    }
    const [name, inline] = a.slice(2).split('=', 2)
    if (inline !== undefined) flags[name] = inline
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[name] = argv[++i]
    else flags[name] = true
  }
  return { path, flags }
}

export const flagString = (flags: Args['flags'], name: string): string | undefined => {
  const v = flags[name]
  return typeof v === 'string' ? v : undefined
}

export const flagNumber = (flags: Args['flags'], name: string): number | undefined => {
  const v = flagString(flags, name)
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n)) throw new Error(`--${name} expects a number, got "${v}"`)
  return n
}
