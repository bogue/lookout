import { invoke } from '@tauri-apps/api/core'
import { getConfig } from './config'

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

// gh and claude output can carry a credential (a remote URL with an embedded token, an env dump in
// a stack trace). The log exists to be pasted into an issue or at Claude, so scrub what we can name.
const SECRETS: [RegExp, string][] = [
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, '***'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '***'],
  [/(\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1***@'], // credentials in a remote url
]

export const redact = (text: string): string => SECRETS.reduce((t, [re, mask]) => t.replace(re, mask), text)

// One entry per line: newlines inside the message are folded so a stack trace can't masquerade as
// several entries when the file is read back.
export const formatLine = (ts: string, level: LogLevel, scope: string, message: string): string =>
  `${ts} ${level.padEnd(5)} [${scope}] ${redact(message).replace(/\s*\n\s*/g, ' ⏎ ')}`.trimEnd()

export const errText = (e: unknown): string => {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e) ?? String(e)
  } catch {
    return String(e)
  }
}

// Cached so a failure inside a tight poll loop doesn't re-read the store on every line. The config
// is read lazily rather than pushed in at startup, so the very first sync is already covered.
let enabled: boolean | null = null
let loading: Promise<boolean> | null = null

const isEnabled = (): Promise<boolean> | boolean => {
  if (enabled !== null) return enabled
  loading ??= (async () => {
    try {
      enabled = (await getConfig()).logging
      return enabled
    } catch {
      loading = null // a transient store failure shouldn't mute the log for the rest of the session
      return false
    }
  })()
  return loading
}

export const setLogEnabled = (on: boolean) => {
  enabled = on
}

const write = async (level: LogLevel, scope: string, message: string) => {
  if (!(await isEnabled())) return
  await invoke('log_append', { line: formatLine(new Date().toISOString(), level, scope, message) }).catch(() => {})
}

// Fire-and-forget on purpose: logging must never change the timing or outcome of what it observes.
const emit = (level: LogLevel, scope: string, message: string) => void write(level, scope, message)

export const logInfo = (scope: string, message: string) => emit('INFO', scope, message)
export const logWarn = (scope: string, message: string) => emit('WARN', scope, message)
export const logError = (scope: string, e: unknown, context?: string) =>
  emit('ERROR', scope, context ? `${context}: ${errText(e)}` : errText(e))

export const logPath = (): Promise<string> => invoke<string>('log_path')
export const clearLog = (): Promise<void> => invoke('log_clear')
