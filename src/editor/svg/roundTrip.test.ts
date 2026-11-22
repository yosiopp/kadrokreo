import { describe, expect, it } from 'vitest'
import { getAbsoluteBounds, getNodesBounds } from '../../document/geometry.ts'
import { pathFromContours, pathOutlines, pathPoints } from '../../document/path.ts'
import { sha256Hex } from '../../document/sha256.ts'
import { estimateTextMetrics, exportSvg, textBaseline } from '../../document/svgExport.ts'
import { CONIC_WEDGES } from '../../document/svgShapes.ts'
import type { Asset, Effect, ImageNode, PathNode, RectNode, Scene, SceneNode, TextNode } from '../../document/types.ts'
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
  const origin = getNodesBounds(scene, targets)!
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
      fills: [{ type: 'solid', color: '#3366ff', opacity: 1, visible: true }],
      strokes: [{ type: 'solid', color: '#112233', opacity: 1, visible: true }],
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
      fills: [{ type: 'linear', x1: 0.1, y1: 0.2, x2: 0.8, y2: 1.1, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }], opacity: 1, visible: true }],
    })
    const rect = named(createRect({ x: 120, y: 0, width: 80, height: 40 }), 'Glow', {
      fills: [{ type: 'radial', cx: 0.3, cy: 0.4, rx: 0.5, ry: 0.25, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }], opacity: 1, visible: true }],
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

  it('塗りの不透明度は読み戻すとノードの不透明度に寄る', () => {
    const rect = named(createRect({ x: 0, y: 0, width: 10, height: 10 }), 'Half', {
      fills: [{ type: 'solid', color: '#ff0000', opacity: 0.4, visible: true }],
    })
    const back = roundTrip(sceneOf(rect)).byName('Half')
    close(back.opacity, 0.4)
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
      fills: [{ type: 'solid', color: '#00aa00', opacity: 1, visible: true }],
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

  it('直線は端の形（丸）・破線・太さが揃う', () => {
    const line = named(createLine({ x: 0, y: 0, width: 80, height: 40 }), 'Arrow', {
      startCap: 'round',
      endCap: 'round',
      strokeWidth: 4,
      strokeDashes: [8, 4],
      strokes: [{ type: 'solid', color: '#222222', opacity: 1, visible: true }],
    })
    const scene = sceneOf(line)
    const { byName, imported, origin } = roundTrip(scene)
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
    expect(svg).toMatch(/<g id="Pointer"><line [^>]*\/><polygon [^>]*fill="#000000"/)
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
      fills: [{ type: 'solid', color: '#333333', opacity: 1, visible: true }],
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
      effects: [{ type: 'drop-shadow', x: 4, y: 0, blur: 6, color: '#000000', opacity: 0.25, visible: true }],
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
      { type: 'drop-shadow', x: 0, y: 4, blur: 8, color: '#000000', opacity: 0.25, visible: true },
      { type: 'inner-shadow', x: 3, y: -2, blur: 6, color: '#ff0000', opacity: 0.5, visible: true },
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
      expect(effect).toMatchObject({ type: effects[i].type, color: effects[i].color, opacity: effects[i].opacity })
      close(effect.x, effects[i].x)
      close(effect.y, effects[i].y)
      close(effect.blur, effects[i].blur)
    })
  })

  it('塗りがなくても内側の影は書く。線はそのまま', () => {
    const rect = named(createRect({ x: 0, y: 0, width: 40, height: 20 }), 'Ring', {
      fills: [],
      strokes: [{ type: 'solid', color: '#0000ff', opacity: 1, visible: true }],
      strokeWidth: 2,
      effects: [{ type: 'inner-shadow', x: 0, y: 2, blur: 4, color: '#000000', opacity: 0.5, visible: true }],
    })
    const { svg } = roundTrip(sceneOf(rect))
    // 図形の形だけを持つ要素（影だけを出す filter で、元の黒は出さない）と、線
    expect(svg).toMatch(/<rect [^>]*fill="#000000" filter="url\(#kdr-shadow-\d+\)"\/>/)
    expect(svg).not.toContain('SourceGraphic')
    expect(svg).toContain('stroke="#0000ff"')
  })

  it('隠した塗り・線・効果は書かない', () => {
    const rect = named(createRect({ x: 0, y: 0, width: 10, height: 10 }), 'Partly', {
      fills: [
        { type: 'solid', color: '#ff0000', opacity: 1, visible: true },
        { type: 'solid', color: '#00ff00', opacity: 1, visible: false },
      ],
      strokes: [{ type: 'solid', color: '#0000ff', opacity: 1, visible: false }],
      strokeWidth: 2,
      effects: [{ type: 'drop-shadow', x: 0, y: 4, blur: 8, color: '#000000', opacity: 0.25, visible: false }],
    })
    const { svg, byName } = roundTrip(sceneOf(rect))
    expect(svg).not.toContain('#00ff00')
    expect(svg).not.toContain('#0000ff')
    expect(svg).not.toContain('filter')
    expect((byName('Partly') as RectNode).fills).toEqual([{ type: 'solid', color: '#ff0000', opacity: 1, visible: true }])
  })

  it('角度のグラデーションは扇形を並べた pattern で近似する（読み戻すとパターンの塗りとして知らせる）', () => {
    const rect = named(createRect({ x: 0, y: 0, width: 40, height: 20 }), 'Wheel', {
      fills: [
        {
          type: 'conic',
          cx: 0.5,
          cy: 0.5,
          angle: 0,
          stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }],
          opacity: 0.5,
          visible: true,
        },
      ],
    })
    const { svg, warnings } = roundTrip(sceneOf(rect))
    expect(svg).toMatch(/<pattern id="kdr-paint-\d+" patternUnits="userSpaceOnUse" x="-40" y="-40" width="120" height="100"><g opacity="0.5">/)
    expect(svg.match(/<path d="M20 10 /g)).toHaveLength(CONIC_WEDGES)
    // 最初の扇形は右（0°）から始まり、始まりの色に近い。最後は終わりの色に近い
    expect(svg).toContain('fill="#fc0003"')
    expect(svg).toContain('fill="#0300fc"')
    expect(warnings).toContain('パターンの塗り')
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
        { type: 'solid', color: '#ff0000', opacity: 1, visible: true },
        { type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], opacity: 0.5, visible: true },
      ],
    })
    const frame = named(createFrame({ x: 20, y: 0, width: 50, height: 50 }), 'Box', {
      strokes: [{ type: 'solid', color: '#0000ff', opacity: 1, visible: true }],
      strokeWidth: 2,
    })
    const child = named(createRect({ x: 5, y: 5, width: 10, height: 10 }), 'Child', { parentId: 'Box' })
    const { svg } = roundTrip(sceneOf(rect, frame, child))
    expect(svg).toMatch(/<g id="Layers"><rect [^>]*fill="#ff0000"\/><rect [^>]*fill="url\(#kdr-paint-\d+\)"\/><\/g>/)
    expect(svg).toContain('stop-opacity="0.5"')
    expect(svg).toMatch(/id="Child".*<rect [^>]*fill="none" stroke="#0000ff" stroke-width="2"\/><\/g>/)
  })

  it('グラデーションの線の矢印は、端の図形も同じグラデーションで塗る', () => {
    const line = named(createLine({ x: 0, y: 0, width: 100, height: 20 }), 'Grad', {
      endCap: 'arrow',
      strokes: [{ type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }], opacity: 1, visible: true }],
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
