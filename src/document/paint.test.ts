import { describe, expect, it } from 'vitest'
import { hasStroke, imageRect, isAngleLine, linearAngle, linearFromAngle, solid, splitEffects, withoutHidden } from './paint.ts'

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
  const hidden = { type: 'solid' as const, color: '#00ff00', opacity: 1, visible: false }
  const inner = { type: 'inner-shadow' as const, x: 0, y: 1, blur: 2, color: '#000000', opacity: 1, visible: true }
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
