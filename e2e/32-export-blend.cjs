const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

// 影ごとの描画モードと半透明の通過のフレームを、SVG の書き出しが描画（PNG）と同じ見た目で書くことを、画素で見比べて確かめる
const { OUT, VIEWER, check, finish, crashed, watchErrors } = require('./harness.cjs')

// 青い背景の上に、乗算の赤い落ち影の白い四角（Drop）、乗算の黄色い内側の影の灰色の四角（Inner）、
// 半透明（50%）の通過のフレーム（Group。中に乗算の黄色 A と差の白 B が重ならずに並ぶ）、落ち影が 2 つの白い四角（Two。右に赤、左に緑）。
// 中身を切り取るフレーム（Clip）の中に、枠から上と右へはみ出す乗算の黄色（M）と、切り取らない透明なフレーム（Sub）の中の
// 枠から下へはみ出す差の白（D）。影はぼかさない（縁のにじみの差を避ける）
const sourcePath = path.join(OUT, 'export-blend.kdr')
execFileSync('node', [path.join(__dirname, '..', 'cli', 'kadrokreo.ts'),
  ...('new Blend + add rect --name Back --width 400 --height 200 fill=#3366ff' +
    ' + add rect --name Drop --x 20 --y 20 --width 80 --height 60 fill=#ffffff' +
    ' shadow.x=30 shadow.y=30 shadow.blur=0 shadow.color=#ff0000 shadow.opacity=1 shadow.blendMode=multiply' +
    ' + add rect --name Inner --x 140 --y 20 --width 80 --height 60 fill=#808080' +
    ' shadow.type=inner-shadow shadow.x=20 shadow.y=0 shadow.blur=0 shadow.color=#ffff00 shadow.opacity=1 shadow.blendMode=multiply' +
    ' + add frame --name Group --x 260 --y 20 --width 120 --height 60 fills=[] opacity=0.5 passThrough=true' +
    ' + add rect --parent Group --name A --width 50 --height 60 fill=#ffff00 blendMode=multiply' +
    ' + add rect --parent Group --name B --x 70 --width 50 --height 60 fill=#ffffff blendMode=difference' +
    ' + add frame --name Clip --x 200 --y 110 --width 120 --height 70 fills=[] clipContent=true' +
    ' + add rect --parent Clip --name M --x 60 --y -20 --width 100 --height 50 fill=#ffff00 blendMode=multiply' +
    ' + add frame --parent Clip --name Sub --x 10 --y 30 --width 40 --height 60 fills=[] clipContent=false' +
    ' + add rect --parent Sub --name D --width 40 --height 60 fill=#ffffff blendMode=difference' +
    ' + add rect --name Two --x 20 --y 130 --width 60 --height 40 fill=#ffffff effects=' + JSON.stringify([
      { type: 'drop-shadow', x: 70, y: 0, blur: 0, spread: 0, color: '#ff0000', opacity: 1, visible: true, blendMode: 'normal' },
      { type: 'drop-shadow', x: -15, y: 0, blur: 0, spread: 0, color: '#00ff00', opacity: 1, visible: true, blendMode: 'normal' },
    ])).split(' '),
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
  await viewer.waitForSelector('.inspect-layer:has(.layer-name:text-is("Group"))')

  const [pngDownload] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('button:text-is("ページを PNG に")').click()])
  const pngPath = path.join(OUT, 'export-blend.png')
  await pngDownload.saveAs(pngPath)
  const [svgDownload] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('button:text-is("SVG に")').click()])
  const svgPath = path.join(OUT, 'export-blend.svg')
  await svgDownload.saveAs(svgPath)
  const svg = fs.readFileSync(svgPath, 'utf8')
  check('SVG に描画モードのある影の carrier が入り、表せないというコメントがない',
    svg.includes('style="mix-blend-mode:multiply" data-kdr-part="carrier"') && !svg.includes('<!--'), svg.slice(0, 300))
  check('切り取るフレームは、clip-path の g でなく子の要素ごとに切り取り、取り込み用の印を残す',
    svg.includes('<g data-kdr-clip=') && !svg.includes('<g clip-path='), svg.slice(0, 600))

  // PNG と、ブラウザが描いた SVG を同じ大きさで比べる。points はページの座標（PNG の拡大率を掛ける）
  const points = { drop: [115, 95], inner: [150, 50], passMultiply: [285, 50], passDifference: [355, 50], first: [130, 150], second: [10, 150],
    clipMultiply: [290, 125], clipOutside: [340, 125], clipDeep: [230, 160], clipDeepOutside: [230, 190] }
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
    let differ = 0
    for (let i = 0; i < a.length; i += 4) {
      if (Math.max(...[0, 1, 2, 3].map((k) => Math.abs(a[i + k] - b[i + k]))) > 8) differ++
    }
    const scale = bitmap.width / 400
    const at = (data, [x, y]) => {
      const i = (Math.round(y * scale) * bitmap.width + Math.round(x * scale)) * 4
      return [data[i], data[i + 1], data[i + 2]]
    }
    const samples = Object.fromEntries(Object.entries(points).map(([name, p]) => [name, { png: at(a, p), svg: at(b, p) }]))
    return { width: bitmap.width, height: bitmap.height, ratio: differ / (bitmap.width * bitmap.height), samples }
  }, { png: fs.readFileSync(pngPath).toString('base64'), svg, points })

  const near = (color, expected) => color.every((value, i) => Math.abs(value - expected[i]) <= 3)
  const both = (name, expected) => near(result.samples[name].png, expected) && near(result.samples[name].svg, expected)
  const detail = (name) => JSON.stringify(result.samples[name])
  // 乗算: 赤 × 青 #3366ff = (51, 0, 0)。ふつうに重ねると赤のまま
  check('乗算の落ち影は、PNG と SVG のどちらでも後ろの青と乗算される', both('drop', [51, 0, 0]), detail('drop'))
  // 乗算: 黄 × 灰 #808080 = (128, 128, 0)
  check('乗算の内側の影は、PNG と SVG のどちらでも塗りの灰色と乗算される', both('inner', [128, 128, 0]), detail('inner'))
  // 通過: 青 × 0.5 + 乗算(青, 黄) (51, 102, 0) × 0.5。まとめて半透明にすると (153, 179, 128) になる
  check('通過のフレームの中の乗算は、PNG と SVG のどちらでも後ろの青に効く', both('passMultiply', [51, 102, 128]), detail('passMultiply'))
  // 通過: 青 × 0.5 + 差(青, 白) (204, 153, 0) × 0.5
  check('通過のフレームの中の差も、PNG と SVG のどちらでも後ろの青に効く', both('passDifference', [128, 128, 128]), detail('passDifference'))
  // 影が 2 つなら、最後でない影も描く（前は描画で抜けていた）
  check('落ち影が 2 つあれば、PNG と SVG のどちらでも両方が落ちる', both('first', [255, 0, 0]) && both('second', [0, 255, 0]), `${detail('first')} ${detail('second')}`)
  // 切り取るフレームの子の乗算: 黄 × 青 = (51, 102, 0)。clip-path の g で囲むと後ろと混ざらず黄色のままになる
  check('切り取るフレームの中の乗算は、PNG と SVG のどちらでも後ろの青に効く', both('clipMultiply', [51, 102, 0]), detail('clipMultiply'))
  check('切り取るフレームからはみ出した乗算の子は、PNG と SVG のどちらでも切り取られる', both('clipOutside', [51, 102, 255]), detail('clipOutside'))
  // 切り取らないフレームの中の差（入れ子）: 差(青, 白) = (204, 153, 0)。はみ出しは外側のフレームで切り取られる
  check('切り取るフレームの孫の差も、PNG と SVG のどちらでも後ろの青に効く', both('clipDeep', [204, 153, 0]), detail('clipDeep'))
  check('孫のはみ出しも、PNG と SVG のどちらでも外側のフレームで切り取られる', both('clipDeepOutside', [51, 102, 255]), detail('clipDeepOutside'))
  check('SVG を描いた絵が PNG とほぼ同じ（違う画素が 1% 未満）', result.width === 400 * Math.round(result.width / 400) && result.ratio < 0.01, JSON.stringify({ width: result.width, ratio: result.ratio }))

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
