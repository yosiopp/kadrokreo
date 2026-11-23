import { describe, expect, it } from 'vitest'
import { getAbsoluteBounds, getCorners, getWorldCenter, getWorldRotation } from '../../document/geometry.ts'
import { createFrame, createLine, createPath, createRect, createText } from '../nodes.ts'
import { alignNodes } from './arrange.ts'
import { copyFragment, pasteFragment } from './clipboard.ts'
import { createPage } from './document.ts'
import { flipNodes, reshapeNode, resizeNodes, rotateNodes, setRotation, translateNodes } from './transform.ts'
import { insertNode, moveNode, topLevelIds, updateNode } from './tree.ts'

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

describe('flipNodes', () => {
  it('1 つなら中心はそのままで、角度の符号を変え、パスの頂点と制御点を映す', () => {
    const path = {
      ...createPath({ x: 10, y: 20, width: 100, height: 50, points: [{ x: 0, y: 0, out: { x: 0.2, y: 0.1 } }, { x: 1, y: 0.5 }] }, false),
      rotation: 30,
    }
    let doc = createPage()
    doc = insertNode(doc, path)
    const next = flipNodes(doc, [path.id], 'horizontal')
    expect(getWorldCenter(next, path.id)).toEqual(getWorldCenter(doc, path.id))
    expect(next.nodes[path.id]).toMatchObject({
      x: 10,
      y: 20,
      rotation: -30,
      points: [{ x: 1, y: 0, out: { x: -0.2, y: 0.1 } }, { x: 0, y: 0.5 }],
    })
    // 2 回裏返すと元に戻る（2 つ目以降の輪郭も映す）
    const holed = updateNode(doc, path.id, { contours: [{ points: [{ x: 0.25, y: 0.5 }, { x: 0.5, y: 0.75 }], closed: true }] })
    expect(flipNodes(holed, [path.id], 'vertical').nodes[path.id]).toMatchObject({ contours: [{ points: [{ x: 0.25, y: 0.5 }, { x: 0.5, y: 0.25 }], closed: true }] })
    expect(flipNodes(next, [path.id], 'horizontal').nodes[path.id]).toEqual(doc.nodes[path.id])
  })

  it('複数なら選択範囲の中心で映し、上下では y を映す', () => {
    const a = createRect({ x: 0, y: 0, width: 10, height: 10 })
    const b = createRect({ x: 0, y: 90, width: 10, height: 10 })
    let doc = createPage()
    doc = insertNode(doc, a)
    doc = insertNode(doc, b)
    const next = flipNodes(doc, [a.id, b.id], 'vertical')
    expect(next.nodes[a.id]).toMatchObject({ x: 0, y: 90 })
    expect(next.nodes[b.id]).toMatchObject({ x: 0, y: 0 })
  })

  it('フレームの子・角丸の 4 隅・グラデーション・影・固定の向きを映す', () => {
    const frame = { ...createFrame({ x: 0, y: 0, width: 200, height: 100 }), cornerRadius: [1, 2, 3, 4] as [number, number, number, number] }
    const child = {
      ...createRect({ x: 10, y: 10, width: 30, height: 20 }),
      rotation: 15,
      constraints: { horizontal: 'start' as const, vertical: 'end' as const },
      fills: [
        { type: 'linear' as const, x1: 0.1, y1: 0.2, x2: 0.7, y2: 0.9, stops: [], opacity: 1, visible: true, blendMode: 'normal' as const },
        { type: 'radial' as const, cx: 0.2, cy: 0.3, rx: 0.5, ry: 0.5, stops: [], opacity: 1, visible: true, angle: 20, blendMode: 'normal' as const },
        { type: 'conic' as const, cx: 0.2, cy: 0.3, angle: 30, stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 0.25, color: '#ffffff', opacity: 1 }], opacity: 1, visible: true, blendMode: 'normal' as const },
      ],
      effects: [
        { type: 'drop-shadow' as const, x: 4, y: 6, blur: 2, color: '#000000', opacity: 0.5, visible: true, spread: 0 , blendMode: 'normal' as const},
        { type: 'layer-blur' as const, blur: 2, visible: true },
      ],
    }
    let doc = createPage()
    doc = insertNode(doc, frame)
    doc = insertNode(doc, child, frame.id)
    const next = flipNodes(doc, [frame.id], 'horizontal')
    expect(next.nodes[frame.id]).toMatchObject({ x: 0, cornerRadius: [2, 1, 4, 3] })
    expect(next.nodes[child.id]).toMatchObject({
      x: 160,
      y: 10,
      rotation: -15,
      constraints: { horizontal: 'end', vertical: 'end' },
      fills: [
        { x1: 0.9, y1: 0.2, x2: 0.3, y2: 0.9 },
        // 回した楕円は、軸の向きの符号が変わる
        { cx: 0.8, cy: 0.3, angle: -20 },
        // 角度は回る向きが逆になるので、色の並びも逆にする
        { cx: 0.8, angle: 150, stops: [{ offset: 0.75, color: '#ffffff', opacity: 1 }, { offset: 1, color: '#000000', opacity: 1 }] },
      ],
      effects: [{ x: -4, y: 6 }, { type: 'layer-blur', blur: 2, visible: true }],
    })
  })

  it('テキストは位置と向きだけを映す', () => {
    const text = { ...createText({ x: 0, y: 0, width: 50, height: 20 }, 'abc'), rotation: 10 }
    const rect = createRect({ x: 150, y: 0, width: 50, height: 20 })
    let doc = createPage()
    doc = insertNode(doc, text)
    doc = insertNode(doc, rect)
    const next = flipNodes(doc, [text.id, rect.id], 'horizontal')
    expect(next.nodes[text.id]).toMatchObject({ rotation: -10, text: 'abc', textAlign: text.textAlign })
    // 中心どうしの左右が入れ替わる（鏡に映した位置）
    const gap = (scene: typeof doc) => getWorldCenter(scene, text.id).x - getWorldCenter(scene, rect.id).x
    expect(gap(next)).toBeCloseTo(-gap(doc))
  })
})

describe('setRotation', () => {
  it('角度の揃った複数は、選択範囲の中心を軸にまとめて回す', () => {
    const a = createRect({ x: 0, y: 0, width: 10, height: 10 })
    const b = createRect({ x: 90, y: 0, width: 10, height: 10 })
    let doc = createPage()
    doc = insertNode(doc, a)
    doc = insertNode(doc, b)
    const next = setRotation(doc, [a.id, b.id], 90)
    expect(getWorldRotation(next, a.id)).toBe(90)
    // 中心 (5, 5) と (95, 5) が、選択範囲の中心 (50, 5) のまわりで縦に並ぶ
    expect(getWorldCenter(next, a.id)).toEqual({ x: 50, y: -40 })
    expect(getWorldCenter(next, b.id)).toEqual({ x: 50, y: 50 })
  })

  it('1 つか、角度が揃っていなければ、それぞれの中心で回す', () => {
    const a = createRect({ x: 0, y: 0, width: 10, height: 10 })
    const b = { ...createRect({ x: 90, y: 0, width: 10, height: 10 }), rotation: 20 }
    let doc = createPage()
    doc = insertNode(doc, a)
    doc = insertNode(doc, b)
    const next = setRotation(doc, [a.id, b.id], 400)
    expect(next.nodes[a.id]).toMatchObject({ x: 0, y: 0, rotation: 40 })
    expect(next.nodes[b.id]).toMatchObject({ x: 90, y: 0, rotation: 40 })
  })
})
