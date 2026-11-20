import { describe, expect, it } from 'vitest'
import type { FrameNode } from '../document/types.ts'
import { createFrame, createImage, createLine, createRect, createText } from './nodes.ts'
import {
  getAbsoluteBounds,
  getCorners,
  getWorldCenter,
  getWorldRotation,
} from '../document/geometry.ts'
import {
  addAsset,
  alignNodes,
  copyFragment,
  addPage,
  createDocument,
  createPage,
  duplicatePage,
  distributeNodes,
  insertNode,
  moveNode,
  movePage,
  pasteFragment,
  pasteIntoPage,
  placeNodes,
  pruneAssets,
  removePage,
  renamePage,
  removeNodes,
  reorderNodes,
  reparentNodes,
  reshapeNode,
  resizeNodes,
  rotateNodes,
  topLevelIds,
  translateNodes,
  updateNode,
  updatePage,
} from './operations.ts'

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

describe('insertNode', () => {
  it('ページ直下では最前面に追加する', () => {
    const { doc, frame, loose } = fixture()
    expect(doc.rootIds).toEqual([frame.id, loose.id])
    expect(doc.nodes[loose.id].parentId).toBeNull()
  })

  it('フレームの子として指定位置に追加する', () => {
    const { doc, frame, inner } = fixture()
    const back = createRect(bounds)
    const next = insertNode(doc, back, frame.id, 0)
    expect((next.nodes[frame.id] as FrameNode).children).toEqual([back.id, inner.id])
    expect(next.nodes[back.id].parentId).toBe(frame.id)
  })

  it('元のドキュメントを書き換えない', () => {
    const { doc, frame } = fixture()
    const before = structuredClone(doc)
    insertNode(doc, createRect(bounds), frame.id)
    expect(doc).toEqual(before)
  })

  it('フレーム以外を親にはできない', () => {
    const { doc, loose } = fixture()
    expect(() => insertNode(doc, createRect(bounds), loose.id)).toThrow()
  })

  it('同じ id は二重に追加できない', () => {
    const { doc, loose } = fixture()
    expect(() => insertNode(doc, loose)).toThrow()
  })
})

describe('updateNode', () => {
  it('指定したフィールドだけを更新する', () => {
    const { doc, rect } = fixture()
    const next = updateNode(doc, rect.id, { x: 42, fill: '#ff0000' })
    expect(next.nodes[rect.id]).toEqual({ ...doc.nodes[rect.id], x: 42, fill: '#ff0000' })
  })

  it('値が変わらなければ同じドキュメントを返す', () => {
    const { doc, rect } = fixture()
    expect(updateNode(doc, rect.id, { x: rect.x })).toBe(doc)
    expect(updateNode(doc, 'missing', { x: 1 })).toBe(doc)
  })

  it('木構造のフィールドやノード種別にないフィールドは無視する', () => {
    const { doc, rect } = fixture()
    const patch = { parentId: null, id: 'other', text: 'hello' } as object
    expect(updateNode(doc, rect.id, patch)).toBe(doc)
  })
})

describe('removeNodes', () => {
  it('子孫ごと削除し、親の children からも外す', () => {
    const { doc, frame, inner, rect, loose } = fixture()
    const next = removeNodes(doc, [inner.id])
    expect(Object.keys(next.nodes).sort()).toEqual([frame.id, loose.id].sort())
    expect((next.nodes[frame.id] as FrameNode).children).toEqual([])
    expect(next.nodes[rect.id]).toBeUndefined()
  })

  it('親子を同時に指定しても壊れない', () => {
    const { doc, frame, rect, loose } = fixture()
    const next = removeNodes(doc, [rect.id, frame.id])
    expect(next.rootIds).toEqual([loose.id])
    expect(Object.keys(next.nodes)).toEqual([loose.id])
  })

  it('対象がなければ同じドキュメントを返す', () => {
    const { doc } = fixture()
    expect(removeNodes(doc, ['missing'])).toBe(doc)
  })
})

describe('moveNode', () => {
  it('親を付け替えても見た目の位置を保つ', () => {
    const { doc, rect } = fixture()
    expect(getAbsoluteBounds(doc, rect.id)).toMatchObject({ x: 125, y: 65 })

    const next = moveNode(doc, rect.id, null)
    expect(next.nodes[rect.id]).toMatchObject({ parentId: null, x: 125, y: 65 })
    expect(next.rootIds.at(-1)).toBe(rect.id)
  })

  it('別のフレームの中へ移せる', () => {
    const { doc, frame, inner, loose } = fixture()
    const next = moveNode(doc, loose.id, inner.id, 0)
    expect(next.rootIds).toEqual([frame.id])
    expect((next.nodes[inner.id] as FrameNode).children[0]).toBe(loose.id)
    expect(getAbsoluteBounds(next, loose.id)).toMatchObject({ x: 900, y: 0 })
  })

  it('同じ親の中で重なり順を変えられる', () => {
    const { doc, frame, loose } = fixture()
    const next = moveNode(doc, loose.id, null, 0)
    expect(next.rootIds).toEqual([loose.id, frame.id])
    expect(moveNode(doc, loose.id, null, 1)).toBe(doc)
  })

  it('自分自身や子孫の中へは移せない', () => {
    const { doc, frame, inner } = fixture()
    expect(() => moveNode(doc, frame.id, frame.id)).toThrow()
    expect(() => moveNode(doc, frame.id, inner.id)).toThrow()
  })

  it('フレーム以外の中へは移せない', () => {
    const { doc, rect, loose } = fixture()
    expect(() => moveNode(doc, rect.id, loose.id)).toThrow()
    expect(() => moveNode(doc, rect.id, createText(bounds).id)).toThrow()
  })
})

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
    expect(wider.nodes[text.id]).toMatchObject({ x: 200, y: 200, width: 80, height: 20, autoWidth: false })

    const taller = resizeNodes(doc, [text.id], from, { x: 0, y: 0, width: 200, height: 400 })
    expect(taller.nodes[text.id]).toMatchObject({ x: 100, y: 200, width: 40, height: 20, autoWidth: true })
  })
})

describe('reparentNodes', () => {
  it('親が違うノードだけを移す', () => {
    const { doc, frame, inner, rect, loose } = fixture()
    const next = reparentNodes(doc, [loose.id, rect.id], frame.id)
    expect((next.nodes[frame.id] as FrameNode).children).toEqual([inner.id, rect.id, loose.id])
    expect(getAbsoluteBounds(next, loose.id)).toMatchObject({ x: 900, y: 0 })
    expect(reparentNodes(doc, [inner.id], frame.id)).toBe(doc)
    // 自分自身の中へは入れない
    expect(reparentNodes(doc, [frame.id], inner.id)).toBe(doc)
  })
})

describe('placeNodes', () => {
  function flat() {
    const nodes = ['a', 'b', 'c', 'd'].map((name) => ({ ...createRect(bounds), name }))
    const doc = nodes.reduce((next, node) => insertNode(next, node), createPage())
    const names = (d: typeof doc) => d.rootIds.map((id) => d.nodes[id].name).join('')
    return { doc, ids: nodes.map((node) => node.id), names }
  }

  it('複数ノードを互いの順序を保ったまま target の手前・奥へ移す', () => {
    const { doc, ids, names } = flat()
    const [a, b, c, d] = ids
    expect(names(placeNodes(doc, [a, b], d, 'above'))).toBe('cdab')
    expect(names(placeNodes(doc, [b, a], d, 'below'))).toBe('cabd')
    expect(names(placeNodes(doc, [c, d], a, 'below'))).toBe('cdab')
    expect(names(placeNodes(doc, [d], b, 'above'))).toBe('abdc')
  })

  it('フレームの中へ入れる', () => {
    const { doc, frame, inner, loose } = fixture()
    const next = placeNodes(doc, [loose.id], frame.id, 'inside')
    expect((next.nodes[frame.id] as FrameNode).children).toEqual([inner.id, loose.id])
  })

  it('自分自身や子孫を基準にした移動、フレーム以外の中への移動は何もしない', () => {
    const { doc, frame, inner, rect, loose } = fixture()
    expect(placeNodes(doc, [frame.id], inner.id, 'inside')).toBe(doc)
    expect(placeNodes(doc, [frame.id], rect.id, 'above')).toBe(doc)
    expect(placeNodes(doc, [rect.id], loose.id, 'inside')).toBe(doc)
  })

  it('重なり順を 1 つずつ、または端まで動かす', () => {
    const { doc, ids, names } = flat()
    const [a, b, c, d] = ids
    expect(names(reorderNodes(doc, [a, c], 'front'))).toBe('bdac')
    expect(names(reorderNodes(doc, [b, d], 'back'))).toBe('bdac')
    expect(names(reorderNodes(doc, [a, b], 'forward'))).toBe('cabd')
    expect(names(reorderNodes(doc, [c, d], 'forward'))).toBe('abcd')
    expect(names(reorderNodes(doc, [b], 'backward'))).toBe('bacd')
    expect(reorderNodes(doc, [a], 'backward')).toBe(doc)
  })
})

describe('copyFragment / pasteFragment', () => {
  it('子孫ごと新しい id で複製し、元の親の中へずらして置く', () => {
    const { doc, frame, inner, rect } = fixture()
    const { scene: next, ids } = pasteFragment(doc, copyFragment(doc, {}, [inner.id, rect.id]), 10)

    expect(ids).toHaveLength(1)
    const copy = next.nodes[ids[0]] as FrameNode
    expect(copy.id).not.toBe(inner.id)
    expect(copy).toMatchObject({ parentId: frame.id, x: 30, y: 20 })
    expect((next.nodes[frame.id] as FrameNode).children).toEqual([inner.id, copy.id])

    expect(copy.children).toHaveLength(1)
    expect(copy.children[0]).not.toBe(rect.id)
    expect(next.nodes[copy.children[0]]).toMatchObject({ parentId: copy.id, x: 5, y: 5 })
    expect(Object.keys(next.nodes)).toHaveLength(6)
  })

  it('元の親が消えていたらページ直下へ、見た目の位置を保って置く', () => {
    const { doc, frame, rect } = fixture()
    const fragment = copyFragment(doc, {}, [rect.id])
    const { scene: next, ids } = pasteFragment(removeNodes(doc, [frame.id]), fragment)
    expect(next.nodes[ids[0]]).toMatchObject({ parentId: null, x: 125, y: 65 })
    expect(next.rootIds.at(-1)).toBe(ids[0])
  })
})

describe('alignNodes', () => {
  function three() {
    const nodes = [
      createRect({ x: 0, y: 0, width: 20, height: 20 }),
      createRect({ x: 50, y: 30, width: 40, height: 10 }),
      createRect({ x: 200, y: 80, width: 100, height: 20 }),
    ]
    const doc = nodes.reduce((next, node) => insertNode(next, node), createPage())
    const ids = nodes.map((node) => node.id)
    const xs = (d: typeof doc) => ids.map((id) => d.nodes[id].x)
    const ys = (d: typeof doc) => ids.map((id) => d.nodes[id].y)
    return { doc, ids, xs, ys }
  }

  it('複数選択は選択範囲に揃える', () => {
    const { doc, ids, xs, ys } = three()
    expect(xs(alignNodes(doc, ids, 'left'))).toEqual([0, 0, 0])
    expect(xs(alignNodes(doc, ids, 'right'))).toEqual([280, 260, 200])
    expect(xs(alignNodes(doc, ids, 'center'))).toEqual([140, 130, 100])
    expect(ys(alignNodes(doc, ids, 'top'))).toEqual([0, 0, 0])
    expect(ys(alignNodes(doc, ids, 'bottom'))).toEqual([80, 90, 80])
    expect(ys(alignNodes(doc, ids, 'middle'))).toEqual([40, 45, 40])
  })

  it('1 つだけなら親フレームに揃え、ページ直下では何もしない', () => {
    const { doc, frame, inner, loose } = fixture()
    expect(alignNodes(doc, [inner.id], 'right').nodes[inner.id]).toMatchObject({ x: 200, y: 10 })
    expect(alignNodes(doc, [inner.id], 'middle').nodes[inner.id]).toMatchObject({ x: 20, y: 100 })
    expect(alignNodes(doc, [loose.id], 'left')).toBe(doc)
    expect(alignNodes(doc, [frame.id], 'left')).toBe(doc)
  })

  it('等間隔に並べる', () => {
    const { doc, ids, xs, ys } = three()
    // 幅 20 + 40 + 100、全体 300 なので間隔は 70
    expect(xs(distributeNodes(doc, ids, 'x'))).toEqual([0, 90, 200])
    expect(ys(distributeNodes(doc, ids, 'y'))).toEqual([0, 45, 80])
    expect(distributeNodes(doc, ids.slice(0, 2), 'x')).toBe(doc)
  })
})

describe('assets', () => {
  const asset = { mime: 'image/png', data: 'AAAA' }
  const image = createImage(bounds, 'a')
  const withImage = () => {
    const doc = createDocument()
    return addAsset(updatePage(doc, doc.pages[0].id, (page) => insertNode(page, image)), 'a', asset)
  }

  it('どのページでも使われていないアセットを除く', () => {
    const doc = addAsset(withImage(), 'b', asset)
    expect(pruneAssets(doc).assets).toEqual({ a: asset })

    const clean = withImage()
    expect(pruneAssets(clean)).toBe(clean)

    // 別のページで使われていれば残す
    const other = insertNode(createPage('other'), createImage(bounds, 'b'))
    expect(pruneAssets(addPage(doc, other)).assets).toEqual({ a: asset, b: asset })
  })

  it('コピーしたノードは、アセットのない別のドキュメントへ貼っても画像が欠けない', () => {
    const source = withImage()
    const fragment = copyFragment(source.pages[0], source.assets, [image.id])
    expect(fragment.assets).toEqual({ a: asset })

    const empty = createDocument()
    const { document: pasted, ids } = pasteIntoPage(empty, empty.pages[0].id, fragment)
    expect(pasted.assets).toEqual({ a: asset })
    expect(pasted.pages[0].nodes[ids[0]]).toMatchObject({ type: 'image', assetId: 'a' })

    // 同じドキュメント内なら assets は作り直さない
    expect(pasteIntoPage(source, source.pages[0].id, fragment).document.assets).toBe(source.assets)
  })
})

describe('ページ', () => {
  function three() {
    const pages = ['A', 'B', 'C'].map((name) => createPage(name))
    const doc = { name: 'doc', pages, assets: {} }
    const names = (d: typeof doc) => d.pages.map((page) => page.name).join('')
    return { doc, ids: pages.map((page) => page.id), names }
  }

  it('新しいドキュメントには 1 ページある', () => {
    expect(createDocument().pages).toHaveLength(1)
  })

  it('1 ページだけを書き換え、変わらなければ同じドキュメントを返す', () => {
    const { doc, ids } = three()
    const rect = createRect(bounds)
    const next = updatePage(doc, ids[1], (page) => insertNode(page, rect))
    expect(next.pages[1].rootIds).toEqual([rect.id])
    expect(next.pages[0]).toBe(doc.pages[0])

    expect(updatePage(doc, ids[1], (page) => page)).toBe(doc)
    expect(updatePage(doc, 'missing', (page) => insertNode(page, rect))).toBe(doc)
    expect(renamePage(doc, ids[0], 'A')).toBe(doc)
    expect(renamePage(doc, ids[0], 'Z').pages[0].name).toBe('Z')
  })

  it('追加・削除・並べ替え', () => {
    const { doc, ids, names } = three()
    expect(names(addPage(doc, createPage('D')))).toBe('ABCD')
    expect(names(addPage(doc, createPage('D'), 1))).toBe('ADBC')
    expect(() => addPage(doc, doc.pages[0])).toThrow()

    expect(names(removePage(doc, ids[1]))).toBe('AC')
    expect(removePage(doc, 'missing')).toBe(doc)

    expect(names(movePage(doc, ids[0], 2))).toBe('BCA')
    expect(names(movePage(doc, ids[2], 0))).toBe('CAB')
    expect(movePage(doc, ids[1], 1)).toBe(doc)
  })

  it('最後の 1 ページは消せない', () => {
    const doc = createDocument()
    expect(removePage(doc, doc.pages[0].id)).toBe(doc)
  })

  it('複製は中身ごと新しい id で作り、元のすぐ後ろに置く', () => {
    const { doc, ids, names } = three()
    const { doc: scene, frame } = fixture()
    const filled = updatePage(doc, ids[0], (page) => ({ ...page, nodes: scene.nodes, rootIds: scene.rootIds }))

    const result = duplicatePage(filled, ids[0])!
    expect(names(result.document)).toBe('AA のコピーBC')
    const copy = result.document.pages[1]
    expect(copy.id).toBe(result.pageId)
    expect(Object.keys(copy.nodes)).toHaveLength(Object.keys(scene.nodes).length)
    expect(Object.keys(copy.nodes)).not.toContain(frame.id)
    expect(copy.nodes[copy.rootIds[0]]).toMatchObject({ type: 'frame', x: 100, y: 50 })
    expect(duplicatePage(doc, 'missing')).toBeNull()
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
