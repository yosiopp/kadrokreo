import type { SceneNode } from '../document/types.ts'
import { TypeIcon } from './icons.tsx'

// レイヤー一覧の行の先頭に置く部品。editor と viewer の一覧が使う

type CaretProps = {
  node: SceneNode
  open: boolean
  onToggle: () => void
}

/** フレームの中身を開閉する印。中身がなければ、同じ幅の空きにする */
export function LayerCaret({ node, open, onToggle }: CaretProps) {
  if (node.type !== 'frame' || node.children.length === 0) return <span className="layer-caret" />
  return (
    <button
      type="button"
      className="layer-caret"
      aria-label={open ? '閉じる' : '開く'}
      onClick={(event) => {
        // 行を選ぶ操作にしない
        event.stopPropagation()
        onToggle()
      }}
    >
      {open ? '▾' : '▸'}
    </button>
  )
}

/** ノードの種類のアイコン。コンポーネントの元とインスタンスは、その印になる */
export function LayerIcon({ node }: { node: SceneNode }) {
  return (
    <span className="layer-icon">
      <TypeIcon type={node.type} role={node.type === 'frame' ? node.component?.role : undefined} />
    </span>
  )
}
