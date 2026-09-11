import { describe, expect, it } from 'vitest'
import { errText, formatLine, redact } from './log'

describe('redact', () => {
  it('scrubs github tokens', () => {
    expect(redact('gh api failed: bad credentials ghp_abcdefghijklmnopqrstuvwxyz012345')).toBe(
      'gh api failed: bad credentials ***',
    )
    expect(redact('github_pat_11ABCDEFG0abcdefghijklmnop is invalid')).toBe('*** is invalid')
  })

  it('scrubs credentials embedded in a remote url', () => {
    expect(redact('fatal: https://user:ghs_secrettoken@github.com/x/y.git')).toBe(
      'fatal: https://***@github.com/x/y.git',
    )
  })

  it('leaves ordinary output alone', () => {
    expect(redact('gh api repos/TinxHQ/portal-ui/issues/2309/timeline failed: HTTP 403')).toBe(
      'gh api repos/TinxHQ/portal-ui/issues/2309/timeline failed: HTTP 403',
    )
  })
})

describe('formatLine', () => {
  it('writes one padded, scoped line', () => {
    expect(formatLine('2026-09-11T19:32:01.123Z', 'ERROR', 'gh', 'HTTP 403')).toBe(
      '2026-09-11T19:32:01.123Z ERROR [gh] HTTP 403',
    )
    expect(formatLine('2026-09-11T19:32:01.123Z', 'INFO', 'feed', 'ok')).toBe(
      '2026-09-11T19:32:01.123Z INFO  [feed] ok',
    )
  })

  it('folds a multi-line message so one entry stays one line', () => {
    expect(formatLine('2026-09-11T19:32:01.123Z', 'ERROR', 'run', 'boom\n  at spawn\n  at dispatch')).toBe(
      '2026-09-11T19:32:01.123Z ERROR [run] boom ⏎ at spawn ⏎ at dispatch',
    )
  })

  it('redacts the message it writes', () => {
    expect(formatLine('2026-09-11T19:32:01.123Z', 'ERROR', 'gh', 'token ghp_abcdefghijklmnopqrstuvwxyz012345')).toBe(
      '2026-09-11T19:32:01.123Z ERROR [gh] token ***',
    )
  })
})

describe('errText', () => {
  it('reads an Error, a string, and anything else', () => {
    expect(errText(new Error('gh not found'))).toBe('gh not found')
    expect(errText('plain failure')).toBe('plain failure')
    expect(errText({ code: 127 })).toBe('{"code":127}')
    expect(errText(undefined)).toBe('undefined')
  })
})
