const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const zlib = require('zlib')
const { execFileSync } = require('child_process')

// テキスト・画像・フレームのマスクを、viewer の描画（PNG）と SVG の書き出しが同じ見た目で書くことを、画素で見比べて確かめる
const { OUT, VIEWER, check, finish, crashed, watchErrors } = require('./harness.cjs')

/** 幅 w・高さ h の RGBA の PNG。pixel(x, y) が [r, g, b, a] を返す */
function png(w, h, pixel) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes) => {
    let c = 0xffffffff
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(w, 0)
  header.writeUInt32BE(h, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4)
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// 左半分が不透明な白、右半分が透明な画像（不透明度のマスクに使う）
const halfPath = path.join(OUT, 'mask-half.png')
fs.writeFileSync(halfPath, png(20, 10, (x) => (x < 10 ? [255, 255, 255, 255] : [0, 0, 0, 0])))

// 青い背景の上に、どれも赤い四角をマスクで切り取ったもの:
// 文字の形のマスク（TextGroup。大きな「■」の文字）、画像の形のマスク（Img。角丸 20 の枠）、画像の不透明度のマスク（Half）、
// フレームの明るさのマスク（Lum。左半分が白・右半分が灰色の子）
const sourcePath = path.join(OUT, 'mask-kinds.kdr')
execFileSync('node', [path.join(__dirname, '..', 'cli', 'kadrokreo.ts'),
  ...('new Masks + add rect --name Back --width 400 --height 200 fill=#3366ff' +
    ' + add text --name Label --x 20 --y 10 --text ■ fontSize=100 fill=#000000' +
    ' + add rect --name RedT --x 10 --y 0 --width 170 --height 140 fill=#ff0000' +
    ' + mask Label RedT --name TextGroup' +
    ` + add image --src ${halfPath} --name Img --x 200 --y 20 --width 120 --height 60 cornerRadius=20 fit=stretch` +
    ' + add rect --name RedI --x 190 --y 10 --width 140 --height 80 fill=#ff0000' +
    ' + mask Img RedI --name ImageGroup' +
    ` + add image --src ${halfPath} --name Half --x 200 --y 110 --width 120 --height 60 fit=stretch` +
    ' + add rect --name RedA --x 190 --y 100 --width 140 --height 80 fill=#ff0000' +
    ' + mask Half RedA --name AlphaGroup --type alpha' +
    ' + add frame --name Lum --x 20 --y 150 --width 160 --height 40 fills=[]' +
    ' + add rect --parent Lum --name White --width 80 --height 40 fill=#ffffff' +
    ' + add rect --parent Lum --name Gray --x 80 --width 80 --height 40 fill=#808080' +
    ' + add rect --name RedL --x 10 --y 145 --width 180 --height 50 fill=#ff0000' +
    ' + mask Lum RedL --name LumGroup --type luminance').split(' '),
  '-o', sourcePath,
], { encoding: 'utf8' })

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  const viewer = await context.newPage()
  const errors = []
  watchErrors(viewer, errors)
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(sourcePath)
  await viewer.waitForSelector('.inspect-layer:has(.layer-name:text-is("LumGroup"))')
  await viewer.waitForTimeout(500)

  const [pngDownload] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('button:text-is("ページを PNG に")').click()])
  const pngPath = path.join(OUT, 'mask-kinds.png')
  await pngDownload.saveAs(pngPath)
  const [svgDownload] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('button:text-is("SVG に")').click()])
  const svgPath = path.join(OUT, 'mask-kinds.svg')
  await svgDownload.saveAs(svgPath)
  const svg = fs.readFileSync(svgPath, 'utf8')
  check('SVG に文字の mask・画像の枠の clipPath・画像の mask・フレームの明るさの mask が入る',
    /<mask id="Label"[^>]*data-kdr-mask-type="vector"><text /.test(svg) && /<clipPath id="Img"><path /.test(svg) &&
      /<mask id="Half"[^>]*style="mask-type:alpha"><image /.test(svg) && /<mask id="Lum"[^>]*><g /.test(svg), svg.slice(0, 600))

  // PNG と、ブラウザが描いた SVG を同じ大きさで比べる。points はページの座標（PNG の拡大率を掛ける）
  const points = { imageInside: [260, 50], imageTransparent: [290, 50], imageCorner: [203, 23], alphaShown: [230, 140], alphaHidden: [290, 140], lumWhite: [60, 170], lumGray: [140, 170] }
  const result = await viewer.evaluate(async ({ png, svg, points }) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' }))
    const read = (draw) => {
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
      draw(ctx)
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    }
    const image = new Image()
    image.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    await image.decode()
    const a = read((ctx) => ctx.drawImage(bitmap, 0, 0))
    const b = read((ctx) => ctx.drawImage(image, 0, 0, bitmap.width, bitmap.height))
    const scale = bitmap.width / 400
    let differ = 0
    // 文字の縁は書体の描き方で少しずれるので、文字の範囲（左上）を除いて比べる
    for (let i = 0; i < a.length; i += 4) {
      const x = (i / 4) % bitmap.width
      const y = Math.floor(i / 4 / bitmap.width)
      if (x < 185 * scale && y < 142 * scale) continue
      if (Math.max(...[0, 1, 2, 3].map((k) => Math.abs(a[i + k] - b[i + k]))) > 8) differ++
    }
    const at = (data, [x, y]) => {
      const i = (Math.round(y * scale) * bitmap.width + Math.round(x * scale)) * 4
      return [data[i], data[i + 1], data[i + 2]]
    }
    const samples = Object.fromEntries(Object.entries(points).map(([name, p]) => [name, { png: at(a, p), svg: at(b, p) }]))
    // 文字のマスクの範囲（赤い四角の中）で、赤と青の画素を数える。枠で切り取ると青がなく、マスクがかからないと赤一色になる
    const count = (data) => {
      let red = 0
      let blue = 0
      for (let y = 2; y < 138; y++) {
        for (let x = 12; x < 178; x++) {
          const [r, g, bl] = at(data, [x, y])
          if (r > 200 && g < 60 && bl < 60) red++
          else if (r < 80 && bl > 200) blue++
        }
      }
      return { red, blue }
    }
    return { width: bitmap.width, ratio: differ / (bitmap.width * bitmap.height), samples, text: { png: count(a), svg: count(b) } }
  }, { png: fs.readFileSync(pngPath).toString('base64'), svg, points })

  const near = (color, expected, tolerance = 3) => color.every((value, i) => Math.abs(value - expected[i]) <= tolerance)
  const both = (name, expected, tolerance) => near(result.samples[name].png, expected, tolerance) && near(result.samples[name].svg, expected, tolerance)
  const detail = (name) => JSON.stringify(result.samples[name])
  const red = [255, 0, 0]
  const blue = [51, 102, 255]
  const textShape = ({ red, blue }) => red > 1000 && blue > 1000
  check('文字のマスクは、PNG と SVG のどちらでも文字の形だけを残す（枠の矩形ではない）', textShape(result.text.png) && textShape(result.text.svg), JSON.stringify(result.text))
  check('画像の形のマスクは、PNG と SVG のどちらでも枠の内側を残す（透明な所も見える）', both('imageInside', red) && both('imageTransparent', red), `${detail('imageInside')} ${detail('imageTransparent')}`)
  check('画像の形のマスクは、PNG と SVG のどちらでも角丸の外を切り取る', both('imageCorner', blue), detail('imageCorner'))
  check('画像の不透明度のマスクは、PNG と SVG のどちらでも不透明な所だけを残す', both('alphaShown', red) && both('alphaHidden', blue), `${detail('alphaShown')} ${detail('alphaHidden')}`)
  // 灰色 #808080 の明るさは約 0.5。赤と背景の青が半分ずつ混ざる
  check('フレームの明るさのマスクは、PNG と SVG のどちらでも子の白は見せ、灰色は半分透かす',
    both('lumWhite', red) && both('lumGray', [153, 51, 128], 8), `${detail('lumWhite')} ${detail('lumGray')}`)
  check('SVG を描いた絵が PNG とほぼ同じ（文字の範囲を除いて、違う画素が 1% 未満）', result.ratio < 0.01, JSON.stringify({ width: result.width, ratio: result.ratio }))

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
