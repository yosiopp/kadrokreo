const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

// 半透明・描画モードを持つフレームの中の背景のぼかしが、フレームの外側の絵（後ろの黒い帯）までぼかすことを、PNG の画素で確かめる
const { OUT, VIEWER, check, finish, crashed, watchErrors } = require('./harness.cjs')

// 白い背景に黒い縦の帯を 3 本。それぞれの帯の上に、塗りのない背景のぼかし（半径 20）の四角を入れたフレームを置く。
// A は不透明度 50% のフレーム、B は乗算のフレーム、C は不透明度 50% のフレームの中の乗算のフレーム（入れ子）。
// どのフレームも中身は背景のぼかしの四角だけなので、フレームの中の絵だけをぼかすと何も変わらない
const blur = JSON.stringify([{ type: 'background-blur', blur: 20, visible: true }])
const sourcePath = path.join(OUT, 'backdrop-isolated.kdr')
execFileSync('node', [path.join(__dirname, '..', 'cli', 'kadrokreo.ts'),
  ...('new Backdrop + add rect --name Back --width 400 --height 200 fill=#ffffff' +
    ' + add rect --name BarA --x 70 --width 20 --height 200 fill=#000000' +
    ' + add rect --name BarB --x 200 --width 20 --height 200 fill=#000000' +
    ' + add rect --name BarC --x 330 --width 20 --height 200 fill=#000000' +
    ' + add frame --name A --x 20 --y 30 --width 120 --height 140 fills=[] opacity=0.5' +
    ' + add rect --parent A --name GlassA --x 10 --y 10 --width 100 --height 120 fills=[] effects=' + blur +
    ' + add frame --name B --x 150 --y 30 --width 120 --height 140 fills=[] blendMode=multiply' +
    ' + add rect --parent B --name GlassB --x 10 --y 10 --width 100 --height 120 fills=[] effects=' + blur +
    ' + add frame --name C --x 280 --y 30 --width 120 --height 140 fills=[] opacity=0.5' +
    ' + add frame --parent C --name D --width 120 --height 140 fills=[] blendMode=multiply' +
    ' + add rect --parent D --name GlassC --x 10 --y 10 --width 100 --height 120 fills=[] effects=' + blur).split(' '),
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
  await viewer.waitForSelector('.inspect-layer:has(.layer-name:text-is("GlassC"))')

  const [pngDownload] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('button:text-is("ページを PNG に")').click()])
  const pngPath = path.join(OUT, 'backdrop-isolated.png')
  await pngDownload.saveAs(pngPath)

  // 帯の 5 だけ左（白）と帯の中央（黒）を、ぼかしの四角の中（y = 100）と外（y = 15）で読む。points はページの座標
  const points = {}
  for (const [name, bar] of [['a', 70], ['b', 200], ['c', 330]]) {
    points[`${name}Edge`] = [bar - 5, 100]
    points[`${name}Bar`] = [bar + 10, 100]
    points[`${name}EdgeOut`] = [bar - 5, 15]
    points[`${name}BarOut`] = [bar + 10, 15]
  }
  const samples = await viewer.evaluate(async ({ png, points }) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' }))
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    const scale = bitmap.width / 400
    return Object.fromEntries(Object.entries(points).map(([name, [x, y]]) => {
      const i = (Math.round(y * scale) * bitmap.width + Math.round(x * scale)) * 4
      return [name, data[i]]
    }))
  }, { png: fs.readFileSync(pngPath).toString('base64'), points })

  const detail = JSON.stringify(samples)
  check('ぼかしの四角の外は、帯の白と黒がそのまま', ['a', 'b', 'c'].every((n) => samples[`${n}EdgeOut`] === 255 && samples[`${n}BarOut`] === 0), detail)
  // A: 白 × 0.5 + ぼけた帯（約 180）× 0.5 ≈ 217。前は外側が見えず、白（255）と黒（0）のままだった
  check('半透明のフレームの中の背景のぼかしで、外側の帯もぼける', samples.aEdge < 240 && samples.aEdge > 190 && samples.aBar > 20 && samples.aBar < 100, detail)
  // B: 乗算なので、ぼけた帯（約 180）× 白 = 約 180。帯の中は黒 × ぼけた絵 = 黒のまま
  check('乗算のフレームの中の背景のぼかしで、外側の帯もぼけて後ろと乗算される', samples.bEdge < 220 && samples.bEdge > 130 && samples.bBar === 0, detail)
  // C: 入れ子でも、ぼかしの元は外側の帯まで含む（乗算した絵を 50% で重ねる）
  check('入れ子のフレームの中の背景のぼかしでも、外側の帯がぼける', samples.cEdge < 245 && samples.cEdge > 170, detail)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
