import { describe, expect, it } from 'vitest'
import { solid, solidPaint } from '../document/paint.ts'
import type { Paint, Scene } from '../document/types.ts'
import { ellipse, frame, rect, sceneOf, text } from '../document/testNodes.ts'
import { contrastLevels, contrastRatio, formatRatio, isLargeText, relativeLuminance, textContrast } from './contrast.ts'

/** テキスト（0, 0, 100 × 50）より大きな背景 */
const backdrop = (patch: Parameters<typeof rect>[0] = {}) => rect({ id: 'bg', x: -10, y: -10, width: 200, height: 100, ...patch })

function measured(scene: Scene, id = 'text') {
  const result = textContrast(scene, id)
  if (result?.kind !== 'measured') throw new Error(`求められない: ${JSON.stringify(result)}`)
  return result
}

function unknown(scene: Scene, id = 'text'): string {
  const result = textContrast(scene, id)
  if (result?.kind !== 'unknown') throw new Error(`求められた: ${JSON.stringify(result)}`)
  return result.reason
}

describe('contrastRatio', () => {
  it('相対輝度と比が WCAG の式と合う', () => {
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10)
    // 0x77 = 119: ((119 / 255 + 0.055) / 1.055) ^ 2.4 = 0.18447
    expect(relativeLuminance('#777777')).toBeCloseTo(0.18447, 4)
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 10)
    // (1 + 0.05) / (0.18447 + 0.05) = 4.478、#767676 は 4.54
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.478, 3)
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.542, 3)
    // 純色の赤と白: (1.05) / (0.2126 + 0.05) = 3.998
    expect(contrastRatio('#ff0000', '#ffffff')).toBeCloseTo(3.998, 3)
  })

  it('基準は丸めずに比べ、見せる値は切り捨てる', () => {
    expect(contrastLevels(4.499, false)).toEqual({ aa: false, aaa: false })
    expect(contrastLevels(4.5, false)).toEqual({ aa: true, aaa: false })
    expect(contrastLevels(4.5, true)).toEqual({ aa: true, aaa: true })
    expect(contrastLevels(3, true)).toEqual({ aa: true, aaa: false })
    expect(contrastLevels(7, false)).toEqual({ aa: true, aaa: true })
    expect(formatRatio(4.499)).toBe('4.49:1')
    expect(formatRatio(21)).toBe('21.00:1')
    expect(formatRatio(4.5)).toBe('4.50:1')
  })

  it('大きな文字は 24px 以上か、太字で 18.66px 以上', () => {
    expect(isLargeText(24, 400)).toBe(true)
    expect(isLargeText(23.9, 400)).toBe(false)
    expect(isLargeText(18.66, 700)).toBe(true)
    expect(isLargeText(18.66, 600)).toBe(false)
    expect(isLargeText(18, 700)).toBe(false)
  })
})

describe('textContrast', () => {
  it('単色の背景の上の単色の文字', () => {
    const result = measured(sceneOf(backdrop({ fills: solid('#ffffff') }), text({ fills: solid('#777777') })))
    expect(result.lowest).toEqual({ text: '#777777', background: '#ffffff', ratio: contrastRatio('#777777', '#ffffff') })
    expect(result.varies).toBe(false)
    expect(result.overWhite).toBe(false)
    expect(result).toMatchObject({ large: false, aa: false, aaa: false })
  })

  it('背景がなければ白の地の上として求める', () => {
    const result = measured(sceneOf(text({ fills: solid('#000000') })))
    expect(result.lowest.background).toBe('#ffffff')
    expect(result.lowest.ratio).toBeCloseTo(21, 10)
    expect(result.overWhite).toBe(true)
    expect(result).toMatchObject({ aa: true, aaa: true })
  })

  it('半透明の背景は下の色と合成して比べる', () => {
    // 白の上に黒を 50%: 255 × 0.5 = 127.5 → #808080。白の文字との比は (1.05) / (0.2158 + 0.05) = 3.95
    const scene = sceneOf(
      backdrop({ id: 'white', fills: solid('#ffffff') }),
      backdrop({ id: 'black', fills: [solidPaint('#000000', 0.5)] }),
      text({ fills: solid('#ffffff') }),
    )
    const result = measured(scene)
    expect(result.lowest.background).toBe('#808080')
    expect(result.lowest.ratio).toBeCloseTo(3.95, 2)
    expect(result).toMatchObject({ aa: false, aaa: false })
    // 大きな文字なら AA（3:1）を満たす
    const large = measured(sceneOf(scene.nodes.white, scene.nodes.black, text({ fills: solid('#ffffff'), fontSize: 24 })))
    expect(large).toMatchObject({ large: true, aa: true, aaa: false })
  })

  it('ノードの不透明度も塗りの不透明度と同じく合成する', () => {
    const scene = sceneOf(backdrop({ fills: solid('#000000'), opacity: 0.5 }), text({ fills: solid('#ffffff') }))
    expect(measured(scene).lowest.background).toBe('#808080')
    expect(measured(scene).overWhite).toBe(true)
  })

  it('半透明の文字は背景と合成した色で比べる', () => {
    const scene = sceneOf(backdrop({ fills: solid('#ffffff') }), text({ fills: [solidPaint('#000000', 0.5)] }))
    const result = measured(scene)
    expect(result.lowest.text).toBe('#808080')
    expect(result.lowest.ratio).toBeCloseTo(contrastRatio('#808080', '#ffffff'), 10)
  })

  it('半透明のフレームは、中身をまとめてから透かす（文字も一緒に薄くなる）', () => {
    // フレームの中は黒の上に白の文字（21:1）。フレームを 50% にすると、白の地の上で背景 #808080・文字 #ffffff
    const scene = sceneOf(
      frame({ id: 'f', x: -20, y: -20, width: 300, height: 200, fills: [], opacity: 0.5, children: ['bg', 'text'] }),
      backdrop({ parentId: 'f', x: 0, y: 0, fills: solid('#000000') }),
      text({ parentId: 'f', x: 20, y: 20, fills: solid('#ffffff') }),
    )
    const result = measured(scene)
    expect(result.lowest).toMatchObject({ text: '#ffffff', background: '#808080' })
    expect(result.overWhite).toBe(true)
  })

  it('フレームの塗りと、その子の塗りを重ねる', () => {
    const scene = sceneOf(
      frame({ id: 'f', x: -20, y: -20, width: 300, height: 200, fills: solid('#0000ff'), children: ['text'] }),
      text({ parentId: 'f', x: 20, y: 20, fills: solid('#ffffff') }),
    )
    expect(measured(scene).lowest).toMatchObject({ text: '#ffffff', background: '#0000ff', ratio: contrastRatio('#ffffff', '#0000ff') })
  })

  it('不透明な塗りより下は見えない。かからない図形と手前の図形は見ない', () => {
    const scene = sceneOf(
      backdrop({ id: 'under', fills: solid('#ff0000') }),
      backdrop({ id: 'over', fills: solid('#00ff00') }),
      rect({ id: 'aside', x: 300, y: 0, fills: solid('#000000') }),
      text({ fills: solid('#000000') }),
      backdrop({ id: 'front', fills: solid('#0000ff') }),
    )
    expect(measured(scene).lowest.background).toBe('#00ff00')
  })

  it('一部だけにかかる塗りがあると求められない', () => {
    expect(unknown(sceneOf(rect({ id: 'half', x: 50, y: 0, width: 100, height: 100 }), text()))).toContain('一部だけ')
    // 楕円の中に収まっていれば覆う。枠の角が楕円からはみ出せば一部だけ
    expect(measured(sceneOf(ellipse({ id: 'e', x: -100, y: -100, width: 300, height: 250, fills: solid('#000000') }), text({ fills: solid('#ffffff') }))).lowest.background).toBe('#000000')
    expect(unknown(sceneOf(ellipse({ id: 'e', x: -10, y: -10, width: 120, height: 70 }), text()))).toContain('一部だけ')
    // 枠より小さな図形が中に入っている・細い帯が横切る
    expect(unknown(sceneOf(rect({ id: 'dot', x: 40, y: 20, width: 5, height: 5 }), text()))).toContain('一部だけ')
    expect(unknown(sceneOf(rect({ id: 'band', x: 41, y: -100, width: 2, height: 300 }), text()))).toContain('一部だけ')
  })

  it('角丸の角が枠にかかると一部だけ。回した背景も形で比べる', () => {
    expect(unknown(sceneOf(rect({ id: 'r', x: 0, y: 0, width: 100, height: 50, cornerRadius: 10 }), text()))).toContain('一部だけ')
    expect(measured(sceneOf(rect({ id: 'r', x: -10, y: -10, width: 120, height: 70, cornerRadius: 10, fills: solid('#ffffff') }), text())).lowest.background).toBe('#ffffff')
    // 45° 回した大きな正方形は覆う。小さな正方形を回すと角が枠からはみ出す
    expect(measured(sceneOf(rect({ id: 'r', x: -100, y: -125, width: 300, height: 300, rotation: 45, fills: solid('#ffffff') }), text())).lowest.background).toBe('#ffffff')
    expect(unknown(sceneOf(rect({ id: 'r', x: 0, y: -25, width: 100, height: 100, rotation: 45 }), text()))).toContain('一部だけ')
  })

  it('線が枠にかかると求められない。離れていれば見ない', () => {
    expect(unknown(sceneOf(rect({ id: 'r', x: -2, y: -2, width: 104, height: 54, fills: solid('#ffffff'), strokes: solid('#000000'), strokeWidth: 6 }), text()))).toContain('線')
    const far = sceneOf(rect({ id: 'r', x: -10, y: -10, width: 120, height: 70, fills: solid('#ffffff'), strokes: solid('#000000'), strokeWidth: 4 }), text())
    expect(measured(far).lowest.background).toBe('#ffffff')
  })

  it('画像・後ろのテキスト・描画モードがかかると求められない', () => {
    const image = { ...rect({ id: 'img', x: -10, y: -10, width: 200, height: 100 }), type: 'image' as const, assetId: 'a1', fit: 'fill' as const, positionX: 0.5, positionY: 0.5, scale: 1, flipX: false, flipY: false, cornerRadius: 0 }
    expect(unknown(sceneOf(image as unknown as ReturnType<typeof rect>, text()))).toContain('画像')
    expect(unknown(sceneOf(text({ id: 'behind' }), text()))).toContain('テキスト')
    expect(unknown(sceneOf(backdrop({ blendMode: 'multiply' }), text()))).toContain('描画モード')
  })

  it('グラデーションは止めの間も含めた全体の色で、いちばん低い比を出す', () => {
    const gradient: Paint = {
      type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, opacity: 1, visible: true, blendMode: 'normal',
      stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }],
    }
    const result = measured(sceneOf(backdrop({ fills: [gradient] }), text({ fills: solid('#000000') })))
    expect(result.varies).toBe(true)
    expect(result.lowest.background).toBe('#000000')
    expect(result.lowest.ratio).toBe(1)
    expect(result.highest.background).toBe('#ffffff')
    expect(result.highest.ratio).toBeCloseTo(21, 10)
    expect(result.aa).toBe(false)
  })

  it('マスクで切り取られた背景は、マスクの形で決まる', () => {
    const mask = rect({ id: 'mask', x: 300, y: 300, width: 10, height: 10, isMask: true })
    // マスクが枠にかからなければ、切り取られた背景は描かれない
    const scene = sceneOf(backdrop({ id: 'white', fills: solid('#ffffff') }), mask, backdrop({ id: 'masked', fills: solid('#000000') }), text({ fills: solid('#000000') }))
    expect(measured(scene).lowest.background).toBe('#ffffff')
  })

  it('辺が枠の辺に重なる図形も、一部だけかかるなら求められない（同じ幅の帯・半分）', () => {
    const white = backdrop({ id: 'white', fills: solid('#ffffff') })
    for (const band of [
      { x: 0, y: 20, width: 100, height: 30 },
      { x: 0, y: 0, width: 100, height: 20 },
      { x: 0, y: 0, width: 50, height: 50 },
      { x: 0, y: -10, width: 100, height: 30 },
    ]) {
      expect(unknown(sceneOf(white, rect({ id: 'band', ...band, fills: solid('#000000') }), text({ fills: solid('#777777') })))).toContain('一部だけ')
    }
    // 枠とちょうど同じ矩形は覆う。隣に接するだけの矩形はかからない
    expect(measured(sceneOf(white, rect({ id: 'same', fills: solid('#000000') }), text({ fills: solid('#ffffff') }))).lowest.background).toBe('#000000')
    expect(measured(sceneOf(white, rect({ id: 'next', x: 100, fills: solid('#000000') }), text())).lowest.background).toBe('#ffffff')
  })

  it('グラデーションを何枚も重ねて候補が増えすぎるときは求められない（固まらない）', () => {
    const ramp: Paint = {
      type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, opacity: 0.5, visible: true, blendMode: 'normal',
      stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 0.5, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }],
    }
    const scene = sceneOf(
      backdrop({ id: 'a', fills: [ramp, ramp] }),
      backdrop({ id: 'b', fills: [ramp, ramp] }),
      backdrop({ id: 'c', fills: [ramp, ramp] }),
      text({ fills: [ramp] }),
    )
    const started = performance.now()
    expect(unknown(scene)).toContain('数えきれない')
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('不透明度のマスク・ぼかしがかかると求められない', () => {
    const mask = backdrop({ id: 'mask', isMask: true, maskType: 'alpha', fills: [solidPaint('#000000', 0)] })
    expect(unknown(sceneOf(mask, backdrop({ id: 'masked', fills: solid('#000000') }), text()))).toContain('マスク')
    expect(unknown(sceneOf(backdrop({ effects: [{ type: 'layer-blur', blur: 4, visible: true }] }), text()))).toContain('ぼかし')
    expect(unknown(sceneOf(text({ effects: [{ type: 'layer-blur', blur: 4, visible: true }] })))).toContain('ぼかし')
  })

  it('通過のフレームは、子を後ろに重ねた色と後ろを不透明度で混ぜる', () => {
    // 白の上で、通過のフレーム（50%）の中の黒 50% の上に白の文字。
    // フレームの中: 背景 = 黒 50% over 白 = 0.5、文字 = 白。後ろ（白）と 50% で混ぜると 背景 0.75（#bfbfbf）・文字は白
    const scene = sceneOf(
      backdrop({ id: 'white', fills: solid('#ffffff') }),
      frame({ id: 'f', x: -20, y: -20, width: 300, height: 200, fills: [], opacity: 0.5, passThrough: true, children: ['shade', 'text'] }),
      rect({ id: 'shade', parentId: 'f', x: 0, y: 0, width: 300, height: 200, fills: [solidPaint('#000000', 0.5)] }),
      text({ parentId: 'f', x: 20, y: 20, fills: solid('#ffffff') }),
    )
    expect(measured(scene).lowest).toMatchObject({ text: '#ffffff', background: '#bfbfbf' })
  })

  it('祖先のフレームの線は子より手前に描くので見ない', () => {
    const scene = sceneOf(
      frame({ id: 'f', x: 0, y: 0, width: 100, height: 50, fills: solid('#000000'), strokes: solid('#ff0000'), strokeWidth: 4, children: ['text'] }),
      text({ parentId: 'f', fills: solid('#ffffff') }),
    )
    expect(measured(scene).lowest.background).toBe('#000000')
  })

  it('塗りが 2 枚の文字は重ねた色、回したテキストも枠の形で比べる', () => {
    const scene = sceneOf(backdrop({ fills: solid('#ffffff') }), text({ fills: [solidPaint('#000000'), solidPaint('#ffffff', 0.5)] }))
    expect(measured(scene).lowest.text).toBe('#808080')
    // 45° 回したテキストの角は、回していない枠ちょうどの背景からはみ出す
    expect(unknown(sceneOf(rect({ id: 'r', fills: solid('#000000') }), text({ rotation: 45 })))).toContain('一部だけ')
  })

  it('テキストでない・表示していない・塗りがないときは null', () => {
    expect(textContrast(sceneOf(text({ isMask: true })), 'text')).toBeNull()
    expect(textContrast(sceneOf(rect()), 'rect')).toBeNull()
    expect(textContrast(sceneOf(text({ visible: false })), 'text')).toBeNull()
    expect(textContrast(sceneOf(text({ fills: [] })), 'text')).toBeNull()
    expect(textContrast(sceneOf(frame({ id: 'f', visible: false, children: ['text'] }), text({ parentId: 'f' })), 'text')).toBeNull()
  })

  it('ドキュメントを変えない', () => {
    const scene = sceneOf(backdrop({ fills: [solidPaint('#000000', 0.5)] }), text())
    const before = JSON.stringify(scene)
    textContrast(scene, 'text')
    expect(JSON.stringify(scene)).toBe(before)
  })
})
