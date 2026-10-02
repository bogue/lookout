import * as Tooltip from '@radix-ui/react-tooltip'
import { type CSSProperties, cloneElement, type ReactElement, type ReactNode } from 'react'

// One delay for the whole app: the first tooltip waits, moving to a neighbour shows it at once
export const TipProvider = ({ children }: { children: ReactNode }) => (
  <Tooltip.Provider delayDuration={900} skipDelayDuration={150}>
    {children}
  </Tooltip.Provider>
)

type Props = {
  label: ReactNode // nothing = no tooltip, the child alone
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: ReactElement // must take a ref and pass props on: a DOM element, not a plain component
}

type ChildProps = { disabled?: boolean; className?: string; style?: CSSProperties }

// A disabled button gets no pointer events, so its tip would never open: a span around it takes the
// hover (and keeps the button's disabled cursor) while the button lets pointer events through
const hoverable = (child: ReactElement<ChildProps>) =>
  child.props.disabled ? (
    <span
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users can still reach the reason
      tabIndex={0}
      className={`inline-flex ${child.props.className?.includes('disabled:cursor-not-allowed') ? 'cursor-not-allowed' : 'cursor-default'}`}
    >
      {cloneElement(child, { style: { ...child.props.style, pointerEvents: 'none' } })}
    </span>
  ) : (
    child
  )

// The app's tooltip in place of a native title: the app's darkest green in a chat-like bubble with a tail, glowing a softer green, above the
// element by default, kept on screen
export const Tip = ({ label, side = 'top', children }: Props) =>
  label === undefined || label === null || label === '' ? (
    children
  ) : (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{hoverable(children as ReactElement<ChildProps>)}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="tip z-[1000] max-w-xs rounded-xl border border-deck-800 bg-deck-950 px-2.5 py-[7px] text-xs leading-4 text-grass-100 shadow-[0_2px_12px_#123d27] [overflow-wrap:anywhere]"
        >
          {label}
          <Tooltip.Arrow width={12} height={6} className="fill-deck-950" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
