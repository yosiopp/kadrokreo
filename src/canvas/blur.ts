// Canvas の filter（blur()）が効かない環境（古い版の Safari など）で、ぼかしを自前で描くための部品。
// filter が効く環境では使わない（描画も速さも変えない）。
//
// ガウスぼかしを、幅の違う 3 回のボックスブラー（横と縦）で近似する（小さいぼかしは箱の幅を奇数に丸める差が目立つので、
// ガウス関数の重みをそのまま掛ける）。半径が大きいときは、先に縮小してから
// ぼかし、描くときに拡大する（縮小と拡大でにじむ分は、ぼかす量から差し引く）。
// 色のにじみが出ないよう、不透明度を掛けた色（premultiplied）でぼかす。キャンバスの外は透明として扱う（blur() と同じ）。

/** ぼかしの結果。width × height の絵（不透明度を掛けていない RGBA）を factor 倍に拡大して描く */
export type BlurredImage = {
  data: Uint8ClampedArray
  width: number
  height: number
  factor: number
}

/** ボックスブラーを重ねる回数 */
const PASSES = 3

/** 縮小した絵でぼかす標準偏差の目安。この 2 倍より大きいぼかしは縮小してからかける */
const SMALL_SIGMA = 2

/** これ以下の標準偏差は、ボックスブラーでなくガウス関数の重み（半径 3σ）でぼかす */
const KERNEL_SIGMA = 2

/**
 * 標準偏差 sigma のガウスぼかしに近づける、n 回のボックスブラーの幅（奇数）。
 * 幅 w の箱の分散は (w² - 1) / 12 なので、分散の和が sigma² を超えない範囲で最も近くなるよう、2 種類の幅を混ぜる
 * （足りない分は blurPremultiplied がガウス関数の重みで足す）
 */
export function boxWidths(sigma: number, n = PASSES): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1)
  let lower = Math.floor(ideal)
  if (lower % 2 === 0) lower--
  const upper = lower + 2
  const m = Math.min(n, Math.max(0, Math.ceil((12 * sigma * sigma - n * lower * lower - 4 * n * lower - 3 * n) / (-4 * lower - 4))))
  return Array.from({ length: n }, (_, i) => (i < m ? lower : upper))
}

/** 縮小の倍率。縮小した絵でのぼかしが SMALL_SIGMA 前後になるようにする */
export function downscaleFactor(sigma: number): number {
  return Math.max(1, Math.floor(sigma / SMALL_SIGMA))
}

/** 横方向に半径 r のボックスブラーをかける（範囲の外は透明）。src から dst へ */
function boxHorizontal(src: Float32Array, dst: Float32Array, width: number, height: number, r: number): void {
  const scale = 1 / (r * 2 + 1)
  for (let y = 0; y < height; y++) {
    const row = y * width * 4
    for (let c = 0; c < 4; c++) {
      let sum = 0
      for (let x = 0; x <= r && x < width; x++) sum += src[row + x * 4 + c]
      for (let x = 0; x < width; x++) {
        dst[row + x * 4 + c] = sum * scale
        const add = x + r + 1
        const remove = x - r
        if (add < width) sum += src[row + add * 4 + c]
        if (remove >= 0) sum -= src[row + remove * 4 + c]
      }
    }
  }
}

/** 縦方向に半径 r のボックスブラーをかける（範囲の外は透明）。src から dst へ */
function boxVertical(src: Float32Array, dst: Float32Array, width: number, height: number, r: number): void {
  const scale = 1 / (r * 2 + 1)
  const stride = width * 4
  for (let x = 0; x < width; x++) {
    for (let c = 0; c < 4; c++) {
      const column = x * 4 + c
      let sum = 0
      for (let y = 0; y <= r && y < height; y++) sum += src[column + y * stride]
      for (let y = 0; y < height; y++) {
        dst[column + y * stride] = sum * scale
        const add = y + r + 1
        const remove = y - r
        if (add < height) sum += src[column + add * stride]
        if (remove >= 0) sum -= src[column + remove * stride]
      }
    }
  }
}

/** ガウス関数の重みで、横（dx = 4）または縦（dx = width * 4）にぼかす（範囲の外は透明）。src から dst へ */
function gaussianPass(src: Float32Array, dst: Float32Array, width: number, height: number, weights: number[], horizontal: boolean): void {
  const r = (weights.length - 1) / 2
  const step = horizontal ? 4 : width * 4
  const length = horizontal ? width : height
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = horizontal ? x : y
      const o = (y * width + x) * 4
      let r0 = 0
      let g0 = 0
      let b0 = 0
      let a0 = 0
      for (let k = Math.max(-r, -at); k <= r && at + k < length; k++) {
        const w = weights[k + r]
        const i = o + k * step
        r0 += src[i] * w
        g0 += src[i + 1] * w
        b0 += src[i + 2] * w
        a0 += src[i + 3] * w
      }
      dst[o] = r0
      dst[o + 1] = g0
      dst[o + 2] = b0
      dst[o + 3] = a0
    }
  }
}

/** 標準偏差 sigma のガウス関数の重みでぼかす（半径 3σ）。src から dst を通って src に戻る */
function gaussianBlur(src: Float32Array, dst: Float32Array, width: number, height: number, sigma: number): void {
  const r = Math.ceil(sigma * 3)
  const kernel = Array.from({ length: r * 2 + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)))
  const total = kernel.reduce((sum, k) => sum + k, 0)
  const weights = kernel.map((k) => k / total)
  gaussianPass(src, dst, width, height, weights, true)
  gaussianPass(dst, src, width, height, weights, false)
}

/** 不透明度を掛けた RGBA（Float32、0〜255）に、標準偏差 sigma のガウスぼかしの近似をかける。結果は pixels に入る */
export function blurPremultiplied(pixels: Float32Array, width: number, height: number, sigma: number): void {
  if (sigma <= 0) return
  if (sigma <= KERNEL_SIGMA) {
    // 横と縦に 1 回ずつなので、範囲の外へにじんだ分は戻ってこない（そのまま捨ててよい）
    gaussianBlur(pixels, new Float32Array(pixels.length), width, height, sigma)
    return
  }
  const widths = boxWidths(sigma)
  // 箱の幅を奇数に丸めて足りない分は、最後に小さなガウスぼかしで足す（ぼかしを重ねると分散が足し合わさる）
  const rest = sigma * sigma - widths.reduce((sum, w) => sum + (w * w - 1) / 12, 0)
  const restSigma = rest > 0.01 ? Math.sqrt(rest) : 0
  // 同じ向きに何度もぼかすので、範囲の外へにじんだ分も次のぼかしで戻ってくる。にじむ幅だけ余白を付けて計算し、最後に切り取る
  const pad = widths.reduce((sum, w) => sum + (w - 1) / 2, 0) + Math.ceil(restSigma * 3)
  const pw = width + pad * 2
  const ph = height + pad * 2
  const work = new Float32Array(pw * ph * 4)
  for (let y = 0; y < height; y++) work.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), ((y + pad) * pw + pad) * 4)
  const scratch = new Float32Array(work.length)
  for (const w of widths) {
    const r = (w - 1) / 2
    if (r === 0) continue
    boxHorizontal(work, scratch, pw, ph, r)
    boxVertical(scratch, work, pw, ph, r)
  }
  if (restSigma > 0) gaussianBlur(work, scratch, pw, ph, restSigma)
  for (let y = 0; y < height; y++) pixels.set(work.subarray(((y + pad) * pw + pad) * 4, ((y + pad) * pw + pad + width) * 4), y * width * 4)
}

/**
 * RGBA の絵（getImageData の中身。不透明度を掛けていない色）を、CSS の blur(sigma px) に近くぼかす。
 * 返す絵は factor 分の 1 に縮小してあるので、factor 倍に（なめらかに）拡大して描く
 */
export function blurImage(source: { data: Uint8ClampedArray; width: number; height: number }, sigma: number): BlurredImage {
  const factor = downscaleFactor(sigma)
  const width = Math.ceil(source.width / factor)
  const height = Math.ceil(source.height / factor)
  const pixels = new Float32Array(width * height * 4)
  // factor × factor の区画の平均を取って縮小する（不透明度を掛けた色で。キャンバスの外は透明）
  const src = source.data
  const area = 1 / (factor * factor)
  for (let y = 0; y < source.height; y++) {
    const row = Math.floor(y / factor) * width
    for (let x = 0; x < source.width; x++) {
      const i = (y * source.width + x) * 4
      const o = (row + Math.floor(x / factor)) * 4
      const a = src[i + 3]
      if (a === 0) continue
      const k = (a / 255) * area
      pixels[o] += src[i] * k
      pixels[o + 1] += src[i + 1] * k
      pixels[o + 2] += src[i + 2] * k
      pixels[o + 3] += a * area
    }
  }
  // 縮小したときは、区画の平均（分散 factor² / 12）と、描くときの拡大の補間（三角形、分散 factor² / 6）でにじむ分を差し引く
  const rest = factor === 1 ? sigma * sigma : Math.max(0, sigma * sigma - (factor * factor) / 4)
  blurPremultiplied(pixels, width, height, Math.sqrt(rest) / factor)

  const data = new Uint8ClampedArray(pixels.length)
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3]
    if (a <= 0) continue
    const k = 255 / a
    data[i] = pixels[i] * k
    data[i + 1] = pixels[i + 1] * k
    data[i + 2] = pixels[i + 2] * k
    data[i + 3] = a
  }
  return { data, width, height, factor }
}

let filterWorks: boolean | undefined

/**
 * Canvas の filter の blur() が効くか。最初の 1 回だけ、小さなキャンバスに 1 点をぼかして描いて確かめる
 * （filter の項目が無い環境でも代入はできてしまうので、読み返しでは分からない）
 */
export function canvasBlurWorks(): boolean {
  if (filterWorks !== undefined) return filterWorks
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return (filterWorks = false)
    ctx.canvas.width = 9
    ctx.canvas.height = 1
    ctx.filter = 'blur(2px)'
    ctx.fillStyle = '#000000'
    ctx.fillRect(4, 0, 1, 1)
    // ぼけていれば、2 ピクセル離れた所にもにじむ
    filterWorks = ctx.getImageData(2, 0, 1, 1).data[3] > 0
  } catch {
    filterWorks = false
  }
  return filterWorks
}

/** テスト用。確かめた結果を差し替える（undefined で確かめ直す） */
export function setCanvasBlurWorks(works: boolean | undefined): void {
  filterWorks = works
}

let scratch: CanvasRenderingContext2D | null = null

/**
 * source のキャンバス全体を、標準偏差 sigma（キャンバスのピクセル）でぼかして target の原点に描く。
 * target の変換行列は単位行列にしておく。切り抜き・不透明度・合成の方法は target の設定のまま効く。
 * filter が効く環境では filter をそのまま使う（呼ぶ側の save / restore で元に戻る）
 */
export function drawBlurred(target: CanvasRenderingContext2D, source: CanvasRenderingContext2D, sigma: number): void {
  if (canvasBlurWorks()) {
    target.filter = `blur(${sigma}px)`
    target.drawImage(source.canvas, 0, 0)
    return
  }
  const { width, height } = source.canvas
  if (width === 0 || height === 0) return
  const blurred = blurImage(source.getImageData(0, 0, width, height), sigma)
  scratch ??= document.createElement('canvas').getContext('2d')!
  if (scratch.canvas.width !== blurred.width || scratch.canvas.height !== blurred.height) {
    scratch.canvas.width = blurred.width
    scratch.canvas.height = blurred.height
  }
  const image = scratch.createImageData(blurred.width, blurred.height)
  image.data.set(blurred.data)
  scratch.putImageData(image, 0, 0)
  const smoothing = target.imageSmoothingEnabled
  target.imageSmoothingEnabled = true
  target.drawImage(
    scratch.canvas,
    0,
    0,
    blurred.width,
    blurred.height,
    0,
    0,
    blurred.width * blurred.factor,
    blurred.height * blurred.factor,
  )
  target.imageSmoothingEnabled = smoothing
}
