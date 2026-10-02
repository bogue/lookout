import { describe, expect, it, vi } from 'vitest'

vi.mock('./claude', () => ({ REVIEW_TOOLS: '', spawnClaude: vi.fn() }))
vi.mock('./log', () => ({ errText: (e: unknown) => String(e), logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }))

import { failRun, getRun } from './runs'

describe('failRun', () => {
  // a chat that could not start must say so in the panel, keeping what was typed
  it('shows the message and why it never ran', () => {
    failRun('a/b#1', 'chat', 'review', '/r', 'still needed?', new Error('no remote'))
    expect(getRun('a/b#1')).toMatchObject({
      status: 'error',
      sessionId: null,
      lines: [
        { kind: 'user', text: 'still needed?' },
        { kind: 'error', text: 'could not start claude: Error: no remote' },
      ],
    })
  })
})
