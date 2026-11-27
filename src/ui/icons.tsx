import type { ReactNode } from 'react'
import type { NodeKind } from '../document/path.ts'

// viewer と editor の両方が使うアイコン。編集でしか使わないものは editor/icons.tsx にある

export function Icon({ children }: { children: ReactNode }) {
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

const TYPE_SHAPES: Record<NodeKind, ReactNode> = {
  frame: <path d="M5 2v12M11 2v12M2 5h12M2 11h12" />,
  rect: <rect x="2.5" y="3.5" width="11" height="9" />,
  ellipse: <circle cx="8" cy="8" r="5.5" />,
  line: <path d="M3 13L13 3" />,
  path: <path d="M2.5 12.5L6 4l4.5 6 3-5.5" />,
  // ブーリアン演算: 重なった 2 つの正方形
  boolean: <path d="M2.5 2.5h7v7h-7zM6.5 6.5h7v7h-7z" />,
  text: <path d="M3.5 4.5v-2h9v2M8 2.5v11M6 13.5h4" />,
  image: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <circle cx="6" cy="6.5" r="1" />
      <path d="M2.5 11l3.5-3 3 2.5 2-1.5 2.5 2" />
    </>
  ),
}

/** role を渡すと、コンポーネントの元（ひし形 4 つ）かインスタンス（ひし形 1 つ）の印にする */
export function TypeIcon({ type, role, mask = false }: { type: NodeKind; role?: 'main' | 'instance'; mask?: boolean }) {
  if (mask) {
    // マスク: 塗った正方形を円でくり抜いた形
    return (
      <Icon>
        <path d="M2.5 2.5h11v11h-11zM8 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z" fill="currentColor" stroke="none" fillRule="evenodd" />
      </Icon>
    )
  }
  if (role === 'main') {
    return (
      <Icon>
        <path d="M8 1.5l2 2-2 2-2-2zM8 10.5l2 2-2 2-2-2zM3.5 6l2 2-2 2-2-2zM12.5 6l2 2-2 2-2-2z" />
      </Icon>
    )
  }
  if (role === 'instance') {
    return (
      <Icon>
        <path d="M8 2l6 6-6 6-6-6z" />
      </Icon>
    )
  }
  return <Icon>{TYPE_SHAPES[type]}</Icon>
}

/** レイアウトグリッドの表示の切り替え（editor と viewer） */
export function LayoutGridIcon() {
  return (
    <Icon>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M5.5 2.5v11M10.5 2.5v11" />
    </Icon>
  )
}

/** ガイド線の表示の切り替え（viewer） */
export function GuidesIcon() {
  return (
    <Icon>
      <path d="M5.5 1.5v13M1.5 10.5h13" />
      <path d="M9.5 4.5h3v3h-3z" />
    </Icon>
  )
}
