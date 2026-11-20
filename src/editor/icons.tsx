import type { ReactNode } from 'react'
import type { SceneNode } from '../document/types.ts'

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

const EYE = 'M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z'

export function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <Icon>
      <path d={EYE} />
      <circle cx="8" cy="8" r="2" />
      {off && <path d="M2.5 2.5l11 11" />}
    </Icon>
  )
}

export function LockIcon({ open = false }: { open?: boolean }) {
  return (
    <Icon>
      <rect x="3.5" y="7.5" width="9" height="6.5" rx="1" />
      <path d={open ? 'M5.5 7.5V5a2.5 2.5 0 0 1 4.8-1' : 'M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5'} />
    </Icon>
  )
}

export function UndoIcon() {
  return (
    <Icon>
      <path d="M5.5 3.5l-3 3 3 3M2.5 6.5h7a4 4 0 0 1 0 8h-3" />
    </Icon>
  )
}

export function RedoIcon() {
  return (
    <Icon>
      <path d="M10.5 3.5l3 3-3 3M13.5 6.5h-7a4 4 0 0 0 0 8h3" />
    </Icon>
  )
}

const TYPE_SHAPES: Record<SceneNode['type'], ReactNode> = {
  frame: <path d="M5 2v12M11 2v12M2 5h12M2 11h12" />,
  rect: <rect x="2.5" y="3.5" width="11" height="9" />,
  ellipse: <circle cx="8" cy="8" r="5.5" />,
  text: <path d="M3.5 4.5v-2h9v2M8 2.5v11M6 13.5h4" />,
}

export function TypeIcon({ type }: { type: SceneNode['type'] }) {
  return <Icon>{TYPE_SHAPES[type]}</Icon>
}
