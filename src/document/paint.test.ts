import { describe, expect, it } from 'vitest'
import { blurRadius, getPaintedBounds, hasStroke, miterTips, textInkBox, imageRect, radialTransform, isAngleLine, linearAngle, linearFromAngle, solid, splitEffects, withoutHidden } from './paint.ts'
import { frame, path, rect, sceneOf, text } from './testNodes.ts'

describe('imageRect', () => {
  const box = { width: 100, height: 100, positionX: 0.5, positionY: 0.5, scale: 1 }
  // 横長（200 × 100）の画像
  const wide = { width: 200, height: 100 }

  it('収め方ごとの大きさを、余りを寄せる位置で配って置く', () => {
    expect(imageRect({ ...box, fit: 'cover' }, wide)).toEqual({ x: -50, y: 0, width: 200, height: 100 })
    expect(imageRect({ ...box, fit: 'contain' }, wide)).toEqual({ x: 0, y: 25, width: 100, height: 50 })
    expect(imageRect({ ...box, fit: 'stretch' }, wide)).toEqual({ x: 0, y: 0, width: 100, height: 100 })
    expect(imageRect({ ...box, fit: 'cover', positionX: 0 }, wide)).toEqual({ x: 0, y: 0, width: 200, height: 100 })
    expect(imageRect({ ...box, fit: 'cover', positionX: 1 }, wide)).toEqual({ x: -100, y: 0, width: 200, height: 100 })
  })

  it('切り抜きの拡大は、収めた大きさを倍にして、はみ出しを寄せる位置で配る', () => {
    expect(imageRect({ ...box, fit: 'cover', scale: 2 }, wide)).toEqual({ x: -150, y: -50, width: 400, height: 200 })
    expect(imageRect({ ...box, fit: 'cover', scale: 2, positionX: 0, positionY: 1 }, wide)).toEqual({ x: 0, y: -100, width: 400, height: 200 })
    expect(imageRect({ ...box, fit: 'contain', scale: 3 }, wide)).toEqual({ x: -100, y: -25, width: 300, height: 150 })
    expect(imageRect({ ...box, fit: 'stretch', scale: 2, positionX: 0 }, wide)).toEqual({ x: 0, y: -50, width: 200, height: 200 })
  })

  it('大きさのない画像は引き伸ばしと同じに置く', () => {
    expect(imageRect({ ...box, fit: 'cover', scale: 2 }, { width: 0, height: 0 })).toEqual({ x: -50, y: -50, width: 200, height: 200 })
  })
})

describe('塗り・効果の表示', () => {
  const hidden = { type: 'solid' as const, color: '#00ff00', opacity: 1, visible: false, blendMode: 'normal' as const }
  const inner = { type: 'inner-shadow' as const, x: 0, y: 1, blur: 2, color: '#000000', opacity: 1, visible: true, spread: 0 , blendMode: 'normal' as const}
  const drop = { ...inner, type: 'drop-shadow' as const }

  it('withoutHidden は隠した塗り・線・効果を除く。何も隠していなければ同じオブジェクト', () => {
    const shown = { fills: solid('#ff0000'), strokes: solid('#0000ff'), effects: [drop] }
    expect(withoutHidden(shown)).toBe(shown)
    const partly = { ...shown, fills: [...shown.fills, hidden], effects: [drop, { ...inner, visible: false }] }
    expect(withoutHidden(partly)).toEqual({ ...shown, effects: [drop] })
    expect(partly.fills).toHaveLength(2)
  })

  it('隠した線だけなら線を引かない', () => {
    expect(hasStroke({ strokes: [hidden], strokeWidth: 2 })).toBe(false)
    expect(hasStroke({ strokes: [hidden, ...solid('#000000')], strokeWidth: 2 })).toBe(true)
  })

  it('splitEffects は落ち影と内側の影に分ける', () => {
    expect(splitEffects([inner, drop, inner])).toEqual({ drop: [drop], inner: [inner, inner] })
  })
})

describe('直線のグラデーションの向き', () => {
  const size = { width: 200, height: 100 }

  it('向きだけを決めた線は、枠の中心を通り枠の角が両端の色になる', () => {
    expect(linearFromAngle(0, size)).toEqual({ x1: 0, y1: 0.5, x2: 1, y2: 0.5 })
    expect(linearFromAngle(90, size)).toEqual({ x1: 0.5, y1: 0, x2: 0.5, y2: 1 })
    const diagonal = linearFromAngle(30, size)
    expect(linearAngle(diagonal, size)).toBe(30)
    expect(isAngleLine(diagonal, size)).toBe(true)
    // 幅が 0 の向きは中央に置く
    expect(linearFromAngle(0, { width: 0, height: 100 })).toEqual({ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 })
  })

  it('向きはピクセルで測る。自由に置いた線は向きだけの線と違う', () => {
    // 角から角への線は、その向きの「向きだけの線」と同じ（CSS の線も角を通る）
    const corner = { x1: 0, y1: 0, x2: 1, y2: 1 }
    expect(linearAngle(corner, size)).toBeCloseTo(26.57, 2)
    expect(isAngleLine(corner, size)).toBe(true)
    expect(isAngleLine({ x1: 0, y1: 0, x2: 1, y2: 0.5 }, size)).toBe(false)
    expect(linearAngle({ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 }, size)).toBe(0)
  })
})

describe('radialTransform と blurRadius', () => {
  it('円形のグラデーションの楕円は、半径に伸ばしてから回して中心へ動かす', () => {
    const size = { width: 100, height: 50 }
    expect(radialTransform({ cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, angle: 0 }, size)).toEqual([50, 0, 0, 25, 50, 25])
    const [a, b, c, d, e, f] = radialTransform({ cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, angle: 90 }, size)
    // 90° 回すと、横の半径（50px）が下向き、縦の半径（25px）が左向き
    expect([a, b, c, d, e, f].map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([0, 50, -25, 0, 50, 25])
  })

  it('同じ種類のぼかしは 2 乗の和の平方根にまとめる。影は数えない', () => {
    const shadow = { type: 'drop-shadow' as const, x: 0, y: 0, blur: 100, spread: 0, blendMode: 'normal' as const, color: '#000000', opacity: 1, visible: true }
    expect(blurRadius([shadow], 'layer-blur')).toBe(0)
    expect(blurRadius([{ type: 'layer-blur', blur: 3, visible: true }, { type: 'layer-blur', blur: 4, visible: true }, shadow], 'layer-blur')).toBe(5)
    expect(blurRadius([{ type: 'background-blur', blur: 6, visible: true }], 'layer-blur')).toBe(0)
  })
})

describe('書き出す範囲（getPaintedBounds）', () => {
  const shadow = { type: 'drop-shadow' as const, x: 4, y: 8, blur: 4, spread: 2, blendMode: 'normal' as const, color: '#000000', opacity: 0.25, visible: true }

  it('落ち影のはみ出し（ずれ・ぼかしの 1.5 倍・広がり）を足す。内側の影と隠した影は数えない', () => {
    // 枠は (0, 0, 100, 50)。影は (4 - 8, 8 - 8) から (104 + 8, 58 + 8)
    expect(getPaintedBounds(sceneOf(rect({ effects: [shadow] })), ['rect'])).toEqual({ x: -4, y: 0, width: 116, height: 66 })
    const quiet = rect({ effects: [{ ...shadow, type: 'inner-shadow' }, { ...shadow, visible: false }] })
    expect(getPaintedBounds(sceneOf(quiet), ['rect'])).toEqual({ x: 0, y: 0, width: 100, height: 50 })
  })

  it('レイヤーのぼかしは全体に足す。切り取らないフレームは、はみ出した子の影も含める', () => {
    expect(getPaintedBounds(sceneOf(rect({ effects: [{ type: 'layer-blur', blur: 4, visible: true }] })), ['rect'])).toEqual({
      x: -6, y: -6, width: 112, height: 62,
    })
    const child = rect({ id: 'child', parentId: 'frame', x: 80, effects: [{ ...shadow, x: 0, y: 0, spread: 0 }] })
    const open = frame({ children: ['child'], clipContent: false })
    // 子の枠は (80, 0, 100, 50)、影は 6 だけ外へ
    expect(getPaintedBounds(sceneOf(open, child), ['frame'])).toEqual({ x: 0, y: -6, width: 186, height: 62 })
    const clipped = frame({ children: ['child'], clipContent: true })
    expect(getPaintedBounds(sceneOf(clipped, child), ['frame'])).toEqual({ x: 0, y: 0, width: 100, height: 50 })
  })

  it('線の太さの半分を枠の外に足す。隠した線は数えず、回した図形は太らせてから回す', () => {
    const stroke = { type: 'solid' as const, color: '#000000', opacity: 1, visible: true, blendMode: 'normal' as const }
    expect(getPaintedBounds(sceneOf(rect({ strokes: [stroke], strokeWidth: 10 })), ['rect'])).toEqual({ x: -5, y: -5, width: 110, height: 60 })
    expect(getPaintedBounds(sceneOf(rect({ strokes: [{ ...stroke, visible: false }], strokeWidth: 10 })), ['rect'])).toEqual({ x: 0, y: 0, width: 100, height: 50 })
    // 90° 回すと、太らせた 110 × 60 が縦横入れ替わる（中心は (50, 25)）
    const turned = getPaintedBounds(sceneOf(rect({ strokes: [stroke], strokeWidth: 10, rotation: 90 })), ['rect'])!
    expect(turned.width).toBeCloseTo(60)
    expect(turned.height).toBeCloseTo(110)
    expect(turned.x).toBeCloseTo(20)
    // 水平な直線は、高さ 0 でも線の太さの分だけ上下に広がる。矢印の端は印の大きさまで
    const line = path({ height: 0, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], strokes: [stroke], strokeWidth: 4 })
    expect(getPaintedBounds(sceneOf(line), ['path'])).toEqual({ x: -2, y: -2, width: 104, height: 4 })
    const arrow = { ...line, endCap: 'arrow' as const, capSize: 12 }
    expect(getPaintedBounds(sceneOf(arrow), ['path'])).toEqual({ x: -12, y: -12, width: 124, height: 24 })
  })

  it('テキストは、行の分け方を渡せば枠の下や横へはみ出す行も含める（行揃えに従って横に置く）', () => {
    // 枠は 100 × 24（行の高さ 24 の 1 行分）。3 行描くので下へ 72 まで、真ん中揃えの 140px の行は左右に 20 ずつはみ出す
    const node = text({ width: 100, height: 24, textAlign: 'center' })
    const lines = () => [{ text: 'a', width: 140 }, { text: 'b', width: 50 }, { text: 'c', width: 50 }]
    expect(getPaintedBounds(sceneOf(node), ['text'])).toEqual({ x: 0, y: 0, width: 100, height: 24 })
    expect(getPaintedBounds(sceneOf(node), ['text'], lines)).toEqual({ x: -20, y: 0, width: 140, height: 72 })
    // 幅が分からなければ、横は枠の幅のまま
    expect(textInkBox(node, [{ text: 'a' }, { text: 'b' }])).toEqual({ x: 0, y: 0, width: 100, height: 48 })
  })

  it('パスの鋭い角は、線のつなぎ目（マイター）の先まで含める。太さの 10 倍を超える角はベベルなので数えない', () => {
    const stroke = { type: 'solid' as const, color: '#000000', opacity: 1, visible: true, blendMode: 'normal' as const }
    // 頂点 (50, 0) の角は辺どうしが約 53° で、つなぎ目は 5 / sin(26.6°) ≒ 11.2 だけ上へとがる
    const peak = path({ width: 100, height: 100, closed: true, points: [{ x: 0, y: 1 }, { x: 0.5, y: 0 }, { x: 1, y: 1 }], strokes: [stroke], strokeWidth: 10 })
    const bounds = getPaintedBounds(sceneOf(peak), ['path'])!
    expect(bounds.y).toBeCloseTo(-5 * Math.sqrt(5), 5)
    expect(miterTips(peak).length).toBe(3)
    // とても鋭い角（約 5.7°）はベベルになるので、先を数えない
    const needle = { ...peak, points: [{ x: 0.45, y: 1 }, { x: 0.5, y: 0 }, { x: 0.55, y: 1 }] }
    expect(miterTips(needle).some((tip) => tip.y < 0)).toBe(false)
  })
})

