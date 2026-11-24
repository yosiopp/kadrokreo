const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

// テキストのマスクの当たり判定が文字の形で決まること（文字のすき間では奥に当たる）と、
// マスクのフレームの子の背景のぼかしが、マスクの絵の中だけをぼかす（ページの絵をぼかさない）ことを、viewer で確かめる
const { OUT, VIEWER, check, finish, crashed, watchErrors } = require('./harness.cjs')

// 黒い背景の上に:
// - Group: 不透明度のマスクのフレーム Pic（左に白い四角 Solid、右に塗りのない背景のぼかしの四角 Glass）で赤い四角を透かす。
//   ページの黒をぼかすと Glass の所が不透明になり赤が出る。マスクの絵だけをぼかせば Glass の所は透けて黒のまま
// - Group2: 不透明度 50% のフレーム Outer の中の明るさのマスク Lum（Glass2 は不透明度 90% の Inner の中）。後ろは白い WhiteBack
// - TextGroup: 「■ ■」の文字の形のマスク Label で赤い四角 RedT を切り取る
const blur = JSON.stringify([{ type: 'background-blur', blur: 20, visible: true }])
const sourcePath = path.join(OUT, 'mask-hit-backdrop.kdr')
execFileSync('node', [path.join(__dirname, '..', 'cli', 'kadrokreo.ts'),
  ...('new MaskHit + add rect --name Back --width 400 --height 400 fill=#000000' +
    ' + add frame --name Pic --x 20 --y 20 --width 160 --height 160 fills=[]' +
    ' + add rect --parent Pic --name Solid --width 40 --height 160 fill=#ffffff' +
    ' + add rect --parent Pic --name Glass --x 30 --width 130 --height 160 fills=[] effects=' + blur +
    ' + add rect --name Red --x 20 --y 20 --width 160 --height 160 fill=#ff0000' +
    ' + mask Pic Red --name Group --type alpha' +
    ' + add rect --name WhiteBack --x 200 --width 200 --height 200 fill=#ffffff' +
    ' + add frame --name Outer --x 200 --width 200 --height 200 fills=[] opacity=0.5' +
    ' + add frame --parent Outer --name Lum --x 20 --y 20 --width 160 --height 160 fills=[]' +
    ' + add rect --parent Lum --name Solid2 --width 40 --height 160 fill=#ffffff' +
    ' + add frame --parent Lum --name Inner --x 80 --width 80 --height 160 fills=[] opacity=0.9' +
    ' + add rect --parent Inner --name Glass2 --width 80 --height 160 fills=[] effects=' + blur +
    ' + add rect --parent Outer --name Red2 --x 20 --y 20 --width 160 --height 160 fill=#ff0000' +
    ' + mask Lum Red2 --name Group2 --type luminance' +
    ' + add text --name Label --x 20 --y 230 --text ■_■ fontSize=100 fill=#000000' +
    ' + add rect --name RedT --x 10 --y 220 --width 380 --height 160 fill=#ff0000' +
    ' + mask Label RedT --name TextGroup').split(' ').map((arg) => arg.replace('■_■', '■ ■')),
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
  await viewer.waitForSelector('.inspect-layer:has(.layer-name:text-is("TextGroup"))')
  await viewer.waitForTimeout(500)

  // ── 背景のぼかし（PNG の画素で） ──
  const [pngDownload] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('button:text-is("ページを PNG に")').click()])
  const pngPath = path.join(OUT, 'mask-hit-backdrop.png')
  await pngDownload.saveAs(pngPath)
  // points はページの座標。edge は Solid の縁にかかる Glass の左端（Solid のぼけた白がにじむ）
  const points = { solid: [40, 100], glass: [160, 100], edge: [66, 100], solid2: [240, 100], glass2: [360, 100] }
  const samples = await viewer.evaluate(async ({ png, points }) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' }))
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    const scale = bitmap.width / 400
    return Object.fromEntries(Object.entries(points).map(([name, [x, y]]) => {
      const i = (Math.round(y * scale) * bitmap.width + Math.round(x * scale)) * 4
      return [name, [data[i], data[i + 1], data[i + 2]]]
    }))
  }, { png: fs.readFileSync(pngPath).toString('base64'), points })
  const near = (color, expected, tolerance = 3) => color.every((value, i) => Math.abs(value - expected[i]) <= tolerance)
  check('不透明度のマスクのフレームの子の背景のぼかしは、ページの黒をぼかさない（マスクの絵の空の所は透けたまま）',
    near(samples.solid, [255, 0, 0]) && near(samples.glass, [0, 0, 0]), JSON.stringify(samples))
  check('マスクの絵の中はぼかす（Glass の左端に Solid の白がにじみ、赤が少し出る）', samples.edge[0] > 10 && samples.edge[0] < 250, JSON.stringify(samples.edge))
  check('半透明のフレームの中の明るさのマスクでも、子の背景のぼかしはマスクの絵の中だけをぼかす',
    near(samples.solid2, [255, 127, 127], 4) && near(samples.glass2, [255, 255, 255]), JSON.stringify(samples))

  // ── テキストのマスクの当たり判定（画面で押して、選ばれたものを見る） ──
  const title = () => viewer.locator('.inspect-panel .panel-title').textContent()
  await viewer.locator('button:text-is("全体表示")').click()
  await viewer.waitForTimeout(300)
  // 画面の絵から、文字の形の赤（■）と、文字の枠の中のすき間（黒）の位置を探す
  const spots = await viewer.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const ratio = canvas.width / canvas.clientWidth
    const { width, height } = canvas
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data
    const at = (x, y) => data.slice((y * width + x) * 4, (y * width + x) * 4 + 3)
    const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60
    // 最も下にある赤（TextGroup の ■。上の Group・Group2 の赤より下）の、縦の真ん中の行で探す
    let bottom = -1
    for (let y = height - 1; y >= 0 && bottom < 0; y--) {
      for (let x = 0; x < width; x++) if (isRed(at(x, y))) { bottom = y; break }
    }
    let top = bottom
    const redRow = (y) => { for (let x = 0; x < width; x++) if (isRed(at(x, y))) return true; return false }
    while (top > 0 && redRow(top - 1)) top--
    const y = Math.round((top + bottom) / 2)
    let left = width
    let right = -1
    for (let x = 0; x < width; x++) {
      if (isRed(at(x, y))) {
        left = Math.min(left, x)
        right = Math.max(right, x)
      }
    }
    // 左の ■ の中と、2 つの ■ の間のすき間（左の ■ の右端より右の、最初の黒の連なりの中央）
    let glyphEnd = left
    while (glyphEnd < right && isRed(at(glyphEnd + 1, y))) glyphEnd++
    let gapEnd = glyphEnd + 1
    while (gapEnd < right && !isRed(at(gapEnd, y))) gapEnd++
    return { glyph: [(left + glyphEnd) / 2 / ratio, y / ratio], gap: [(glyphEnd + gapEnd) / 2 / ratio, y / ratio], found: right > left && gapEnd > glyphEnd + 2 }
  })
  await viewer.locator('.canvas-view').screenshot({ path: path.join(OUT, 'mask-hit.png') })
  check('画面に文字の形の赤とすき間が見つかる', spots.found, JSON.stringify(spots))
  const box = await viewer.locator('.canvas-view canvas').boundingBox()
  await viewer.mouse.click(box.x + spots.glyph[0], box.y + spots.glyph[1])
  await viewer.waitForTimeout(200)
  const onGlyph = await title()
  check('文字の形の上を押すと、マスクで切り取った赤い四角に当たる', onGlyph === 'RedT', onGlyph)
  await viewer.keyboard.press('Escape')
  await viewer.mouse.click(box.x + spots.gap[0], box.y + spots.gap[1])
  await viewer.waitForTimeout(200)
  const onGap = await title()
  check('文字のすき間を押すと、マスクの手前の赤い四角にもマスク自身にも当たらず、奥に当たる', onGap !== 'RedT' && onGap !== 'Label' && onGap !== 'インスペクト', onGap)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
