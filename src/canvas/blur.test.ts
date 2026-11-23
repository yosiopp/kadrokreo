import { afterEach, describe, expect, it, vi } from 'vitest'
import { type BlurredImage, blurImage, boxWidths, canvasBlurWorks, downscaleFactor, drawBlurred, setCanvasBlurWorks } from './blur.ts'

type Image = { data: Uint8ClampedArray; width: number; height: number }

/** CSS の blur() の定義どおりのガウスぼかし（不透明度を掛けた色で、範囲の外は透明。半径 4σ まで） */
function gaussian(source: Image, sigma: number): Float32Array {
  const { width, height } = source
  const r = Math.ceil(sigma * 4)
  const kernel = Array.from({ length: r * 2 + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)))
  const total = kernel.reduce((a, b) => a + b, 0)
  const weights = kernel.map((k) => k / total)
  const pre = premultiplied(source)
  const mid = new Float32Array(pre.length)
  const out = new Float32Array(pre.length)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let k = -r; k <= r; k++) {
        const sx = x + k
        if (sx < 0 || sx >= width) continue
        for (let c = 0; c < 4; c++) mid[(y * width + x) * 4 + c] += pre[(y * width + sx) * 4 + c] * weights[k + r]
      }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let k = -r; k <= r; k++) {
        const sy = y + k
        if (sy < 0 || sy >= height) continue
        for (let c = 0; c < 4; c++) out[(y * width + x) * 4 + c] += mid[(sy * width + x) * 4 + c] * weights[k + r]
      }
  return out
}

function premultiplied(image: Image): Float32Array {
  const out = new Float32Array(image.data.length)
  for (let i = 0; i < out.length; i += 4) {
    const a = image.data[i + 3] / 255
    out[i] = image.data[i] * a
    out[i + 1] = image.data[i + 1] * a
    out[i + 2] = image.data[i + 2] * a
    out[i + 3] = image.data[i + 3]
  }
  return out
}

/** drawImage でなめらかに拡大したときと同じ、画素の中心どうしを結ぶ双一次補間で元の大きさに戻す（不透明度を掛けた色で） */
function upscale(blurred: BlurredImage, width: number, height: number): Float32Array {
  const small = premultiplied(blurred)
  const { factor } = blurred
  const at = (x: number, y: number, c: number) =>
    small[(Math.min(Math.max(y, 0), blurred.height - 1) * blurred.width + Math.min(Math.max(x, 0), blurred.width - 1)) * 4 + c]
  const out = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sx = (x + 0.5) / factor - 0.5
      const sy = (y + 0.5) / factor - 0.5
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const fx = sx - x0
      const fy = sy - y0
      for (let c = 0; c < 4; c++) {
        const top = at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx
        const bottom = at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx
        out[(y * width + x) * 4 + c] = top * (1 - fy) + bottom * fy
      }
    }
  return out
}

/** 透明な背景に、赤い不透明の四角と、半透明の青い四角と、1 ピクセルの白い線を置いた絵 */
function testImage(width: number, height: number): Image {
  const data = new Uint8ClampedArray(width * height * 4)
  const put = (x: number, y: number, rgba: number[]) => data.set(rgba, (y * width + x) * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (x >= 30 && x < 70 && y >= 30 && y < 70) put(x, y, [255, 0, 0, 255])
      if (x >= 55 && x < 90 && y >= 50 && y < 100) put(x, y, [0, 64, 255, 128])
      if (x === 20) put(x, y, [255, 255, 255, 255])
    }
  return { data, width, height }
}

/** 0〜255 の目盛りでの差の最大と平均（不透明度を掛けた色と不透明度の 4 つ） */
function difference(a: Float32Array, b: Float32Array) {
  let max = 0
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i])
    max = Math.max(max, d)
    sum += d
  }
  return { max, mean: sum / a.length }
}

describe('filter が効かないときのぼかし（blurImage）', () => {
  const image = testImage(120, 130)

  // 差の上限（0〜255 の目盛り）。ボックスブラー 3 回の近似と、幅を奇数に丸めることと、縮小・拡大で出る差
  it.each([
    [0.5, 2, 0.1],
    [1, 2, 0.1],
    [2, 2, 0.1],
    [3, 5, 0.5],
    [4, 4, 0.5],
    [8, 4, 0.5],
    [16, 8, 0.5],
    [24, 8, 0.5],
  ])('標準偏差 %s のとき blur() との差が小さい（最大 %s・平均 %s 以下）', (sigma, max, mean) => {
    const expected = gaussian(image, sigma)
    const actual = upscale(blurImage(image, sigma), image.width, image.height)
    const diff = difference(actual, expected)
    expect(diff.max).toBeLessThanOrEqual(max)
    expect(diff.mean).toBeLessThanOrEqual(mean)
  })

  it('半径が大きいときは縮小してからぼかす', () => {
    expect(downscaleFactor(3)).toBe(1)
    expect(downscaleFactor(8)).toBe(4)
    expect(blurImage(image, 8)).toMatchObject({ width: 30, height: 33, factor: 4 })
    expect(blurImage(image, 16)).toMatchObject({ width: 15, height: 17, factor: 8 })
  })

  it('ボックスの幅は奇数で、分散の和は sigma² を超えず、足りない分は幅 1 段分まで', () => {
    for (const sigma of [2, 2.5, 3, 4, 7]) {
      const widths = boxWidths(sigma)
      expect(widths.every((w) => w % 2 === 1)).toBe(true)
      const variance = widths.reduce((sum, w) => sum + (w * w - 1) / 12, 0)
      expect(variance).toBeLessThanOrEqual(sigma * sigma)
      expect(sigma * sigma - variance).toBeLessThanOrEqual((widths[0] + 1) / 3)
    }
  })

  it('色のにじみが出ない（透明な所の色を混ぜない）', () => {
    const blurred = blurImage(image, 3)
    // 赤い四角の下の端の外側（透明だった所）は、赤のまま薄くなる
    const i = (72 * blurred.width + 40) * 4
    expect(blurred.data[i + 3]).toBeGreaterThan(0)
    expect(blurred.data[i]).toBeGreaterThan(250)
    expect(blurred.data[i + 1]).toBe(0)
  })
})

/** drawImage・getImageData などの呼び出しだけを記録する偽のキャンバス */
function fakeContext(width: number, height: number) {
  const calls: unknown[][] = []
  const ctx = {
    canvas: { width, height },
    filter: 'none',
    imageSmoothingEnabled: false,
    fillStyle: '',
    drawImage: (...args: unknown[]) => calls.push(['drawImage', ...args]),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => {},
    fillRect: () => {},
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

describe('ぼかしの描き方の切り替え（drawBlurred）', () => {
  afterEach(() => {
    setCanvasBlurWorks(undefined)
    vi.unstubAllGlobals()
  })

  it('filter が効くなら、filter を付けてそのまま描く', () => {
    setCanvasBlurWorks(true)
    const target = fakeContext(100, 80)
    const source = fakeContext(100, 80)
    drawBlurred(target.ctx, source.ctx, 3)
    expect(target.ctx.filter).toBe('blur(3px)')
    expect(target.calls).toEqual([['drawImage', source.ctx.canvas, 0, 0]])
  })

  it('filter が効かないなら、縮小してぼかした絵を拡大して描く（filter は触らない）', () => {
    const scratch = fakeContext(1, 1)
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => scratch.ctx }) })
    setCanvasBlurWorks(false)
    const target = fakeContext(100, 80)
    const source = fakeContext(100, 80)
    drawBlurred(target.ctx, source.ctx, 8)
    expect(target.ctx.filter).toBe('none')
    expect(target.ctx.imageSmoothingEnabled).toBe(false)
    expect(target.calls).toEqual([['drawImage', scratch.ctx.canvas, 0, 0, 25, 20, 0, 0, 100, 80]])
  })

  it('filter が効くかは、1 点をぼかして描いてにじむかで確かめ、結果を覚える', () => {
    let created = 0
    const probe = (spread: boolean) => {
      const { ctx } = fakeContext(1, 1)
      Object.assign(ctx, { getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, spread ? 40 : 0]) }) })
      return ctx
    }
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => (created++, probe(false)) }) })
    expect(canvasBlurWorks()).toBe(false)
    expect(canvasBlurWorks()).toBe(false)
    expect(created).toBe(1)

    setCanvasBlurWorks(undefined)
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => probe(true) }) })
    expect(canvasBlurWorks()).toBe(true)
  })
})
