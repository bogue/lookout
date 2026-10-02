import { type KeyboardEvent, type RefObject, useRef, useState } from 'react'

type Props = {
  value: string
  commands: string[] // command names without the leading slash
  onChange: (v: string) => void
  onBlur?: () => void
  placeholder?: string
  rows?: number
  className?: string
  disabled?: boolean
  placeholders?: boolean // suggest the prompt placeholders on `<` (button prompts only)
  menuUp?: boolean // open the suggestions above, for a field at the bottom of the screen
  inputRef?: RefObject<HTMLTextAreaElement | null>
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void // keys the open menu didn't take
}

// prompt placeholders filled in at run time (see lib/prompt.ts)
const PLACEHOLDERS = ['pr_id', 'branch_name']

// `/name` (slash command) or `<name` (placeholder) typed at the caret
const COMMAND_RE = /(^|\s)(\/[\w:-]*)$/
const PLACEHOLDER_RE = /(<[\w_]*)$/

type Menu = { kind: 'command' | 'placeholder'; start: number; query: string }

// how each kind renders in the list and inserts into the text
const render = (kind: Menu['kind'], name: string) => (kind === 'command' ? `/${name}` : `<${name}>`)
const insertText = (kind: Menu['kind'], name: string) => (kind === 'command' ? `/${name} ` : `<${name}>`)

const detect = (el: HTMLTextAreaElement, placeholders: boolean): Menu | null => {
  const before = el.value.slice(0, el.selectionStart ?? 0)
  const cmd = before.match(COMMAND_RE)
  if (cmd) return { kind: 'command', start: before.length - cmd[2].length, query: cmd[2].slice(1) }
  if (!placeholders) return null
  const ph = before.match(PLACEHOLDER_RE)
  if (ph) return { kind: 'placeholder', start: before.length - ph[1].length, query: ph[1].slice(1) }
  return null
}

// Textarea that suggests the user's Claude slash-commands while typing `/…` and the prompt
// placeholders while typing `<…`. Arrow keys navigate, Enter/Tab inserts, Esc dismisses.
export const CommandTextarea = ({
  value,
  commands,
  onChange,
  onBlur,
  placeholder,
  rows = 3,
  className,
  disabled,
  placeholders = true,
  menuUp,
  inputRef,
  onKeyDown,
}: Props) => {
  const own = useRef<HTMLTextAreaElement>(null)
  const ref = inputRef ?? own
  const [menu, setMenu] = useState<Menu | null>(null)
  const [active, setActive] = useState(0)

  const q = menu?.query.toLowerCase() ?? ''
  const suggestions = menu
    ? (menu.kind === 'command' ? commands : PLACEHOLDERS)
        .filter((c) => c.toLowerCase().includes(q))
        .sort((a, b) => Number(b.toLowerCase().startsWith(q)) - Number(a.toLowerCase().startsWith(q)))
        .slice(0, 8)
    : []
  const open = suggestions.length > 0

  const refresh = (el: HTMLTextAreaElement) => {
    setMenu(detect(el, placeholders))
    setActive(0)
  }

  const choose = (name: string) => {
    const el = ref.current
    if (!el || !menu) return
    const inserted = insertText(menu.kind, name)
    const next = value.slice(0, menu.start) + inserted + value.slice(el.selectionStart ?? 0)
    onChange(next)
    setMenu(null)
    const pos = menu.start + inserted.length
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        rows={rows}
        onChange={(e) => {
          onChange(e.target.value)
          refresh(e.target)
        }}
        onClick={(e) => refresh(e.currentTarget)}
        onKeyUp={(e) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) refresh(e.currentTarget)
        }}
        onKeyDown={(e) => {
          if (!open) return onKeyDown?.(e)
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => (i + 1) % suggestions.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => (i - 1 + suggestions.length) % suggestions.length)
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            choose(suggestions[active] ?? suggestions[0])
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation() // keep the side panel open — just dismiss the menu
            setMenu(null)
          }
        }}
        onBlur={() => {
          setTimeout(() => setMenu(null), 120) // let a suggestion click register first
          onBlur?.()
        }}
        placeholder={placeholder}
        disabled={disabled}
        className={className}
      />
      {open && menu && (
        <ul
          className={`absolute inset-x-0 z-40 max-h-56 ${menuUp ? 'bottom-full mb-1' : 'top-full mt-1'} overflow-y-auto rounded-md border border-deck-700 bg-deck-800 py-1 shadow-xl`}
        >
          {suggestions.map((name, i) => (
            <li key={name}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(name)
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full cursor-pointer items-center px-3 py-1.5 text-left font-mono text-xs ${
                  i === active ? 'bg-grass-600/25 text-grass-100' : 'text-deck-200 hover:bg-deck-700'
                }`}
              >
                {render(menu.kind, name)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
