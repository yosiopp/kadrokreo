import { describe, expect, it } from 'vitest'
import { hitTest, hitTestFrameLabel } from './hitTest.ts'
import { pathFromPoints } from '../document/path.ts'
import { ellipse, frame, path, rect, sceneOf } from '../document/testNodes.ts'
import type { Scene, SceneNode } from '../document/types.ts'

/** 1 つのノードを差し替えたシーン */
function patched(scene: Scene, node: SceneNode): Scene {
  return { ...scene, nodes: { ...scene.nodes, [node.id]: node } }
}

// フレームの中に、子・入れ子のフレーム・はみ出す子。フレームの外に楕円。後に並ぶものほど手前
function fixture() {
  const outer = frame({ id: 'frame', x: 100, y: 100, width: 200, height: 200, children: ['child', 'inner', 'overflow'] })
  const inner = frame({ id: 'inner', parentId: 'frame', x: 50, y: 50, width: 100, height: 100 })
  const child = rect({ id: 'child', parentId: 'frame', x: 10, y: 10, width: 50, height: 50 })
  const overflow = rect({ id: 'overflow', parentId: 'frame', x: 180, y: 0, width: 100, height: 20 })
  const round = ellipse({ id: 'ellipse', x: 400, y: 100, width: 100, height: 100 })
  const scene = sceneOf(outer, child, inner, overflow, round)
  return { scene, frame: outer, inner, child, overflow, ellipse: round }
}

describe('hitTest', () => {
  it('最も手前・最も深いノードを返す', () => {
    const { scene } = fixture()
    expect(hitTest(scene, { x: 120, y: 120 })).toBe('child')
    // child と inner が重なる位置では、後に並ぶ inner が手前
    expect(hitTest(scene, { x: 155, y: 155 })).toBe('inner')
    expect(hitTest(scene, { x: 110, y: 290 })).toBe('frame')
    expect(hitTest(scene, { x: 50, y: 50 })).toBeNull()
  })

  it('クリップされてはみ出した部分には当たらない', () => {
    const { scene, frame } = fixture()
    expect(hitTest(scene, { x: 290, y: 110 })).toBe('overflow')
    expect(hitTest(scene, { x: 350, y: 110 })).toBeNull()
    expect(hitTest(patched(scene, { ...frame, clipContent: false }), { x: 350, y: 110 })).toBe('overflow')
  })

  it('楕円は外接矩形の角では当たらない', () => {
    const { scene } = fixture()
    expect(hitTest(scene, { x: 450, y: 150 })).toBe('ellipse')
    expect(hitTest(scene, { x: 403, y: 103 })).toBeNull()
  })

  it('直線は線の近くだけで当たる', () => {
    const down = path({ id: 'down', x: 0, y: 0, width: 100, height: 100, strokeWidth: 4 })
    const up = path({ id: 'up', x: 200, y: 0, width: 100, height: 100, points: [{ x: 0, y: 1 }, { x: 1, y: 0 }] })
    const flat = path({ id: 'flat', x: 0, y: 200, width: 100, height: 0 })
    const scene = sceneOf(down, up, flat)

    expect(hitTest(scene, { x: 50, y: 51 })).toBe('down')
    // 枠の中でも、線から離れた角では当たらない
    expect(hitTest(scene, { x: 90, y: 10 }, { tolerance: 3 })).toBeNull()
    expect(hitTest(scene, { x: 290, y: 10 }, { tolerance: 3 })).toBe('up')
    expect(hitTest(scene, { x: 210, y: 10 }, { tolerance: 3 })).toBeNull()
    // 高さ 0 の水平線
    expect(hitTest(scene, { x: 50, y: 202 }, { tolerance: 3 })).toBe('flat')
    expect(hitTest(scene, { x: 50, y: 206 }, { tolerance: 3 })).toBeNull()
    expect(hitTest(scene, { x: 104, y: 200 }, { tolerance: 3 })).toBeNull()
  })

  it('塗った多角形は内側で当たり、へこんだ部分では当たらない', () => {
    // 左上・右上・右下・左下を結ぶ四角形から、上辺の中央を下へ凹ませた形
    const points = [{ x: 0, y: 0 }, { x: 50, y: 60 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]
    const shape = path({ ...pathFromPoints(points, true), closed: true, fills: [{ type: 'solid', color: '#d9d9d9', opacity: 1, visible: true }] })
    const scene = sceneOf(shape)
    expect(hitTest(scene, { x: 50, y: 80 })).toBe('path')
    expect(hitTest(scene, { x: 10, y: 50 })).toBe('path')
    expect(hitTest(scene, { x: 50, y: 20 })).toBeNull()
  })

  it('折れ線は線の近くだけで当たる', () => {
    const scene = sceneOf(path(pathFromPoints([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }])))
    expect(hitTest(scene, { x: 50, y: 2 }, { tolerance: 3 })).toBe('path')
    expect(hitTest(scene, { x: 98, y: 50 }, { tolerance: 3 })).toBe('path')
    // 枠の中でも、線から離れた所や、閉じていない辺では当たらない
    expect(hitTest(scene, { x: 30, y: 60 }, { tolerance: 3 })).toBeNull()
    expect(hitTest(scene, { x: 50, y: 50 }, { tolerance: 3 })).toBeNull()
  })

  it('曲線は曲がった線の近くで当たり、弦の上では当たらない', () => {
    // 0,100 から 100,100 へ、上に膨らむ山形（いちばん上は y = 25）
    const arch = path(
      pathFromPoints([
        { x: 0, y: 100, out: { x: 0, y: 0 } },
        { x: 100, y: 100, in: { x: 100, y: 0 } },
      ]),
    )
    expect(arch).toMatchObject({ y: 25, height: 75 })
    const scene = sceneOf(arch)
    expect(hitTest(scene, { x: 50, y: 26 }, { tolerance: 3 })).toBe('path')
    expect(hitTest(scene, { x: 50, y: 98 }, { tolerance: 3 })).toBeNull()
    // 閉じて塗れば、曲線の内側で当たる
    const filled = sceneOf({ ...arch, closed: true, fills: [{ type: 'solid', color: '#d9d9d9', opacity: 1, visible: true }] })
    expect(hitTest(filled, { x: 50, y: 60 }, { tolerance: 3 })).toBe('path')
    expect(hitTest(filled, { x: 5, y: 30 }, { tolerance: 3 })).toBeNull()
  })

  it('回したノードは、回した後の形で当たる', () => {
    // 200 × 20 の横長を 90° 回すと、中心 (100, 100) の縦長になる
    const scene = sceneOf(rect({ x: 0, y: 90, width: 200, height: 20, rotation: 90 }))
    expect(hitTest(scene, { x: 100, y: 10 })).toBe('rect')
    expect(hitTest(scene, { x: 100, y: 190 })).toBe('rect')
    // 回す前に枠があった場所
    expect(hitTest(scene, { x: 10, y: 100 })).toBeNull()
  })

  it('回したフレームの中の子も、一緒に回った位置で当たる', () => {
    const outer = frame({ x: 0, y: 0, width: 200, height: 100, rotation: 180, children: ['rect'] })
    const scene = sceneOf(outer, rect({ parentId: 'frame', x: 0, y: 0, width: 20, height: 20 }))
    // 左上にあった子は、180° 回って右下へ行く
    expect(hitTest(scene, { x: 190, y: 90 })).toBe('rect')
    expect(hitTest(scene, { x: 10, y: 10 })).toBe('frame')
  })

  it('ロック中・非表示のノードは子も含めて当たらない', () => {
    const { scene, frame, ellipse } = fixture()
    const locked = patched(scene, { ...frame, locked: true })
    expect(hitTest(locked, { x: 120, y: 120 })).toBeNull()
    expect(hitTest(patched(scene, { ...ellipse, visible: false }), { x: 450, y: 150 })).toBeNull()
    // viewer では、ロック中のものも対象にできる
    expect(hitTest(locked, { x: 120, y: 120 }, { locked: true })).toBe('child')
  })

  it('tolerance のぶんだけ外側でも当たる', () => {
    const { scene } = fixture()
    expect(hitTest(scene, { x: 98, y: 150 })).toBeNull()
    expect(hitTest(scene, { x: 98, y: 150 }, { tolerance: 3 })).toBe('frame')
  })
})

describe('hitTestFrameLabel', () => {
  it('ページ直下のフレームの名前ラベルに当たる', () => {
    const { scene } = fixture()
    const viewport = { x: 0, y: 0, zoom: 2 }
    const measure = () => 40
    expect(hitTestFrameLabel(scene, viewport, { x: 210, y: 190 }, measure)).toBe('frame')
    expect(hitTestFrameLabel(scene, viewport, { x: 250, y: 190 }, measure)).toBeNull()
    expect(hitTestFrameLabel(scene, viewport, { x: 210, y: 205 }, measure)).toBeNull()
  })

  it('回したフレームでは、上の辺に沿わせたラベルに当たる', () => {
    const { scene, frame } = fixture()
    const rotated = patched(scene, { ...frame, rotation: 45 })
    const viewport = { x: 0, y: 0, zoom: 1 }
    const measure = () => 40
    // 上の辺の左端は (200, 58.6)。辺に沿って 20、外側へ 9 の所
    expect(hitTestFrameLabel(rotated, viewport, { x: 220.5, y: 66.4 }, measure)).toBe('frame')
    // 囲む矩形の左上（前の置き場所）には当たらない
    expect(hitTestFrameLabel(rotated, viewport, { x: 70, y: 50 }, measure)).toBeNull()
  })
})
