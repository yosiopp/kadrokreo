import { describe, expect, it } from 'vitest'
import { addRegion, changedRegions, snap } from './dirty.ts'
import { frame, rect, sceneOf } from '../document/testNodes.ts'
import type { Scene, SceneNode } from '../document/types.ts'

/** ラベルの幅を測るだけの、キャンバスの代わり（テキストのノードは使わない） */
const measure = {
  font: '',
  save() {},
  restore() {},
  measureText: () => ({ width: 40 }),
} as unknown as CanvasRenderingContext2D

function patched(scene: Scene, ...nodes: SceneNode[]): Scene {
  return { ...scene, nodes: { ...scene.nodes, ...Object.fromEntries(nodes.map((node) => [node.id, node])) } }
}

// ページ直下にフレーム（切り取らない）と、その中の矩形。フレームの外に矩形
function fixture() {
  const outer = frame({ id: 'frame', x: 100, y: 100, width: 200, height: 200, clipContent: false, children: ['child'] })
  const child = rect({ id: 'child', parentId: 'frame', x: 10, y: 10, width: 50, height: 50 })
  const lone = rect({ id: 'lone', x: 400, y: 100, width: 20, height: 20 })
  return { scene: sceneOf(outer, child, lone), outer, child, lone }
}

const viewport = { x: 0, y: 0, zoom: 1 }
const size = { width: 1000, height: 800 }

describe('changedRegions', () => {
  it('動かしたノードの前と後の範囲（にじみの分を広げる）', () => {
    const { scene, lone } = fixture()
    const next = patched(scene, { ...lone, x: 410 })
    expect(changedRegions(scene, next, viewport, size, 1, measure)).toEqual([{ x: 398, y: 98, width: 34, height: 24 }])
  })

  it('離れた所の変化は別々の範囲、何も変わらなければ空', () => {
    const { scene, child, lone } = fixture()
    const next = patched(scene, { ...lone, y: 120 }, { ...child, x: 20 })
    expect(changedRegions(scene, next, viewport, size, 1, measure)).toHaveLength(2)
    expect(changedRegions(scene, { ...scene }, viewport, size, 1, measure)).toEqual([])
  })

  it('フレームを動かすと、はみ出しうる子孫とラベルも含める', () => {
    const { scene, outer, child } = fixture()
    const wide = patched(scene, { ...child, x: 300, width: 100 })
    const next = patched(wide, { ...outer, x: 110 })
    const regions = changedRegions(wide, next, viewport, size, 1, measure)!
    const covers = (x: number, y: number) => regions.some((r) => r.x <= x && x <= r.x + r.width && r.y <= y && y <= r.y + r.height)
    // 子は 400〜510 まで、ラベルはフレームの上 18px
    expect(covers(510, 115)).toBe(true)
    expect(covers(105, 100 - 18)).toBe(true)
  })

  it('並びが変わった・広すぎる・ぼかしがあるときは全部を描く（null）', () => {
    const { scene, lone } = fixture()
    expect(changedRegions(scene, { ...scene, rootIds: [...scene.rootIds].reverse() }, viewport, size, 1, measure)).toBeNull()
    expect(changedRegions(scene, patched(scene, { ...lone, x: 0, y: 0, width: 990, height: 790 }), viewport, size, 1, measure)).toBeNull()
    const blurred = patched(scene, { ...lone, effects: [{ type: 'layer-blur', blur: 4, visible: true }] })
    expect(changedRegions(blurred, patched(blurred, { ...blurred.nodes.lone, x: 401 } as SceneNode), viewport, size, 1, measure)).toBeNull()
  })

  it('画面の外の変化は空', () => {
    const { scene, lone } = fixture()
    expect(changedRegions(scene, patched(scene, { ...lone, x: 5000 }), { x: 2000, y: 0, zoom: 1 }, size, 1, measure)).toEqual([])
  })
})

describe('snap', () => {
  const screen = { x: 0, y: 0, width: 100, height: 100 }
  it('実ピクセルの境目に外向きに揃え、画面に収める', () => {
    expect(snap({ x: 10.3, y: 20.6, width: 5, height: 5 }, 2, screen)).toEqual({ x: 8, y: 18.5, width: 9.5, height: 9.5 })
    expect(snap({ x: 95, y: -10, width: 20, height: 20 }, 1, screen)).toEqual({ x: 93, y: 0, width: 7, height: 12 })
    expect(snap({ x: 200, y: 0, width: 5, height: 5 }, 1, screen)).toBeNull()
  })
})

describe('addRegion', () => {
  it('重なる範囲は囲んでまとめる（まとめた結果がまた重なればさらにまとめる）', () => {
    const regions = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 30, y: 0, width: 10, height: 10 },
    ]
    addRegion(regions, { x: 5, y: 0, width: 30, height: 5 })
    expect(regions).toEqual([{ x: 0, y: 0, width: 40, height: 10 }])
  })
})
