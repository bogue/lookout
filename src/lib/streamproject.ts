import { Command } from '@tauri-apps/plugin-shell'
import { errText, logWarn } from './log'

// A Stream dump under "All projects" with no #tag: Haiku reads each task and names the watched
// project it belongs to, or says it can't tell. Unsure is a real answer — the item then waits in
// Needs you for me to pick, rather than landing in a project on a coin flip.

const PROMPT = (repos: string[], titles: string[]) => `You file tasks under software projects.
Projects:
${repos.map((r) => `- ${r}`).join('\n')}

For each numbered task, answer the project it clearly belongs to, exactly as listed, or "unsure"
when the task doesn't say (no name, no repo, no product you can map). Never guess between two.
Answer with a JSON array of strings, one per task, in order, and nothing else.

Tasks:
${titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}`

// Haiku's answer → one known project or null per task. Anything off-shape knows nothing.
export const parseProjectGuesses = (text: string, repos: string[], n: number): (string | null)[] => {
  const none = Array<null>(n).fill(null)
  const json = text.replace(/^[\s\S]*?(\[[\s\S]*\])[\s\S]*$/, '$1')
  let answer: unknown
  try {
    answer = JSON.parse(json)
  } catch {
    return none
  }
  if (!Array.isArray(answer) || answer.length !== n) return none
  return answer.map((a) => (typeof a === 'string' && repos.includes(a) ? a : null))
}

export const guessProjects = async (titles: string[], repos: string[]): Promise<(string | null)[]> => {
  if (!titles.length) return []
  const none = titles.map(() => null)
  try {
    const out = await Command.create('claude', [
      '-p',
      PROMPT(repos, titles),
      '--model',
      'haiku',
      '--tools',
      '', // a classification needs no tools
      '--no-session-persistence', // or the guesser's own transcript would show up as a session
    ]).execute()
    if (out.code !== 0) {
      logWarn('stream', `project guess: claude exited ${out.code}: ${out.stderr.trim()}`)
      return none
    }
    return parseProjectGuesses(out.stdout, repos, titles.length)
  } catch (e) {
    logWarn('stream', `project guess: ${errText(e)}`)
    return none
  }
}
