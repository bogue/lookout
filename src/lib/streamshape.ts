// Shaping: a vague Inbox idea ("automate the weekly release") talked through with a read-only agent.
// It looks at the project, asks me what it needs to know, and once the idea is clear proposes the
// concrete cards to do it. I create them in one click; the idea itself is then done.

// reads the project, never changes it
export const SHAPE_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git diff:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr list:*)',
  'Bash(gh issue view:*)',
  'Bash(gh issue list:*)',
  'Task',
].join(',')

// Denied even when my own Claude settings allow them (deny wins): every write git, gh or the shell
// offer. It also runs in a throwaway worktree (streamrunner.ts shapeCheckout), so anything missed
// here lands on scratch files, not my clone.
const GIT_WRITES = [
  'commit',
  'push',
  'checkout',
  'switch',
  'reset',
  'restore',
  'stash',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'clean',
  'branch',
  'tag',
  'add',
  'rm',
  'mv',
  'worktree',
  'apply',
  'am',
  'fetch',
  'pull',
  'diff --output',
]
const GH_WRITES = [
  'api',
  'pr create',
  'pr merge',
  'pr comment',
  'pr review',
  'pr close',
  'pr edit',
  'pr checkout',
  'issue create',
  'issue comment',
  'issue close',
  'issue edit',
  'release',
  'repo',
  'workflow run',
]
export const SHAPE_DENY = [
  'Edit',
  'Write',
  'NotebookEdit',
  ...GIT_WRITES.map((c) => `Bash(git ${c}:*)`),
  ...GH_WRITES.map((c) => `Bash(gh ${c}:*)`),
  ...['rm', 'mv', 'cp', 'touch', 'mkdir', 'tee', 'pnpm', 'npm', 'npx', 'yarn'].map((c) => `Bash(${c}:*)`),
].join(',')

export const shapePrompt = (item: { title: string; body: string | null; repo: string }) =>
  [
    `I dumped this idea on my Lookout Stream board for the project ${item.repo}:`,
    `"${item.title}"`,
    item.body ? `Notes: ${item.body}` : null,
    `Help me turn it into concrete work. You can read the project and use gh to look around, but change nothing.
1. Look at what exists that's relevant.
2. If anything important is unclear, ask me — a few short, specific questions — and end your turn there.
3. Once it's clear, propose the cards to create: each one a self-contained task an agent can do in its own worktree, in the order they should run. End with this block:

\`\`\`json
{"summary": "<one line>", "cards": [{"title": "<the task, imperative>", "notes": "<what done looks like, files, constraints>"}]}
\`\`\``,
  ]
    .filter(Boolean)
    .join('\n\n')

export type ProposedCard = { title: string; notes: string | null }
export type Proposal = { summary: string; cards: ProposedCard[] }

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

// The cards out of a shaping answer's fenced JSON block (or a bare object); null when it only asked
export const parseProposal = (text: string): Proposal | null => {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
  const raw = fenced?.[1] ?? (text.trim().startsWith('{') ? text.trim() : null)
  if (!raw) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  const o = (v ?? {}) as { summary?: unknown; cards?: unknown }
  const cards = (Array.isArray(o.cards) ? o.cards : []).flatMap((c): ProposedCard[] => {
    const title = str(c?.title, 300)
    return title ? [{ title, notes: str(c?.notes, 4000) }] : []
  })
  return cards.length ? { summary: str(o.summary, 300) ?? '', cards } : null
}

// the proposal still on the table: the last thing in the trail, before I replied to change it
export const proposalOf = (events: { kind: string; text: string | null }[]): Proposal | null => {
  const last = events.filter((e) => e.kind === 'proposal' || e.kind === 'reply' || e.kind === 'result').at(-1)
  return last?.kind === 'proposal' && last.text ? parseProposal(last.text) : null
}
