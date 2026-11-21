import { describe, expect, it } from 'vitest'
import { getAbsoluteBounds, getCorners, getWorldCenter, getWorldRotation } from '../../document/geometry.ts'
import { createFrame, createLine, createRect, createText } from '../nodes.ts'
import { alignNodes } from './arrange.ts'
import { copyFragment, pasteFragment } from './clipboard.ts'
import { createPage } from './document.ts'
import { reshapeNode, resizeNodes, rotateNodes, translateNodes } from './transform.ts'
import { insertNode, moveNode, topLevelIds } from './tree.ts'

const bounds = { x: 0, y: 0, width: 100, height: 100 }

function fixture() {
  const frame = createFrame({ x: 100, y: 50, width: 400, height: 300 })
  const inner = createFrame({ x: 20, y: 10, width: 200, height: 100 })
  const rect = createRect({ x: 5, y: 5, width: 10, height: 10 })
  const loose = createRect({ ...bounds, x: 900 })
  let doc = createPage()
  doc = insertNode(doc, frame)
  doc = insertNode(doc, inner, frame.id)
  doc = insertNode(doc, rect, inner.id)
  doc = insertNode(doc, loose)
  return { doc, frame, inner, rect, loose }
}

describe('translateNodes', () => {
  it('親子を一緒に指定しても子が二重に動かない', () => {
    const { doc, frame, rect } = fixture()
    expect(topLevelIds(doc, [rect.id, frame.id, 'missing'])).toEqual([frame.id])

    const next = translateNodes(doc, [frame.id, rect.id], 10, -5)
    expect(next.nodes[frame.id]).toMatchObject({ x: 110, y: 45 })
    expect(next.nodes[rect.id]).toMatchObject({ x: 5, y: 5 })
    expect(translateNodes(doc, [frame.id], 0, 0)).toBe(doc)
  })
})

describe('resizeNodes', () => {
  it('選択範囲に合わせて位置と大きさを拡大縮小する', () => {
    const a = createRect({ x: 0, y: 0, width: 100, height: 100 })
    const b = createRect({ x: 100, y: 100, width: 100, height: 100 })
    let doc = createPage()
    doc = insertNode(doc, a)
    doc = insertNode(doc, b)

    const from = { x: 0, y: 0, width: 200, height: 200 }
    const next = resizeNodes(doc, [a.id, b.id], from, { x: 0, y: 0, width: 400, height: 100 })
    expect(next.nodes[a.id]).toMatchObject({ x: 0, y: 0, width: 200, height: 50 })
    expect(next.nodes[b.id]).toMatchObject({ x: 200, y: 50, width: 200, height: 50 })
  })

  it('フレームの子は動かさず、子の位置は親からの相対で保つ', () => {
    const { doc, frame, inner } = fixture()
    const from = { x: 100, y: 50, width: 400, height: 300 }
    const next = resizeNodes(doc, [frame.id], from, { x: 150, y: 50, width: 350, height: 300 })
    expect(next.nodes[frame.id]).toMatchObject({ x: 150, width: 350 })
    expect(next.nodes[inner.id]).toBe(doc.nodes[inner.id])
  })

  it('直線は高さ 0 のまま伸び縮みできる', () => {
    const line = createLine({ x: 0, y: 50, width: 100, height: 0 })
    const doc = insertNode(createPage(), line)
    const from = { x: 0, y: 50, width: 100, height: 0 }
    const next = resizeNodes(doc, [line.id], from, { x: 0, y: 50, width: 250, height: 1 })
    expect(next.nodes[line.id]).toMatchObject({ x: 0, y: 50, width: 250, height: 0 })
  })

  it('テキストは幅を変えると折り返しになり、高さは変えない', () => {
    const text = createText({ x: 100, y: 100, width: 40, height: 20 }, 'abc')
    const doc = insertNode(createPage(), text)
    const from = { x: 0, y: 0, width: 200, height: 200 }

    const wider = resizeNodes(doc, [text.id], from, { x: 0, y: 0, width: 400, height: 400 })
    expect(wider.nodes[text.id]).toMatchObject({ x: 200, y: 200, width: 80, height: 20, sizing: { width: 'fixed', height: 'hug' } })

    const taller = resizeNodes(doc, [text.id], from, { x: 0, y: 0, width: 200, height: 400 })
    expect(taller.nodes[text.id]).toMatchObject({ x: 100, y: 200, width: 40, height: 20, sizing: { width: 'hug', height: 'hug' } })
  })
})

describe('回転', () => {
  const close = (actual: { x: number; y: number }, expected: { x: number; y: number }) => {
    expect(actual.x).toBeCloseTo(expected.x, 1)
    expect(actual.y).toBeCloseTo(expected.y, 1)
  }

  /** 30° 回したフレームの中に長方形がある */
  function rotated() {
    const frame = { ...createFrame({ x: 100, y: 100, width: 200, height: 100 }), rotation: 30 }
    const rect = createRect({ x: 20, y: 10, width: 40, height: 20 })
    const loose = createRect({ x: 500, y: 0, width: 40, height: 20 })
    let doc = insertNode(createPage(), frame)
    doc = insertNode(doc, rect, frame.id)
    doc = insertNode(doc, loose)
    return { doc, frame, rect, loose }
  }

  it('親を付け替えても、ページ上での位置と向きが変わらない', () => {
    const { doc, frame, rect, loose } = rotated()
    const before = { center: getWorldCenter(doc, rect.id), corners: getCorners(doc, rect.id) }

    const out = moveNode(doc, rect.id, null)
    expect(out.nodes[rect.id].rotation).toBe(30)
    close(getWorldCenter(out, rect.id), before.center)
    close(getCorners(out, rect.id)[0], before.corners[0])

    // 回ったフレームへ入れると、打ち消す向きの回転が付く
    const into = moveNode(doc, loose.id, frame.id)
    expect(into.nodes[loose.id].rotation).toBe(-30)
    expect(getWorldRotation(into, loose.id)).toBe(0)
    close(getWorldCenter(into, loose.id), { x: 520, y: 10 })
  })

  it('移動量はページ上の向きで解釈する', () => {
    const { doc, rect } = rotated()
    const before = getWorldCenter(doc, rect.id)
    const next = translateNodes(doc, [rect.id], 10, 0)
    close(getWorldCenter(next, rect.id), { x: before.x + 10, y: before.y })
    // 親の中では斜めに動いている
    expect(next.nodes[rect.id].y).not.toBe(10)
  })

  it('pivot を軸にまとめて回す', () => {
    const a = createRect({ x: 0, y: 0, width: 20, height: 20 })
    const b = createRect({ x: 100, y: 0, width: 20, height: 20 })
    const doc = insertNode(insertNode(createPage(), a), b)

    const next = rotateNodes(doc, [a.id, b.id], { x: 60, y: 10 }, 90)
    expect(next.nodes[a.id].rotation).toBe(90)
    close(getWorldCenter(next, a.id), { x: 60, y: -40 })
    close(getWorldCenter(next, b.id), { x: 60, y: 60 })
    expect(rotateNodes(doc, [a.id], { x: 0, y: 0 }, 0)).toBe(doc)

    // 一周すれば元に戻る
    const full = rotateNodes(next, [a.id, b.id], { x: 60, y: 10 }, 270)
    expect(full.nodes[a.id]).toMatchObject({ x: 0, y: 0, rotation: 0 })
  })

  it('回ったノードを、その向きに沿ってリサイズしても反対側の角は動かない', () => {
    const rect = { ...createRect({ x: 100, y: 100, width: 100, height: 50 }), rotation: 45 }
    const doc = insertNode(createPage(), rect)
    const anchor = getCorners(doc, rect.id)[0]

    // 右下のハンドルを引いて 160 × 80 にする（左上が固定）
    const next = reshapeNode(doc, rect.id, { x: 0, y: 0, width: 160, height: 80 })
    expect(next.nodes[rect.id]).toMatchObject({ width: 160, height: 80, rotation: 45 })
    close(getCorners(next, rect.id)[0], anchor)

    // 左上のハンドルを引く（右下が固定）
    const far = getCorners(doc, rect.id)[2]
    const shrunk = reshapeNode(doc, rect.id, { x: 40, y: 20, width: 60, height: 30 })
    close(getCorners(shrunk, rect.id)[2], far)
  })

  it('まとめてリサイズするとき、90° 回ったノードは縦横を入れ替えて伸縮する', () => {
    const rect = { ...createRect({ x: 0, y: 0, width: 100, height: 40 }), rotation: 90 }
    const doc = insertNode(createPage(), rect)
    const from = getAbsoluteBounds(doc, rect.id)
    const to = { ...from, width: from.width * 2 }

    const next = resizeNodes(doc, [rect.id], from, to)
    // ページ上で横に 2 倍 → 回す前の枠では高さが 2 倍
    expect(next.nodes[rect.id]).toMatchObject({ width: 100, height: 80, rotation: 90 })
    const bounds = getAbsoluteBounds(next, rect.id)
    expect(bounds.x).toBeCloseTo(to.x)
    expect(bounds.width).toBeCloseTo(to.width)
  })

  it('コピーして別の親へ貼っても、ページ上での位置と向きが変わらない', () => {
    const { doc, rect } = rotated()
    const fragment = copyFragment(doc, {}, [rect.id])
    expect(fragment.nodes[rect.id].rotation).toBe(30)

    const { scene: pasted, ids } = pasteFragment(createPage(), fragment)
    expect(pasted.nodes[ids[0]].rotation).toBe(30)
    close(getWorldCenter(pasted, ids[0]), getWorldCenter(doc, rect.id))

    // 同じ親の中へ貼ると、元と同じ座標になる
    const { scene: same, ids: sameIds } = pasteFragment(doc, fragment)
    expect(same.nodes[sameIds[0]]).toMatchObject({ x: 20, y: 10, rotation: 0 })
  })

  it('回ったノードの整列は、囲む矩形で揃える', () => {
    const a = { ...createRect({ x: 0, y: 0, width: 100, height: 20 }), rotation: 90 }
    const b = createRect({ x: 200, y: 100, width: 50, height: 50 })
    const doc = insertNode(insertNode(createPage(), a), b)
    const next = alignNodes(doc, [a.id, b.id], 'left')
    expect(getAbsoluteBounds(next, a.id).x).toBeCloseTo(getAbsoluteBounds(next, b.id).x)
  })
})
