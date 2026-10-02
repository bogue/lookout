import { useEffect, useRef, useState } from 'react'
import { isTextField, stepPanelWidth } from '../lib/panelwidth'
import { Tip } from './Tip'

type SidePanelApi = { close: () => void } // animated close, shared by the ✕, backdrop, and Esc

type Props = {
  onClose: () => void
  children: (api: SidePanelApi) => React.ReactNode
  initialWidth?: number
  minWidth?: number
  // Esc handler: return true to consume the key (panel stays open, e.g. an inner overlay closes first)
  onEscape?: () => boolean
}

const DEFAULT_MIN = 440
const defaultWidth = () => Math.min(Math.max(window.innerWidth * 0.45, 440), 860)

// Right-side slide-in drawer: backdrop blur, slide transition, Esc-to-close and drag-to-resize width.
// The chrome shared by every panel; callers render their own header/body via the children render-prop.
export const SidePanel = ({ onClose, children, initialWidth, minWidth = DEFAULT_MIN, onEscape }: Props) => {
  const [shown, setShown] = useState(false) // drives slide-in/out + backdrop fade
  const [width, setWidth] = useState(() => initialWidth ?? defaultWidth())
  const resizing = useRef(false)

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const close = () => {
    setShown(false)
    setTimeout(onClose, 220) // let the slide-out finish
  }

  // drag the left edge to resize horizontally
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!resizing.current) return
      const w = window.innerWidth - e.clientX
      setWidth(Math.min(Math.max(w, minWidth), window.innerWidth * 0.9))
    }
    const onUp = () => {
      if (!resizing.current) return
      resizing.current = false
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [minWidth])

  // Cmd+← widens, Cmd+→ narrows — unless a text field has focus (caret navigation)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return
      const dir = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0
      if (!dir || isTextField(document.activeElement)) return
      e.preventDefault()
      setWidth((w) => stepPanelWidth(w, dir, window.innerWidth))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Esc closes the panel, unless the caller consumes it first (e.g. an inner overlay)
  // biome-ignore lint/correctness/useExhaustiveDependencies: close is stable enough for this listener
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (onEscape?.()) return
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onEscape])

  return (
    <>
      <div
        onClick={close}
        className={`fixed inset-0 z-20 cursor-pointer bg-black/30 backdrop-blur-sm transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`}
        aria-hidden="true"
      />
      <div
        style={{ width }}
        className={`fixed inset-y-0 right-0 z-20 flex max-w-[92vw] transform flex-col border-l border-deck-700 bg-deck-900 shadow-2xl transition-transform duration-200 ease-out ${shown ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <Tip label="Drag to resize">
          <button
            type="button"
            aria-label="Resize panel"
            onPointerDown={(e) => {
              e.preventDefault()
              resizing.current = true
              document.body.style.userSelect = 'none'
              document.body.style.cursor = 'col-resize'
            }}
            className="absolute inset-y-0 left-0 z-40 w-1.5 -translate-x-1/2 cursor-col-resize bg-transparent hover:bg-grass-500/40"
          />
        </Tip>
        {children({ close })}
      </div>
    </>
  )
}
