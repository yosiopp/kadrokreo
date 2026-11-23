import { describe, expect, it } from 'vitest'
import { getAbsoluteBounds } from '../../document/geometry.ts'
import { pathFromContours, pathOutlines, pathPoints } from '../../document/path.ts'
import { sha256Hex } from '../../document/sha256.ts'
import { estimateTextMetrics, exportSvg, textBaseline } from '../../document/svgExport.ts'
import { CONIC_WEDGES } from '../../document/svgShapes.ts'
import { getPaintedBounds } from '../../document/paint.ts'
import type { Asset, Effect, EllipseNode, ImageNode, PathNode, RectNode, Scene, SceneNode, Shadow, TextNode } from '../../document/types.ts'
import { createEllipse, createFrame, createImage, createLine, createPath, createRect, createText } from '../nodes.ts'
import { convertSvg } from './convert.ts'
import { parseSvgXml } from './xml.ts'

// SVG の書き出し（document/svgExport.ts）で書いた SVG を、取り込み（convert.ts）で読み戻し、形が揃うことを確かめる

/** 1 文字 = fontSize の半分の幅、と見積もる（書き出しと取り込みで同じものを使う） */
const measureText = (node: TextNode) => ({
  width: Math.ceil(Math.max(...node.text.split('\n').map((line) => line.length)) * node.fontSize * 0.5),
  height: Math.ceil(node.text.split('\n').length * node.fontSize * node.lineHeight),
})

/** ノードを並べたページ（親子は parentId から組む）。サイズの合ったテキストにする */
function sceneOf(...nodes: SceneNode[]): Scene {
  const table: Record<string, SceneNode> = {}
  for (const node of nodes) table[node.id] = node.type === 'text' ? { ...node, ...measureText(node) } : node
  for (const node of nodes) {
    if (node.parentId === null) continue
    const parent = table[node.parentId]
    if (parent.type === 'frame') table[parent.id] = { ...parent, children: [...parent.children, node.id] }
  }
  return { nodes: table, rootIds: nodes.filter((node) => node.parentId === null).map((node) => node.id) }
}

function named<T extends SceneNode>(node: T, id: string, patch: Partial<T> = {}): T {
  return { ...node, id, name: id, ...patch }
}

/** 書き出して読み戻したページ。根（SVG 全体のフレーム）は書き出した範囲の左上に置く */
function roundTrip(scene: Scene, assets: Record<string, Asset> = {}, targets = scene.rootIds) {
  const svg = exportSvg(scene, targets, { assets })
  const result = convertSvg(parseSvgXml(svg), { name: 'export', measureText })
  const imported: Scene = { nodes: result.fragment.nodes, rootIds: result.fragment.rootIds }
  const byName = (name: string) => {
    const found = Object.values(imported.nodes).find((node) => node.name === name)
    if (!found) throw new Error(`${name} が読み戻せません:\n${svg}`)
    return found
  }
  // 書き出しの範囲は影のはみ出しまで含む
  const origin = getPaintedBounds(scene, targets)!
  return { svg, imported, byName, origin, warnings: result.warnings.map((warning) => warning.label), assets: result.fragment.assets }
}

const close = (value: number, expected: number, digits = 1) => expect(value).toBeCloseTo(expected, digits)

/** ページ上の位置と大きさが揃う。origin は書き出した範囲の左上 */
function expectSameBounds(original: Scene, id: string, imported: Scene, importedId: string, origin: { x: number; y: number }) {
  const a = getAbsoluteBounds(original, id)
  const b = getAbsoluteBounds(imported, importedId)
  close(b.x, a.x - origin.x)
  close(b.y, a.y - origin.y)
  close(b.width, a.width)
  close(b.height, a.height)
}

describe('SVG の書き出しを取り込みで読み戻す', () => {
  it('矩形は位置・大きさ・回転・角丸・塗り・線・破線・不透明度が揃う', () => {
    const rect = named(createRect({ x: 10, y: 20, width: 120, height: 60 }), 'Card', {
      rotation: 30,
      cornerRadius: 8,
      fills: [{ type: 'solid', color: '#3366ff', opacity: 1, visible: true, blendMode: 'normal' as const }],
      strokes: [{ type: 'solid', color: '#112233', opacity: 1, visible: true, blendMode: 'normal' as const }],
      strokeWidth: 3,
      strokeDashes: [6, 2],
      opacity: 0.5,
    })
    const scene = sceneOf(rect)
    const { byName, imported, warnings, origin } = roundTrip(scene)
    const back = byName('Card') as RectNode
    expect(back.type).toBe('rect')
    expect(warnings).toEqual([])
    close(back.rotation, 30)
    close(back.width, 120)
    close(back.height, 60)
    expect(back.cornerRadius).toBeCloseTo(8)
    expect(back.fills).toEqual(rect.fills)
    expect(back.strokes).toEqual(rect.strokes)
    expect(back.strokeWidth).toBe(3)
    expect(back.strokeDashes).toEqual([6, 2])
    close(back.opacity, 0.5)
    // 書き出した範囲は回した矩形を囲む矩形なので、根のフレームからの位置で比べる
    expectSameBounds(scene, 'Card', imported, back.id, origin)
  })

  it('楕円の直線状のグラデーション・矩形の円形のグラデーションは向きと色が揃う', () => {
    const ellipse = named(createEllipse({ x: 0, y: 0, width: 100, height: 50 }), 'Dot', {
      fills: [{ type: 'linear', x1: 0.1, y1: 0.2, x2: 0.8, y2: 1.1, stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }], opacity: 1, visible: true, blendMode: 'normal' as const }],
    })
    const rect = named(createRect({ x: 120, y: 0, width: 80, height: 40 }), 'Glow', {
      fills: [{ type: 'radial', cx: 0.3, cy: 0.4, rx: 0.5, ry: 0.25, stops: [{ offset: 0, color: '#ffffff', opacity: 1 }, { offset: 1, color: '#000000', opacity: 1 }], opacity: 1, visible: true, angle: 0, fx: 0, fy: 0, blendMode: 'normal' as const }],
    })
    const scene = sceneOf(ellipse, rect)
    const { byName, imported, origin } = roundTrip(scene)
    const dot = byName('Dot')
    expect(dot.type).toBe('ellipse')
    const linear = (dot as typeof ellipse).fills[0]
    expect(linear.type).toBe('linear')
    if (linear.type === 'linear') {
      // 始点・終点は自由に置いたまま戻る
      close(linear.x1, 0.1, 3)
      close(linear.y1, 0.2, 3)
      close(linear.x2, 0.8, 3)
      close(linear.y2, 1.1, 3)
      expect(linear.stops.map((stop) => stop.color)).toEqual(['#ff0000', '#0000ff'])
    }
    const glow = byName('Glow') as RectNode
    const radial = glow.fills[0]
    expect(radial.type).toBe('radial')
    if (radial.type === 'radial') {
      close(radial.cx, 0.3, 3)
      close(radial.cy, 0.4, 3)
      close(radial.rx, 0.5, 3)
      close(radial.ry, 0.25, 3)
    }
    expectSameBounds(scene, 'Dot', imported, dot.id, origin)
    expectSameBounds(scene, 'Glow', imported, glow.id, origin)
  })

  it('塗りごとの不透明度は、塗りと線で違っても読み戻すと同じになる（グラデーションも）', () => {
    const gradient = {
      type: 'linear' as const, x1: 0, y1: 0.5, x2: 1, y2: 0.5, opacity: 0.6, visible: true, blendMode: 'normal' as const,
      stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }],
    }
    const rect = named(createRect({ x: 0, y: 0, width: 10, height: 10 }), 'Half', {
      fills: [{ type: 'solid', color: '#ff0000', opacity: 0.4, visible: true, blendMode: 'normal' as const }],
      strokes: [{ type: 'solid', color: '#000000', opacity: 0.8, visible: true, blendMode: 'normal' as const }],
      strokeWidth: 2,
    })
    const fade = named(createRect({ x: 20, y: 0, width: 10, height: 10 }), 'Fade', { fills: [gradient] })
    const { byName, warnings } = roundTrip(sceneOf(rect, fade))
    const back = byName('Half') as RectNode
    expect(back.opacity).toBe(1)
    close(back.fills[0].opacity, 0.4)
    close(back.strokes[0].opacity, 0.8)
    close((byName('Fade') as RectNode).fills[0].opacity, 0.6)
    expect(warnings).toEqual([])
  })

  it('4 隅の角丸が違う矩形は、同じ大きさのパスになる', () => {
    const rect = named(createRect({ x: 5, y: 5, width: 100, height: 40 }), 'Tab', { cornerRadius: [12, 12, 0, 0] })
    const scene = sceneOf(rect)
    const { byName, imported, origin } = roundTrip(scene)
    const back = byName('Tab')
    expect(back.type).toBe('path')
    expectSameBounds(scene, 'Tab', imported, back.id, origin)
  })

  it('穴のあるパスは輪郭と fill-rule が揃い、曲線の頂点も同じ位置に戻る', () => {
    const shape = pathFromContours([
      { vertices: [{ x: 0, y: 0 }, { x: 100, y: 0, out: { x: 120, y: 50 } }, { x: 100, y: 100, in: { x: 120, y: 80 } }, { x: 0, y: 100 }], closed: true },
      { vertices: [{ x: 30, y: 30 }, { x: 60, y: 30 }, { x: 60, y: 60 }, { x: 30, y: 60 }], closed: true },
    ])
    const path = named({ ...createPath({ ...shape, x: shape.x + 40, y: shape.y + 10 }, true), contours: shape.contours }, 'Ring', {
      fillRule: 'evenodd',
      fills: [{ type: 'solid', color: '#00aa00', opacity: 1, visible: true, blendMode: 'normal' as const }],
      strokes: [],
    })
    const scene = sceneOf(path)
    const { byName, imported, origin } = roundTrip(scene)
    const back = byName('Ring') as PathNode
    expect(back.type).toBe('path')
    expect(back.fillRule).toBe('evenodd')
    expect(back.contours).toHaveLength(1)
    expect(back.closed).toBe(true)
    expectSameBounds(scene, 'Ring', imported, back.id, origin)
    const before = pathPoints(path)
    const after = pathPoints(back)
    expect(after).toHaveLength(before.length)
    after.forEach((point, i) => {
      close(point.x, before[i].x)
      close(point.y, before[i].y)
    })
    expect(pathOutlines(back)[1].vertices).toHaveLength(4)
  })

  it('破線のずれと線の角の形は stroke-dashoffset・stroke-linejoin で書き、読み戻すと揃う', () => {
    const stroke = { type: 'solid' as const, color: '#222222', opacity: 1, visible: true, blendMode: 'normal' as const }
    const rect = named(createRect({ x: 0, y: 0, width: 40, height: 20 }), 'Dashed', {
      strokes: [stroke],
      strokeWidth: 3,
      strokeDashes: [6, 3],
      strokeDashOffset: 2.5,
      strokeJoin: 'round',
    })
    const path = named(createPath({ x: 50, y: 0, width: 40, height: 40, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }, false), 'Bent', {
      fills: [],
      strokes: [stroke],
      strokeJoin: 'bevel',
      endCap: 'arrow',
    })
    const plain = named(createRect({ x: 0, y: 30, width: 10, height: 10 }), 'Plain', { strokes: [stroke], strokeDashOffset: 4 })
    const { svg, byName } = roundTrip(sceneOf(rect, path, plain))
    expect(svg).toContain('stroke-dashoffset="2.5" stroke-linejoin="round"')
    expect(svg).toContain('stroke-linejoin="bevel"')
    // 実線のずれ・既定の角の形は書かない
    expect(svg.match(/stroke-dashoffset/g)).toHaveLength(1)
    expect(byName('Dashed')).toMatchObject({ strokeDashes: [6, 3], strokeDashOffset: 2.5, strokeJoin: 'round' })
    expect(byName('Bent')).toMatchObject({ strokeJoin: 'bevel', endCap: 'arrow' })
    expect(byName('Plain')).toMatchObject({ strokeDashOffset: 0, strokeJoin: 'miter' })
  })

  it('直線は端の形（丸）・破線・太さが揃う', () => {
    const line = named(createLine({ x: 0, y: 0, width: 80, height: 40 }), 'Arrow', {
      startCap: 'round',
      endCap: 'round',
      strokeWidth: 4,
      strokeDashes: [8, 4],
      strokes: [{ type: 'solid', color: '#222222', opacity: 1, visible: true, blendMode: 'normal' as const }],
    })
    const scene = sceneOf(line)
    const { svg, byName, imported, origin } = roundTrip(scene)
    // 破線の切れ目の端も丸くなるよう、stroke-linecap で書く（描画と同じ）
    expect(svg).toMatch(/<line [^>]*stroke-dasharray="8 4"[^>]*stroke-linecap="round"/)
    const back = byName('Arrow') as PathNode
    expect(back.startCap).toBe('round')
    expect(back.endCap).toBe('round')
    expect(back.strokeWidth).toBe(4)
    expect(back.strokeDashes).toEqual([8, 4])
    expect(back.fills).toEqual([])
    expectSameBounds(scene, 'Arrow', imported, back.id, origin)
  })

  it('矢印の端は、線と端の図形（線の色の多角形）になる', () => {
    const line = named(createLine({ x: 0, y: 0, width: 100, height: 0, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }), 'Pointer', {
      endCap: 'arrow',
      strokeWidth: 2,
    })
    const { svg } = roundTrip(sceneOf(line))
    expect(svg).toMatch(/<g id="Pointer" data-kdr-shape="path" data-kdr-caps="none arrow"><line [^>]*\/><polygon [^>]*fill="#000000"/)
  })

  it('回した入れ子のフレームの中の図形は、ページ上の同じ位置に戻る', () => {
    const outer = named(createFrame({ x: 50, y: 50, width: 200, height: 150 }), 'Outer', { rotation: 15 })
    const inner = named(createFrame({ x: 20, y: 30, width: 100, height: 60 }), 'Inner', { parentId: 'Outer', rotation: -40, clipContent: false })
    const leaf = named(createRect({ x: 10, y: 10, width: 30, height: 20 }), 'Leaf', { parentId: 'Inner', rotation: 10 })
    const scene = sceneOf(outer, inner, leaf)
    const { byName, imported, svg, origin } = roundTrip(scene)
    const back = byName('Leaf')
    expect(back.type).toBe('rect')
    expectSameBounds(scene, 'Leaf', imported, back.id, origin)
    close(getAbsoluteBounds(imported, byName('Leaf').id).width, getAbsoluteBounds(scene, 'Leaf').width)
    // 背景の矩形もフレームと同じ位置に戻る
    expect(svg).toContain('clip-path')
  })

  it('選んだノードだけを書き出せる（親の回転も映す）', () => {
    const outer = named(createFrame({ x: 50, y: 50, width: 200, height: 150 }), 'Outer', { rotation: 90 })
    const leaf = named(createRect({ x: 10, y: 10, width: 30, height: 20 }), 'Leaf', { parentId: 'Outer' })
    const scene = sceneOf(outer, leaf)
    const { byName, imported, svg, origin } = roundTrip(scene, {}, ['Leaf'])
    expect(svg).not.toContain('id="Outer"')
    const back = byName('Leaf')
    close(back.rotation, 90)
    expectSameBounds(scene, 'Leaf', imported, back.id, origin)
  })

  it('テキストは文言・大きさ・太さ・揃え・位置が揃う', () => {
    const text = named(createText({ x: 30, y: 40, width: 0, height: 0 }, 'Hello\nWorld!'), 'Title', {
      fontSize: 20,
      fontWeight: 700,
      fontFamily: 'Inter, sans-serif',
      fills: [{ type: 'solid', color: '#333333', opacity: 1, visible: true, blendMode: 'normal' as const }],
    })
    const centered = named(createText({ x: 30, y: 120, width: 0, height: 0 }, 'Centered'), 'Sub', { textAlign: 'center' })
    const scene = sceneOf(text, centered)
    const { byName, imported, origin } = roundTrip(scene)
    const back = byName('Title') as TextNode
    expect(back.text).toBe('Hello\nWorld!')
    expect(back.fontSize).toBe(20)
    expect(back.fontWeight).toBe(700)
    expect(back.fontFamily).toBe('Inter, sans-serif')
    expect(back.fills).toEqual(text.fills)
    expectSameBounds(scene, 'Title', imported, back.id, origin)
    const sub = byName('Sub') as TextNode
    expect(sub.textAlign).toBe('center')
    expectSameBounds(scene, 'Sub', imported, sub.id, origin)
  })

  it('枠からはみ出すテキストの行も範囲（viewBox）に含める。行の分け方を渡さなければ枠だけ', () => {
    // 枠は 100 × 30（1 行分）なのに 3 行描く。2 行目は 160px で、左揃えなので右へ 60 はみ出す
    const node = named(createText({ x: 0, y: 0, width: 100, height: 30 }, 'a\nb\nc'), 'Over', { fontSize: 20, lineHeight: 1.5 })
    const scene: Scene = { nodes: { Over: node }, rootIds: ['Over'] }
    const textLines = () => [{ text: 'a', width: 10 }, { text: 'b', width: 160 }, { text: 'c', width: 10 }]
    expect(exportSvg(scene, ['Over'], { assets: {}, textLines })).toContain('viewBox="0 0 160 90"')
    expect(exportSvg(scene, ['Over'], { assets: {} })).toContain('viewBox="0 0 100 30"')
  })

  it('画像は同じ画像（data URI）と枠で戻る', () => {
    // 2×1 の PNG の見出し（IHDR）だけ。中身はデコードしない
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0,
    ])
    const id = sha256Hex(bytes)
    const assets = { [id]: { mime: 'image/png', bytes } }
    const image = named(createImage({ x: 10, y: 10, width: 40, height: 20 }, id), 'Photo', { fit: 'stretch' }) as ImageNode
    const scene = sceneOf(image)
    const result = roundTrip(scene, assets)
    const back = result.byName('Photo') as ImageNode
    expect(back.type).toBe('image')
    expect(back.assetId).toBe(id)
    expect(Object.keys(result.assets)).toEqual([id])
    expectSameBounds(scene, 'Photo', result.imported, back.id, result.origin)
  })

  it('非表示のノードは書き出さない。影は filter に、ずれはノードの向きに直して書く', () => {
    const hidden = named(createRect({ x: 0, y: 0, width: 10, height: 10 }), 'Hidden', { visible: false })
    const shadowed = named(createRect({ x: 20, y: 0, width: 10, height: 10 }), 'Shadow', {
      rotation: 90,
      effects: [{ type: 'drop-shadow', x: 4, y: 0, blur: 6, color: '#000000', opacity: 0.25, visible: true, spread: 0, blendMode: 'normal' }],
    })
    const { svg } = roundTrip(sceneOf(hidden, shadowed))
    expect(svg).not.toContain('Hidden')
    // 90 度回した図形の中では、ページの右（+x）はノードの -y
    expect(svg).toContain('<feOffset dx="0" dy="-4"')
    expect(svg).toContain('stdDeviation="3"')
    expect(svg).toContain('flood-opacity="0.25"')
  })

  it('落ち影と内側の影は filter に書き、読み戻すと同じ効果になる（回した図形でもずれはページの向き）', () => {
    const effects: Effect[] = [
      { type: 'drop-shadow', x: 0, y: 4, blur: 8, color: '#000000', opacity: 0.25, visible: true, spread: 0, blendMode: 'normal' },
      { type: 'inner-shadow', x: 3, y: -2, blur: 6, color: '#ff0000', opacity: 0.5, visible: true, spread: 0, blendMode: 'normal' },
    ]
    const rect = named(createRect({ x: 0, y: 0, width: 40, height: 20 }), 'Box', { rotation: 30, effects })
    const result = roundTrip(sceneOf(rect))
    // 内側の影: 外側を塗ってぼかし、図形の中だけを残す。元の絵の上に重ねる
    expect(result.svg).toContain('operator="out"')
    expect(result.svg).toMatch(/<feMergeNode in="s0"\/><feMergeNode in="SourceGraphic"\/><feMergeNode in="n0"\/>/)
    expect(result.warnings).not.toContain('フィルタ')
    const back = result.byName('Box') as RectNode
    expect(back.type).toBe('rect')
    expect(back.effects).toHaveLength(2)
    back.effects.forEach((effect, i) => {
      const want = effects[i] as Shadow
      expect(effect).toMatchObject({ type: want.type, color: want.color, opacity: want.opacity })
      close((effect as Shadow).x, want.x)
      close((effect as Shadow).y, want.y)
      close(effect.blur, effects[i].blur)
    })
  })

  it('影の広がりは feMorphology で書き、読み戻すと同じ広がりになる', () => {
    const effects: Effect[] = [
      { type: 'drop-shadow', x: 0, y: 4, blur: 8, spread: 3, blendMode: 'normal', color: '#000000', opacity: 0.25, visible: true },
      { type: 'inner-shadow', x: 0, y: 2, blur: 4, spread: -2, blendMode: 'normal', color: '#ff0000', opacity: 0.5, visible: true },
    ]
    const rect = named(createRect({ x: 0, y: 0, width: 40, height: 20 }), 'Box', { effects })
    const result = roundTrip(sceneOf(rect))
    expect(result.svg).toContain('<feMorphology in="SourceAlpha" operator="dilate" radius="3" result="m0"/>')
    expect(result.svg).toContain('operator="erode" radius="2"')
    expect(result.warnings).not.toContain('フィルタ')
    const back = (result.byName('Box') as RectNode).effects as Shadow[]
    expect(back.map((effect) => [effect.type, effect.spread])).toEqual([['drop-shadow', 3], ['inner-shadow', -2]])
  })

  it('半透明の通過のフレームは、まとめて半透明にしてコメントを残す', () => {
    const group = named(createFrame({ x: 0, y: 0, width: 40, height: 20 }), 'Group', { passThrough: true, opacity: 0.5 })
    const child = named(createRect({ x: 0, y: 0, width: 10, height: 10 }), 'Child', { parentId: 'Group' })
    const result = roundTrip(sceneOf(group, child))
    expect(result.svg).toContain('<!-- Group: 通過は SVG で表せないので、中身をまとめてから半透明にしている -->')
    expect(result.svg).toContain('opacity="0.5"')
    expect(roundTrip(sceneOf({ ...group, opacity: 1 }, child)).svg).not.toContain('通過')
  })

  it('レイヤーのぼかしは feGaussianBlur の filter。背景のぼかしは書かずにコメントを残す', () => {
    const blurred = named(createRect({ x: 0, y: 0, width: 40, height: 20 }), 'Soft', { effects: [{ type: 'layer-blur', blur: 6, visible: true }] })
    const glass = named(createRect({ x: 50, y: 0, width: 40, height: 20 }), 'Glass', { effects: [{ type: 'background-blur', blur: 6, visible: true }] })
    const result = roundTrip(sceneOf(blurred, glass))
    expect(result.svg).toContain('<feGaussianBlur stdDeviation="3"/>')
    expect(result.svg).toContain('<!-- Glass: 背景のぼかしは SVG で表せないので書いていない -->')
    expect(result.warnings).not.toContain('フィルタ')
    expect((result.byName('Soft') as RectNode).effects).toEqual([{ type: 'layer-blur', blur: 6, visible: true }])
    expect((result.byName('Glass') as RectNode).effects).toEqual([])
    // 影とぼかしを両方持てば、ぼかしは g に付ける（読み戻すとフレームのぼかしになる）
    const both = named(createRect({ x: 0, y: 0, width: 40, height: 20 }), 'Both', {
      effects: [{ type: 'drop-shadow', x: 0, y: 2, blur: 4, spread: 0, blendMode: 'normal', color: '#000000', opacity: 0.5, visible: true }, { type: 'layer-blur', blur: 4, visible: true }],
    })
    const again = roundTrip(sceneOf(both))
    expect(again.svg).toMatch(/<g id="Both" filter="url\(#kdr-blur-?\d*\)" data-kdr-shape="rect"><rect/)
    expect(again.warnings).not.toContain('フィルタ')
    // 1 つの矩形に戻り、影とレイヤーのぼかしの両方を持つ
    const back = again.byName('Both')
    expect(back.type).toBe('rect')
    expect(back.effects).toEqual([{ ...both.effects[0] }, { type: 'layer-blur', blur: 4, visible: true }])
  })

  it('描画モードは style の mix-blend-mode で書き、読み戻すとノードの描画モードになる', () => {
    const red = { type: 'solid' as const, color: '#ff0000', opacity: 1, visible: true, blendMode: 'normal' as const }
    const node = named(createRect({ x: 0, y: 0, width: 40, height: 20 }), 'Mul', { blendMode: 'multiply' })
    const fill = named(createEllipse({ x: 50, y: 0, width: 40, height: 20 }), 'Scr', { fills: [{ ...red, blendMode: 'screen' }] })
    const result = roundTrip(sceneOf(node, fill))
    expect(result.svg).toContain('style="mix-blend-mode:multiply"')
    expect(result.svg).toContain('style="mix-blend-mode:screen"')
    expect(result.byName('Mul').blendMode).toBe('multiply')
    expect(result.byName('Scr').blendMode).toBe('screen')
    // 読めない描画モードは知らせる
    const odd = convertSvg(parseSvgXml('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" style="mix-blend-mode:plus-lighter"/></svg>'), { name: 'x', measureText })
    expect(odd.warnings.map((warning) => warning.label)).toContain('描画モード（plus-lighter）')
  })

  it('回した円形のグラデーションは gradientTransform で書き、読み戻すと同じ角度になる', () => {
    const stops = [{ offset: 0, color: '#ffffff', opacity: 1 }, { offset: 1, color: '#000000', opacity: 1 }]
    const rect = named(createRect({ x: 0, y: 0, width: 80, height: 40 }), 'Tilt', {
      fills: [{ type: 'radial', cx: 0.4, cy: 0.5, rx: 0.5, ry: 0.25, angle: 30, fx: 0, fy: 0, stops, opacity: 1, visible: true, blendMode: 'normal' }],
    })
    const result = roundTrip(sceneOf(rect))
    expect(result.warnings).toEqual([])
    const fill = (result.byName('Tilt') as RectNode).fills[0]
    expect(fill.type).toBe('radial')
    if (fill.type !== 'radial') return
    close(fill.angle, 30)
    close(fill.rx, 0.5, 3)
    close(fill.ry, 0.25, 3)
    close(fill.cx, 0.4, 3)
  })

  it('円形のグラデーションの焦点は fx / fy で書き、回した楕円・回した図形でも読み戻すと同じ焦点になる', () => {
    const stops = [{ offset: 0, color: '#ffffff', opacity: 1 }, { offset: 1, color: '#000000', opacity: 1 }]
    const fill = (angle: number, fx: number, fy: number) => ({ type: 'radial' as const, cx: 0.4, cy: 0.6, rx: 0.5, ry: 0.25, angle, fx, fy, stops, opacity: 1, visible: true, blendMode: 'normal' as const })
    const plain = named(createRect({ x: 0, y: 0, width: 80, height: 40 }), 'Plain', { fills: [fill(0, 0.5, -0.25)] })
    const tilted = named(createRect({ x: 100, y: 0, width: 80, height: 40 }), 'Tilted', { fills: [fill(30, -0.6, 0.8)] })
    const turned = named(createEllipse({ x: 0, y: 100, width: 60, height: 40 }), 'Turned', { rotation: 45, fills: [fill(-60, 0.3, 0.3)] })
    const result = roundTrip(sceneOf(plain, tilted, turned))
    expect(result.svg).toContain('fx="0.5" fy="-0.25"')
    expect(result.warnings).toEqual([])
    for (const [name, fx, fy] of [['Plain', 0.5, -0.25], ['Tilted', -0.6, 0.8], ['Turned', 0.3, 0.3]] as const) {
      const back = (result.byName(name) as RectNode).fills[0]
      if (back.type !== 'radial') throw new Error(`${name} が円形ではない`)
      close(back.fx, fx, 3)
      close(back.fy, fy, 3)
    }
  })

  it('テキストの落ち影と画像の影を書き、読み戻すと効果になる', () => {
    const shadow: Effect = { type: 'drop-shadow', x: 0, y: 2, blur: 4, spread: 0, blendMode: 'normal', color: '#000000', opacity: 0.5, visible: true }
    const label = named(createText({ x: 0, y: 0, width: 10, height: 10 }, 'Hi'), 'Label', { effects: [shadow] })
    const result = roundTrip(sceneOf(label))
    expect(result.warnings).not.toContain('フィルタ')
    expect((result.byName('Label') as TextNode).effects).toMatchObject([{ type: 'drop-shadow', y: 2, blur: 4 }])
  })

  it('範囲（viewBox）は落ち影のはみ出しまで含む', () => {
    const shadow: Effect = { type: 'drop-shadow', x: 0, y: 4, blur: 4, spread: 0, blendMode: 'normal', color: '#000000', opacity: 0.5, visible: true }
    const card = named(createRect({ x: 10, y: 10, width: 40, height: 20 }), 'Card', { effects: [shadow] })
    const { svg } = roundTrip(sceneOf(card))
    expect(svg).toContain('viewBox="4 8 52 32"')
  })

  it('テキストの内側の影は一番上の塗りに書き、読み戻すと効果になる', () => {
    const inner: Effect = { type: 'inner-shadow', x: 1, y: 2, blur: 4, spread: 0, blendMode: 'normal', color: '#000000', opacity: 0.5, visible: true }
    const label = named(createText({ x: 0, y: 0, width: 10, height: 10 }, 'Hi'), 'Label', { effects: [inner] })
    const result = roundTrip(sceneOf(label))
    expect(result.warnings).not.toContain('フィルタ')
    expect((result.byName('Label') as TextNode).effects).toMatchObject([{ type: 'inner-shadow', x: 1, y: 2, blur: 4 }])
  })

  it('塗りがなくても内側の影は書く。線はそのまま', () => {
    const rect = named(createRect({ x: 0, y: 0, width: 40, height: 20 }), 'Ring', {
      fills: [],
      strokes: [{ type: 'solid', color: '#0000ff', opacity: 1, visible: true, blendMode: 'normal' as const }],
      strokeWidth: 2,
      effects: [{ type: 'inner-shadow', x: 0, y: 2, blur: 4, color: '#000000', opacity: 0.5, visible: true, spread: 0, blendMode: 'normal' }],
    })
    const { svg } = roundTrip(sceneOf(rect))
    // 図形の形だけを持つ要素（影だけを出す filter で、元の黒は出さない）と、線
    expect(svg).toMatch(/<rect [^>]*fill="#000000" filter="url\(#kdr-shadow-\d+\)" data-kdr-part="carrier"\/>/)
    expect(svg).not.toContain('SourceGraphic')
    expect(svg).toContain('stroke="#0000ff"')
  })

  it('隠した塗り・線・効果は書かない', () => {
    const rect = named(createRect({ x: 0, y: 0, width: 10, height: 10 }), 'Partly', {
      fills: [
        { type: 'solid', color: '#ff0000', opacity: 1, visible: true, blendMode: 'normal' as const },
        { type: 'solid', color: '#00ff00', opacity: 1, visible: false, blendMode: 'normal' as const },
      ],
      strokes: [{ type: 'solid', color: '#0000ff', opacity: 1, visible: false, blendMode: 'normal' as const }],
      strokeWidth: 2,
      effects: [{ type: 'drop-shadow', x: 0, y: 4, blur: 8, color: '#000000', opacity: 0.25, visible: false, spread: 0, blendMode: 'normal' }],
    })
    const { svg, byName } = roundTrip(sceneOf(rect))
    expect(svg).not.toContain('#00ff00')
    expect(svg).not.toContain('#0000ff')
    expect(svg).not.toContain('filter')
    expect((byName('Partly') as RectNode).fills).toEqual([{ type: 'solid', color: '#ff0000', opacity: 1, visible: true, blendMode: 'normal' as const }])
  })

  it('角度のグラデーションは扇形を並べた pattern で近似し、元の値を data 属性に残して読み戻せる', () => {
    const rect = named(createRect({ x: 0, y: 0, width: 40, height: 20 }), 'Wheel', {
      fills: [
        {
          type: 'conic',
          cx: 0.5,
          cy: 0.5,
          angle: 0,
          stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }],
          opacity: 0.5,
          visible: true,
          blendMode: 'normal',
        },
      ],
    })
    const { svg, warnings, byName } = roundTrip(sceneOf(rect))
    expect(svg).toMatch(
      /<pattern id="kdr-paint-\d+" data-kdr-conic="20 10 0 0.5" data-kdr-stops="0 #ff0000,1 #0000ff" patternUnits="userSpaceOnUse" x="-40" y="-40" width="120" height="100"><g opacity="0.5">/,
    )
    expect(svg.match(/<path d="M20 10 /g)).toHaveLength(CONIC_WEDGES)
    // 最初の扇形は右（0°）から始まり、始まりの色に近い。最後は終わりの色に近い
    expect(svg).toContain('fill="#fc0003"')
    expect(svg).toContain('fill="#0300fc"')
    expect(warnings).not.toContain('パターンの塗り')
    expect((byName('Wheel') as RectNode).fills).toEqual(rect.fills)
  })

  it('グラデーションの色ごとの不透明度は stop-opacity（塗りの不透明度と掛け合わせる）で書き、読み戻すと色ごとの不透明度になる', () => {
    const stops = [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#ff0000', opacity: 0 }]
    const common = { visible: true, blendMode: 'normal' as const }
    const linear = named(createRect({ x: 0, y: 0, width: 40, height: 20 }), 'Fade', {
      fills: [{ type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops, opacity: 1, ...common }],
    })
    const radial = named(createRect({ x: 50, y: 0, width: 40, height: 20 }), 'Glow', {
      fills: [{ type: 'radial', cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, angle: 0, fx: 0, fy: 0, stops: [stops[0], { ...stops[1], opacity: 0.5 }], opacity: 0.5, ...common }],
    })
    const conic = named(createRect({ x: 100, y: 0, width: 40, height: 20 }), 'Spin', {
      fills: [{ type: 'conic', cx: 0.5, cy: 0.5, angle: 0, stops: [stops[0], { ...stops[1], opacity: 0.25 }], opacity: 1, ...common }],
    })
    const { svg, warnings, byName } = roundTrip(sceneOf(linear, radial, conic))
    expect(svg).toMatch(/<stop offset="0" stop-color="#ff0000"\/><stop offset="1" stop-color="#ff0000" stop-opacity="0"\/>/)
    expect(svg).toMatch(/<stop offset="0" stop-color="#ff0000" stop-opacity="0.5"\/><stop offset="1" stop-color="#ff0000" stop-opacity="0.25"\/>/)
    expect(svg).toContain('data-kdr-stops="0 #ff0000,1 #ff0000 0.25"')
    expect(svg).toContain('fill-opacity=')
    expect(warnings).toEqual([])
    expect((byName('Fade') as RectNode).fills[0]).toMatchObject({ type: 'linear', opacity: 1, stops })
    // 塗りの不透明度は色ごとの不透明度に掛け合わせて戻る（見た目は同じ）
    expect((byName('Glow') as RectNode).fills[0]).toMatchObject({
      type: 'radial',
      opacity: 1,
      stops: [{ offset: 0, color: '#ff0000', opacity: 0.5 }, { offset: 1, color: '#ff0000', opacity: 0.25 }],
    })
    expect((byName('Spin') as RectNode).fills).toEqual(conic.fills)
  })

  it('角度のグラデーションは回した図形・中心のずれ・向きも往復する。data 属性のない pattern は知らせて読まない', () => {
    const fills = [
      {
        type: 'conic' as const,
        cx: 0.25,
        cy: 0.75,
        angle: 45,
        stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 0.4, color: '#00ff00', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }],
        opacity: 1,
        visible: true,
        blendMode: 'normal' as const,
      },
    ]
    const turned = named(createEllipse({ x: 10, y: 20, width: 60, height: 40 }), 'Turned', { rotation: 30, fills })
    const back = (roundTrip(sceneOf(turned)).byName('Turned') as EllipseNode).fills[0]
    expect(back).toMatchObject({ type: 'conic', angle: 45, stops: fills[0].stops })
    if (back.type !== 'conic') throw new Error('conic ではない')
    close(back.cx, 0.25, 3)
    close(back.cy, 0.75, 3)
    const plain = convertSvg(
      parseSvgXml('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><defs><pattern id="p" width="4" height="4"/></defs><rect width="10" height="10" fill="url(#p)"/></svg>'),
      { name: 'plain', measureText },
    )
    expect(plain.warnings.map((warning) => warning.label)).toContain('パターンの塗り')
  })

  it('レイヤー名は要素の id になり、重なれば番号を付け、記号は _ にする', () => {
    const a = named(createRect({ x: 0, y: 0, width: 10, height: 10 }), 'a', { name: 'My Box' })
    const b = named(createRect({ x: 20, y: 0, width: 10, height: 10 }), 'b', { name: 'My Box' })
    const c = named(createRect({ x: 40, y: 0, width: 10, height: 10 }), 'c', { name: '1st <box>' })
    const { svg } = roundTrip(sceneOf(a, b, c))
    expect(svg).toContain('id="My_Box"')
    expect(svg).toContain('id="My_Box_2"')
    expect(svg).toContain('id="_1st_box_"')
  })

  it('塗りがいくつもあれば、描画と同じく下から順に要素を重ねる。フレームの枠線は子より手前', () => {
    const rect = named(createRect({ x: 0, y: 0, width: 10, height: 10 }), 'Layers', {
      fills: [
        { type: 'solid', color: '#ff0000', opacity: 1, visible: true, blendMode: 'normal' as const },
        { type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }], opacity: 0.5, visible: true, blendMode: 'normal' as const },
      ],
    })
    const frame = named(createFrame({ x: 20, y: 0, width: 50, height: 50 }), 'Box', {
      strokes: [{ type: 'solid', color: '#0000ff', opacity: 1, visible: true, blendMode: 'normal' as const }],
      strokeWidth: 2,
    })
    const child = named(createRect({ x: 5, y: 5, width: 10, height: 10 }), 'Child', { parentId: 'Box' })
    const { svg } = roundTrip(sceneOf(rect, frame, child))
    expect(svg).toMatch(/<g id="Layers" data-kdr-shape="rect"><rect [^>]*fill="#ff0000"\/><rect [^>]*fill="url\(#kdr-paint-\d+\)"\/><\/g>/)
    expect(svg).toContain('stop-opacity="0.5"')
    expect(svg).toMatch(/id="Child".*<rect [^>]*fill="none" stroke="#0000ff" stroke-width="2"\/><\/g>/)
  })

  it('グラデーションの線の矢印は、端の図形も同じグラデーションで塗る', () => {
    const line = named(createLine({ x: 0, y: 0, width: 100, height: 20 }), 'Grad', {
      endCap: 'arrow',
      strokes: [{ type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }], opacity: 1, visible: true, blendMode: 'normal' as const }],
    })
    const { svg } = roundTrip(sceneOf(line))
    const id = /<linearGradient id="([^"]+)"/.exec(svg)![1]
    expect(svg).toContain(`<polygon points="100,20 `)
    expect(svg).toContain(`fill="url(#${id})" stroke="none"`)
  })

  it('フォントの実際の高さを渡すと、基線を描画と同じ位置（行の高さの中で上下の高さを真ん中に）に置く', () => {
    const text = named(createText({ x: 0, y: 0, width: 0, height: 0 }, 'A\nB'), 'T', { fontSize: 20, lineHeight: 1.5 })
    const scene = sceneOf(text)
    // 渡さなければ取り込みと同じ見積もり（上 0.9・下 0.22）
    expect(textBaseline(text, estimateTextMetrics(text))).toBeCloseTo((30 - 22.4) / 2 + 18)
    expect(exportSvg(scene, ['T'], { assets: {} })).toContain('<tspan x="0" y="21.8">A</tspan><tspan x="0" y="51.8">B</tspan>')
    // 上 16・下 4 のフォント: (30 - 20) / 2 + 16 = 21
    const measured = exportSvg(scene, ['T'], { assets: {}, textMetrics: () => ({ ascent: 16, descent: 4 }) })
    expect(measured).toContain('<tspan x="0" y="21">A</tspan><tspan x="0" y="51">B</tspan>')
  })

  describe('テキストの上下の位置（書き出しと取り込みで同じフォントの高さを使う）', () => {
    // 見積もり（上 0.9・下 0.22）と違う高さのフォント。ブラウザの書体はおおむねこのくらい見積もりからずれる
    const textMetrics = (node: Pick<TextNode, 'fontSize'>) => ({ ascent: node.fontSize * 0.96, descent: node.fontSize * 0.24 })
    const cases: { label: string; text: string; patch: Partial<TextNode> }[] = [
      { label: '1 行・既定', text: 'Hello', patch: {} },
      { label: '複数行・行の高さ 1.5', text: 'A\nBB\nCCC', patch: { lineHeight: 1.5, fontSize: 20 } },
      { label: '複数行・行の高さ 1・中央揃え', text: 'One\nTwo', patch: { lineHeight: 1, fontSize: 32, textAlign: 'center' } },
      { label: '複数行・行の高さ 2.25・右揃え・小さい字', text: 'x\ny\nz\nw', patch: { lineHeight: 2.25, fontSize: 9, textAlign: 'right' } },
      { label: '大きい字・太字', text: 'Big\nText', patch: { fontSize: 72, fontWeight: 700, lineHeight: 1.1 } },
    ]
    for (const { label, text, patch } of cases) {
      it(`${label}: 取り込み直すと位置と行の高さが 0.5px 以内で揃う`, () => {
        const frame = named(createFrame({ x: 0, y: 0, width: 300, height: 400 }), 'Frame')
        const node = named(createText({ x: 13, y: 27, width: 0, height: 0 }, text), 'T', { ...patch, parentId: 'Frame' })
        const scene = sceneOf(frame, node)
        const svg = exportSvg(scene, ['Frame'], { assets: {}, textMetrics })
        const result = convertSvg(parseSvgXml(svg), { name: 'export', measureText, textMetrics })
        const imported: Scene = { nodes: result.fragment.nodes, rootIds: result.fragment.rootIds }
        const back = Object.values(imported.nodes).find((n): n is TextNode => n.type === 'text')!
        const a = getAbsoluteBounds(scene, 'T')
        const b = getAbsoluteBounds(imported, back.id)
        expect(Math.abs(b.x - a.x)).toBeLessThanOrEqual(0.5)
        expect(Math.abs(b.y - a.y)).toBeLessThanOrEqual(0.5)
        expect(back.fontSize).toBe(scene.nodes.T.type === 'text' ? scene.nodes.T.fontSize : 0)
        if (text.includes('\n')) expect(back.lineHeight).toBeCloseTo((scene.nodes.T as TextNode).lineHeight, 3)
      })
    }

    it('1 行のテキストは行の高さを読めないが、基線（文字の位置）は揃う', () => {
      const node = named(createText({ x: 0, y: 10, width: 0, height: 0 }, 'Solo'), 'T', { fontSize: 24, lineHeight: 1.8 })
      const scene = sceneOf(node)
      const svg = exportSvg(scene, ['T'], { assets: {}, textMetrics })
      const back = Object.values(convertSvg(parseSvgXml(svg), { name: 'export', measureText, textMetrics }).fragment.nodes).find((n): n is TextNode => n.type === 'text')!
      expect(back.lineHeight).toBe(1.2)
      const original = scene.nodes.T as TextNode
      // 書き出した範囲の左上（ここではテキストの左上）からの基線の位置
      expect(Math.abs(back.y + textBaseline(back, textMetrics(back)) - textBaseline(original, textMetrics(original)))).toBeLessThanOrEqual(0.01)
    })

    it('取り込みでフォントの高さを測らないと、見積もりとの差だけずれる（直す前の振る舞い）', () => {
      const node = named(createText({ x: 0, y: 0, width: 0, height: 0 }, 'A\nB'), 'T', { fontSize: 40, lineHeight: 1.2 })
      const scene = sceneOf(node)
      const svg = exportSvg(scene, ['T'], { assets: {}, textMetrics })
      const back = Object.values(convertSvg(parseSvgXml(svg), { name: 'export', measureText }).fragment.nodes).find((n) => n.type === 'text')!
      // (0.96 - 0.9) - (0.96 + 0.24 - 1.12) / 2 = 0.02 → 40px で 0.8px
      expect(back.y).toBeCloseTo(0.8, 5)
    })
  })

  it('ids: false なら id を付けず、background を渡すと範囲全体に背景の矩形を敷く', () => {
    const rect = named(createRect({ x: 10, y: 20, width: 30, height: 40 }), 'Box')
    const scene = sceneOf(rect)
    const svg = exportSvg(scene, ['Box'], { assets: {}, ids: false, background: '#ffffff' })
    expect(svg).not.toContain('id="Box"')
    expect(svg).toContain('<rect x="10" y="20" width="30" height="40" fill="#ffffff"/><rect transform="translate(10 20)"')
    // 背景も矩形として読み戻せる
    const result = convertSvg(parseSvgXml(svg), { name: 'export', measureText })
    expect(Object.values(result.fragment.nodes).filter((node) => node.type === 'rect')).toHaveLength(2)
  })

  it('何もなければエラー', () => {
    expect(() => exportSvg({ nodes: {}, rootIds: [] }, [], { assets: {} })).toThrow('書き出すものがありません')
  })
})

describe('マスク', () => {
  it('マスクは書かず、手前の兄弟をマスクの形の clipPath で切り取る。読み戻すとマスクのパスに戻る', () => {
    const outer = named(createFrame({ x: 0, y: 0, width: 200, height: 200 }), 'Card', { fills: [] })
    const mask = named(createEllipse({ x: 20, y: 20, width: 100, height: 60 }), 'Oval', { parentId: 'Card', isMask: true })
    const photo = named(createRect({ x: 0, y: 0, width: 150, height: 150 }), 'Photo', { parentId: 'Card' })
    const after = named(createRect({ x: 160, y: 0, width: 20, height: 20 }), 'Plain', { parentId: 'Card' })
    const scene = sceneOf(outer, mask, photo, after)
    const { svg, byName, imported, warnings } = roundTrip(scene)
    expect(svg).toContain('<clipPath id="Oval"><path d="M120 50')
    expect(svg).toMatch(/<g clip-path="url\(#Oval\)"><rect id="Photo"[^>]*\/><rect id="Plain"/)
    expect(warnings).toEqual([])
    const oval = byName('Oval') as PathNode
    expect(oval).toMatchObject({ type: 'path', isMask: true })
    const group = imported.nodes[oval.parentId!]
    expect(group.type === 'frame' && group.children.map((id) => imported.nodes[id].name)).toEqual(['Oval', 'Photo', 'Plain'])
    const box = getAbsoluteBounds(imported, oval.id)
    close(box.x, 20)
    close(box.width, 100)
  })

  it('書き出すノードだけを選んでも、かかっているマスクはかける。隠したマスクは何もかけない', () => {
    const mask = named(createRect({ x: 0, y: 0, width: 50, height: 50 }), 'M', { isMask: true, rotation: 45 })
    const photo = named(createRect({ x: 0, y: 0, width: 100, height: 100 }), 'P')
    const scene = sceneOf(mask, photo)
    expect(exportSvg(scene, ['P'], { assets: {} })).toContain('clip-path="url(#M)"')
    const hidden = { ...scene, nodes: { ...scene.nodes, M: { ...mask, visible: false } } }
    expect(exportSvg(hidden, ['M', 'P'], { assets: {} })).not.toContain('clip-path')
  })

  it('明るさのマスクは、塗りで透かす mask に書き、読み戻すと明るさのマスクに戻る', () => {
    const outer = named(createFrame({ x: 0, y: 0, width: 200, height: 200 }), 'Card', { fills: [] })
    const fade = {
      type: 'linear' as const, x1: 0, y1: 0.5, x2: 1, y2: 0.5, opacity: 1, visible: true, blendMode: 'normal' as const,
      stops: [{ offset: 0, color: '#ffffff', opacity: 1 }, { offset: 1, color: '#000000', opacity: 1 }],
    }
    const mask = named(createRect({ x: 10, y: 10, width: 100, height: 80 }), 'Fade', { parentId: 'Card', isMask: true, maskType: 'luminance', fills: [fade] })
    const photo = named(createRect({ x: 0, y: 0, width: 150, height: 150 }), 'Photo', { parentId: 'Card' })
    const scene = sceneOf(outer, mask, photo)
    const { svg, byName, imported, warnings } = roundTrip(scene)
    expect(svg).toMatch(/<mask id="Fade" maskUnits="userSpaceOnUse" x="10" y="10" width="100" height="80"><rect /)
    expect(svg).toContain('<g mask="url(#Fade)"><rect id="Photo"')
    expect(warnings).toEqual([])
    const back = byName('Fade') as RectNode
    expect(back).toMatchObject({ type: 'rect', isMask: true, maskType: 'luminance' })
    expect(back.fills[0]).toMatchObject({ type: 'linear' })
    const group = imported.nodes[back.parentId!]
    expect(group.type === 'frame' && group.children.map((id) => imported.nodes[id].name)).toEqual(['Fade', 'Photo'])
    close(getAbsoluteBounds(imported, back.id).x, 10)
  })

  it('不透明度のマスクは mask-type:alpha を付け、読み戻すと不透明度のマスクに戻る', () => {
    const mask = named(createEllipse({ x: 0, y: 0, width: 50, height: 50 }), 'A', { isMask: true, maskType: 'alpha' })
    const photo = named(createRect({ x: 0, y: 0, width: 100, height: 100 }), 'P')
    const { svg, byName } = roundTrip(sceneOf(mask, photo))
    expect(svg).toContain('style="mask-type:alpha"')
    expect(byName('A')).toMatchObject({ isMask: true, maskType: 'alpha' })
  })
})

describe('ブーリアン演算のノード', () => {
  it('結果の形の path（evenodd）として書き、子は書かない', () => {
    const node = named(createFrame({ x: 0, y: 0, width: 150, height: 100 }), 'Union', { booleanOperation: 'union', clipContent: false })
    const a = named(createRect({ x: 0, y: 0, width: 100, height: 100 }), 'A', { parentId: 'Union' })
    const b = named(createEllipse({ x: 50, y: 0, width: 100, height: 100 }), 'B', { parentId: 'Union' })
    const { svg, byName, imported } = roundTrip(sceneOf(node, a, b))
    expect(svg).toMatch(/<path id="Union" d="M/)
    expect(svg).not.toContain('id="A"')
    const back = byName('Union') as PathNode
    expect(back).toMatchObject({ type: 'path', fillRule: 'evenodd' })
    expectSameBounds(sceneOf(node, a, b), 'Union', imported, back.id, { x: 0, y: 0 })
  })
})

describe('1 つのノードを g にまとめた書き出しを、1 つのノードに戻す', () => {
  const solid = (color: string, opacity = 1) => ({ type: 'solid' as const, color, opacity, visible: true, blendMode: 'normal' as const })

  it('塗りが 2 つの矩形は、塗り 2 つの矩形 1 つに戻る（フレームにならない）', () => {
    const fills = [solid('#ff0000'), { type: 'linear' as const, x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }], opacity: 0.5, visible: true, blendMode: 'normal' as const }]
    const rect = named(createRect({ x: 10, y: 20, width: 80, height: 40 }), 'Layers', {
      fills,
      strokes: [solid('#0000ff')],
      strokeWidth: 3,
      strokeDashes: [6, 2],
      cornerRadius: 6,
      rotation: 20,
      opacity: 0.8,
    })
    const scene = sceneOf(rect)
    const { imported, byName, origin } = roundTrip(scene)
    expect(Object.values(imported.nodes).filter((node) => node.type !== 'frame' || node.name !== 'export')).toHaveLength(1)
    const back = byName('Layers') as RectNode
    expect(back.type).toBe('rect')
    expect(back.fills).toHaveLength(2)
    expect(back.fills[0]).toEqual(fills[0])
    expect(back.fills[1]).toMatchObject({ type: 'linear', opacity: 0.5 })
    expect(back.strokes).toEqual([solid('#0000ff')])
    expect(back.strokeWidth).toBe(3)
    expect(back.strokeDashes).toEqual([6, 2])
    expect(back.cornerRadius).toBeCloseTo(6)
    expect(back.opacity).toBe(0.8)
    close(back.rotation, 20)
    expectSameBounds(scene, 'Layers', imported, back.id, origin)
  })

  it('両端に矢印のある線は、端の形を持つ線 1 つに戻る（長さも元のまま）', () => {
    const line = named(createLine({ x: 10, y: 10, width: 100, height: 0, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }), 'Both ends', {
      startCap: 'arrow',
      endCap: 'diamond',
      strokes: [solid('#333333')],
      strokeWidth: 2,
    })
    const scene = sceneOf(line)
    const { imported, byName, origin, svg } = roundTrip(scene)
    expect(svg).toContain('data-kdr-caps="arrow diamond"')
    const back = byName('Both_ends') as PathNode
    expect(back.type).toBe('path')
    expect(back).toMatchObject({ startCap: 'arrow', endCap: 'diamond', strokeWidth: 2, fills: [] })
    expect(back.strokes).toEqual([solid('#333333')])
    expect(Object.values(imported.nodes).filter((node) => node.type === 'path')).toHaveLength(1)
    expectSameBounds(scene, 'Both ends', imported, back.id, origin)
  })

  it('塗り 2 つと矢印と影のある開いたパスも 1 つのパスに戻る', () => {
    const path = named(
      createPath({ x: 5, y: 5, width: 60, height: 40, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }, false),
      'Hook',
      {
        fills: [solid('#00ff00'), solid('#ff00ff', 0.5)],
        strokes: [solid('#000000')],
        strokeWidth: 2,
        endCap: 'arrow',
        effects: [{ type: 'drop-shadow', x: 0, y: 2, blur: 4, spread: 0, blendMode: 'normal', color: '#000000', opacity: 0.3, visible: true }],
      },
    )
    const scene = sceneOf(path)
    const { imported, byName, origin } = roundTrip(scene)
    const back = byName('Hook') as PathNode
    expect(back).toMatchObject({ type: 'path', endCap: 'arrow', startCap: 'none', closed: false })
    expect(back.fills.map((fill) => fill.type === 'solid' && fill.color)).toEqual(['#00ff00', '#ff00ff'])
    expect(back.strokes).toHaveLength(1)
    expect(back.effects).toEqual(path.effects)
    expect(Object.values(imported.nodes).filter((node) => node.type === 'path')).toHaveLength(1)
    expectSameBounds(scene, 'Hook', imported, back.id, origin)
  })

  it('輪郭が 2 つある矢印の線（塗りなし）も、輪郭 2 つのパス 1 つに戻る', () => {
    const shape = pathFromContours([
      { vertices: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 40 }], closed: false },
      { vertices: [{ x: 20, y: 60 }, { x: 60, y: 60 }, { x: 60, y: 80 }], closed: true },
    ])
    const path = named({ ...createPath(shape, false), contours: shape.contours }, 'Two', {
      fills: [],
      strokes: [solid('#112233')],
      strokeWidth: 2,
      startCap: 'circle',
      endCap: 'arrow',
    })
    const scene = sceneOf(path)
    const { byName, imported, origin, svg } = roundTrip(scene)
    expect(svg).toContain('data-kdr-part="rest"')
    const back = byName('Two') as PathNode
    expect(back).toMatchObject({ type: 'path', startCap: 'circle', endCap: 'arrow', closed: false, fills: [] })
    expect(back.contours).toHaveLength(1)
    expect(Object.values(imported.nodes).filter((node) => node.type === 'path')).toHaveLength(1)
    expectSameBounds(scene, 'Two', imported, back.id, origin)
  })

  it('塗りが 2 つのテキストは、塗り 2 つのテキスト 1 つに戻る', () => {
    const text = named(createText({ x: 0, y: 0, width: 0, height: 0 }, 'Hi'), 'Duo', { fills: [solid('#ff0000'), solid('#0000ff', 0.5)] })
    const { byName, imported } = roundTrip(sceneOf(text))
    const back = byName('Duo') as TextNode
    expect(back.type).toBe('text')
    expect(back.fills).toEqual([solid('#ff0000'), solid('#0000ff', 0.5)])
    expect(Object.values(imported.nodes).filter((node) => node.type === 'text')).toHaveLength(1)
  })

  it('印があっても中身の形が揃わなければ、ふつうのグループ（フレーム）にする', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><g id="Mixed" data-kdr-shape="rect"><rect width="10" height="10"/><circle cx="50" cy="50" r="5"/></g></svg>'
    const result = convertSvg(parseSvgXml(svg), { name: 'x', measureText })
    const group = Object.values(result.fragment.nodes).find((node) => node.name === 'Mixed')
    expect(group?.type).toBe('frame')
  })
})
