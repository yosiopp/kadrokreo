import { Icon } from '../ui/icons.tsx'

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

const ALIGN_SHAPES = {
  left: 'M2.5 2v12M5 4.5h7v2.5H5zM5 9h4v2.5H5z',
  center: 'M8 2v12M4 4.5h8v2.5H4zM5.5 9h5v2.5h-5z',
  right: 'M13.5 2v12M4 4.5h7v2.5H4zM7 9h4v2.5H7z',
  top: 'M2 2.5h12M4.5 5v7H7V5zM9 5v4h2.5V5z',
  middle: 'M2 8h12M4.5 4v8H7V4zM9 5.5v5h2.5v-5z',
  bottom: 'M2 13.5h12M4.5 4v7H7V4zM9 7v4h2.5V7z',
  'distribute-x': 'M2.5 2v12M13.5 2v12M6.5 4.5h3v7h-3z',
  'distribute-y': 'M2 2.5h12M2 13.5h12M4.5 6.5h7v3h-7z',
}

export function AlignIcon({ kind }: { kind: keyof typeof ALIGN_SHAPES }) {
  return (
    <Icon>
      <path d={ALIGN_SHAPES[kind]} />
    </Icon>
  )
}

const TEXT_ALIGN_SHAPES = {
  left: 'M2.5 4h11M2.5 8h7M2.5 12h9',
  center: 'M2.5 4h11M4.5 8h7M3.5 12h9',
  right: 'M2.5 4h11M6.5 8h7M4.5 12h9',
}

export function TextAlignIcon({ align }: { align: keyof typeof TEXT_ALIGN_SHAPES }) {
  return (
    <Icon>
      <path d={TEXT_ALIGN_SHAPES[align]} />
    </Icon>
  )
}

export function DuplicateIcon() {
  return (
    <Icon>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M3.5 10.5h-1v-8h8v1" />
    </Icon>
  )
}

export function TrashIcon() {
  return (
    <Icon>
      <path d="M2.5 4.5h11M6 4.5v-2h4v2M4 4.5l.7 9h6.6l.7-9M6.5 7v4M9.5 7v4" />
    </Icon>
  )
}
