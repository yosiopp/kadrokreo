import { useEffect, useRef, useState } from 'react'
import { onImageLoad } from '../canvas/images.ts'
import { renderScene } from '../canvas/render.ts'
import { getNodesBounds, getWorldMatrix } from '../document/geometry.ts'
import type { Asset, AssetId, NodeId, Scene } from '../document/types.ts'

type Props = {
  scene: Scene
  assets: Record<AssetId, Asset>
  nodeId: NodeId
  /** 枠の大きさ（CSS ピクセル）。ノードは縦横比を保って収める */
  width: number
  height: number
}

/**
 * ノード 1 つの小さな見本（一覧のサムネイル）。scene が変わるたびに描き直す（ページは不変なので、変わったときだけ）。
 * 画像は読み込みが済んだら描き直す
 */
export function NodeThumbnail({ scene, assets, nodeId, width, height }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [imageTick, setImageTick] = useState(0)
  useEffect(() => onImageLoad(() => setImageTick((tick) => tick + 1)), [])
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    const bounds = Object.hasOwn(scene.nodes, nodeId) ? getNodesBounds(scene, [nodeId]) : null
    if (!canvas || !ctx || !bounds) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    const zoom = Math.min(width / Math.max(bounds.width, 1), height / Math.max(bounds.height, 1))
    // 余った向きは真ん中に寄せる
    const x = bounds.x - (width / zoom - bounds.width) / 2
    const y = bounds.y - (height / zoom - bounds.height) / 2
    renderScene(ctx, scene, assets, { x, y, zoom }, { width, height }, ratio, {
      labelColor: '#000000',
      labels: false,
      roots: [{ id: nodeId, parent: getWorldMatrix(scene, scene.nodes[nodeId].parentId) }],
    })
  }, [scene, assets, nodeId, width, height, imageTick])
  return <canvas ref={ref} className="node-thumbnail" style={{ width, height }} aria-hidden="true" />
}
