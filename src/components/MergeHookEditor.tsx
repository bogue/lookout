import { appendToken } from '../lib/actionlist'
import type { ButtonBoard, MergeHook } from '../types'
import { Section, Switch } from './ActionEditor'
import { CommandTextarea } from './CommandTextarea'
import { Icon } from './Icon'
import { Tip } from './Tip'

type Props = {
  board: ButtonBoard
  hook: MergeHook
  commands: string[] // the user's slash commands, for the prompt autocomplete
  onChange: (p: Partial<MergeHook>, commit: boolean) => void // commit=false while typing, saved on blur
  onBlur: () => void
}

const fieldCls =
  'w-full resize-y rounded border border-deck-600 bg-deck-800 px-2 py-1.5 font-mono text-xs text-deck-200 outline-none placeholder:text-deck-600 focus:border-grass-500'

// The board's merge action, as a chip: dashed, so it never reads as a button the panel shows
export const MergeHookChip = ({ hook }: { hook: MergeHook }) => (
  <span
    className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border border-dashed px-3 py-1.5 text-sm ${
      hook.enabled ? 'border-grass-600 text-grass-300' : 'border-deck-600 text-deck-500'
    }`}
  >
    <Icon name="git-merge" size={14} />
    On merge
  </span>
)

// Edit the merge action: what runs after a merge from Lookout. It can't be deleted, only switched off.
export const MergeHookEditor = ({ board, hook: h, commands, onChange, onBlur }: Props) => (
  <div className="flex flex-col gap-3">
    <Section title="Trigger" aside={<MergeHookChip hook={h} />}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-deck-200">Run after a merge</p>
          <p className="text-xs text-deck-500">
            Right after you merge {board === 'pr' ? 'one of your PRs' : "a review card's PR"} from its panel. A merge
            done on GitHub doesn't run it.
          </p>
        </div>
        <Switch on={h.enabled} label="Run after a merge" onToggle={() => onChange({ enabled: !h.enabled }, true)} />
      </div>
    </Section>

    <Section title="Prompt to Claude">
      <CommandTextarea
        value={h.prompt}
        commands={commands}
        onChange={(v) => onChange({ prompt: v }, false)}
        onBlur={onBlur}
        rows={4}
        placeholder="/clean-worktrees  — or a full prompt. Type / to insert one of your commands."
        className={fieldCls}
      />
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-deck-500">
        Insert
        {[
          { token: '<pr_id>', hint: 'the PR number' },
          { token: '<branch_name>', hint: "the PR's branch" },
        ].map(({ token, hint }) => (
          <Tip key={token} label={`Filled with ${hint} when the action runs`}>
            <button
              type="button"
              onClick={() => onChange({ prompt: appendToken(h.prompt, token) }, true)}
              className="cursor-pointer rounded border border-grass-700/60 bg-grass-600/15 px-1.5 py-0.5 font-mono text-grass-300 hover:bg-grass-600/30"
            >
              {token} +
            </button>
          </Tip>
        ))}
      </div>
      <p className="text-xs text-deck-500">
        Runs in the repo's local clone. What it sent, and its session, shows in the card's history.
      </p>
    </Section>

    <p className="text-xs text-deck-500">
      Every board keeps this one action: it can't be deleted or moved. Switch it off to stop it.
    </p>
  </div>
)
