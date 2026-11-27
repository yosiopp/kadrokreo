import { useState } from 'react'
import { type CanvasPointer, CanvasView } from '../canvas/CanvasView.tsx'
import type { Camera } from '../canvas/camera.ts'
import { pickNode } from '../canvas/pick.ts'
import type { Asset, AssetId, NodeId, Page } from '../document/types.ts'
import { drawInspectOverlay } from './overlay.ts'
import { drawGuides, drawLayoutGrids } from '../canvas/guideOverlay.ts'

type Props = {
  page: Page
  assets: Record<AssetId, Asset>
  camera: Camera
  selection: readonly NodeId[]
  /** 押した場所のノード。何もない所なら null。additive は Shift を押しながら押したとき（選択に足す・外す） */
  onSelect: (id: NodeId | null, additive: boolean) => void
  /** ダブルクリックした場所のノード。そのフレームを画面いっぱいに表示する */
  onFit: (id: NodeId | null) => void
  /** ページのガイド線を重ねて出すか */
  showGuides?: boolean
  /** フレームのレイアウトグリッドを重ねて出すか */
  showLayoutGrids?: boolean
}

/** viewer のキャンバス。ドラッグは画面の移動で、動かさずに離したときだけ、その場所のものを選ぶ */
export function ViewerCanvas({ page, assets, camera, selection, onSelect, onFit, showGuides = false, showLayoutGrids = false }: Props) {
  // ポインタを重ねているノード。キャンバスに重ねる枠と間隔にしか使わないので、ここで持つ
  // （ポインタを動かすたびに、一覧やパネルまで描き直さないように）
  const [hoverId, setHoverId] = useState<NodeId | null>(null)

  /**
   * ポインタの下で最も手前にあるノード。インスタンスの中身や、ロック中のものも対象にする。
   * ページ直下のフレームは、名前のラベルでも選べる。
   */
  const nodeAt = (pointer: CanvasPointer) =>
    pickNode(page, camera.getViewport(), pointer, { deep: true, locked: true })

  return (
    <CanvasView
      scene={page}
      assets={assets}
      camera={camera}
      panWithPrimaryButton
      cursor="default"
      drawOverlay={(ctx, viewport) => {
        // ガイド線とレイアウトグリッドは、選択の枠や間隔の下に描く
        if (showLayoutGrids) drawLayoutGrids(ctx, viewport, camera.getSize(), page)
        if (showGuides) drawGuides(ctx, viewport, camera.getSize(), page.guides, null)
        drawInspectOverlay(ctx, viewport, page, selection, hoverId)
      }}
      onClick={(pointer) => onSelect(nodeAt(pointer), pointer.shiftKey)}
      onDoubleClick={(pointer) => onFit(nodeAt(pointer))}
      onPointerMove={(pointer) => setHoverId(nodeAt(pointer))}
      onPointerLeave={() => setHoverId(null)}
    />
  )
}
