// A chat typed into a card's panel. Lookout writes its opening line and reads it back out of the
// transcript, so the chat belongs to its PR by what it says, not by which checkout it ran in or
// which branch that checkout happened to be on.
export const CHAT_COMMAND = 'chat' // the run's label: a chat's answer is never saved as a report

export const chatPrompt = (prNumber: number, repo: string, branch: string, text: string) =>
  `About PR #${prNumber} in ${repo} (branch ${branch}):\n\n${text}`

// `[^)]*` also takes the older "(branch x, checked out here)" wording
const OPENING_RE = /^About PR #(\d+) in \S+ \(branch ([^\s,)]+)[^)]*\):\n\n([\s\S]*)$/
const QUESTION_MAX = 80

export const parseChatPrompt = (prompt: string): { prNumber: number; branch: string; question: string } | null => {
  const m = prompt.match(OPENING_RE)
  if (!m) return null
  const first = [...(m[3].trim().split('\n')[0] ?? '')] // by code point: never split an emoji
  const question = first.length > QUESTION_MAX ? `${first.slice(0, QUESTION_MAX).join('')}…` : first.join('')
  return { prNumber: Number(m[1]), branch: m[2], question }
}
