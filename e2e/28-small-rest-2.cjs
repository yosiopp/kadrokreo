const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

// 小さな残り 2: コンポーネントの一覧のまとまりの行に説明文、フレームの通過（pass through）、テキストの背景のぼかし、
// PNG の背景、書き出しの範囲に線の太さを含めること
const OUT = path.join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })
const EDITOR = process.env.EDITOR_URL || 'http://localhost:5180'
let failures = 0
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

// バリアントのまとまり（Set、説明文つき）、黄色の上の半透明のフレーム（Group、中のシアンは乗算）、線の太い四角（Framed）、背景をぼかす文字（Glass）
const sourcePath = path.join(OUT, 'small-rest-2-source.kdr')
const cli = (...args) => execFileSync('node', [path.join(__dirname, '..', 'cli', 'kadrokreo.ts'), ...args], { encoding: 'utf8' })
cli(
  ...('new Demo + add frame --name Set --width 220 --height 60 + add frame --parent Set --name A --width 80 --height 40 fill=#5b4cf5' +
    ' + component A + add frame --parent Set --name B --x 100 --width 80 --height 40 fill=#ff8800 + component B + set A').split(' '),
  'name=種類=標準',
  ...'+ set B'.split(' '),
  'name=種類=大',
  ...'+ describe Set'.split(' '),
  '大きさを選ぶボタン',
  ...('+ add rect --name Back --y 100 --width 120 --height 80 fill=#ffff00' +
    ' + add frame --name Group --y 100 --width 120 --height 80 fills=[] opacity=0.5' +
    ' + add rect --parent Group --name Cyan --width 120 --height 80 fill=#00ffff blendMode=multiply' +
    ' + add rect --name Framed --x 160 --y 100 --width 60 --height 40 fill=#ffffff stroke=#000000 strokeWidth=8' +
    ' + add rect --name Stripe --x 260 --y 100 --width 60 --height 80 fill=#000000' +
    ' + add ellipse --name Dot --x 360 --y 100 --width 40 --height 40 fill=#00ff00' +
    ' + add text --name Glass --x 250 --y 100 --text WW fontSize=64 fills.0.opacity=0').split(' '),
  '-o', sourcePath,
)

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  await page.locator('input[type=file][accept^=".kdr"]').setInputFiles(sourcePath)
  await page.waitForTimeout(500)
  const select = (label) => page.locator(`.properties-panel .field:has(.field-label:text-is("${label}")) select`).first()
  const button = (label) => page.locator(`.properties-panel button:text-is("${label}")`)
  const row = (name) => page.locator(`.layer-row[data-copy="false"]:has(.layer-name:text-is("${name}"))`).first()
  const saved = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kadrokreo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const request = open.result.transaction('document').objectStore('document').get('current')
      request.onsuccess = () => resolve(request.result.document)
    }
  }))
  const nodesOf = async () => { await page.waitForTimeout(700); return Object.values((await saved()).pages[0].nodes) }
  const named = (nodes, name) => nodes.find((n) => n.name === name)
  // キャンバス全体の色の合計（描画が変わったかを見る）
  const canvasSum = () => page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let sum = 0
    for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2]
    return sum
  })
  // 書き出した PNG の大きさと点の色（ブラウザで読む）
  const pngPixels = (file, points) => page.evaluate(async ({ bytes, points }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    return { width: bitmap.width, height: bitmap.height, at: points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]) }
  }, { bytes: [...fs.readFileSync(file)], points })

  // ── コンポーネントの一覧: まとまりの行にまとまりの説明文 ──
  const setRow = page.locator('.component-row[data-depth="0"]:has(.component-name:text-is("Set")) .component-name')
  check('まとまりの行の名前にポインタを重ねると、まとまりの説明文が出る', (await setRow.getAttribute('title')) === '大きさを選ぶボタン', String(await setRow.getAttribute('title')))

  // ── フレームの通過 ──
  await row('Group').click()
  const options = await select('描画モード').locator('option').allTextContents()
  check('フレームを選ぶと描画モードに「通過」がある', options.includes('通過'), options.join(','))
  const before = await canvasSum()
  await select('描画モード').selectOption({ label: '通過' })
  let nodes = await nodesOf()
  check('通過を選ぶと passThrough が true になる', named(nodes, 'Group').passThrough === true && named(nodes, 'Group').blendMode === 'normal')
  const after = await canvasSum()
  check('通過にすると、中の乗算が後ろの黄色と混ざって描き変わる', after !== before, `${before} → ${after}`)
  await page.locator('.properties-panel').screenshot({ path: path.join(OUT, '60-pass-through.png') })
  await select('描画モード').selectOption({ label: '乗算' })
  nodes = await nodesOf()
  check('ほかのモードを選ぶと通過をやめる', named(nodes, 'Group').passThrough === false && named(nodes, 'Group').blendMode === 'multiply')
  await select('描画モード').selectOption({ label: '通過' })
  await row('Back').click()
  const rectOptions = await select('描画モード').locator('option').allTextContents()
  check('フレームでなければ「通過」は出ない', !rectOptions.includes('通過'), rectOptions.join(','))

  // ── テキストの背景のぼかし ──
  await row('Glass').click()
  await page.locator('.properties-panel label:has-text("影を付ける") input').check()
  const kinds = await select('影の種類').locator('option').allTextContents()
  check('テキストだけを選んでも、効果の種類に背景のぼかしがある', kinds.includes('背景のぼかし'), kinds.join(','))
  const sharp = await canvasSum()
  await select('影の種類').selectOption({ label: '背景のぼかし' })
  nodes = await nodesOf()
  check('テキストに背景のぼかしを付けられる', named(nodes, 'Glass').effects[0]?.type === 'background-blur', JSON.stringify(named(nodes, 'Glass').effects))
  const blurred = await canvasSum()
  check('テキストの背景のぼかしが描かれる（文字の形の内側で境目がぼける）', blurred !== sharp, `${sharp} → ${blurred}`)
  await page.screenshot({ path: path.join(OUT, '61-text-background-blur.png') })

  // ── 範囲に線の太さ ──
  await row('Framed').click()
  const [pngDownload] = await Promise.all([page.waitForEvent('download'), button('PNG に書き出し').click()])
  const pngPath = path.join(OUT, 'small-rest-2-framed.png')
  await pngDownload.saveAs(pngPath)
  const png = await pngPixels(pngPath, [[1, 1], [34, 24]])
  check('PNG の範囲に線の太さのはみ出し（4 ずつ）が入る', png.width === 68 && png.height === 48, `${png.width}×${png.height}`)
  check('PNG の端は黒い線、中は白', JSON.stringify(png.at) === '[[0,0,0,255],[255,255,255,255]]', JSON.stringify(png.at))
  const [svgDownload] = await Promise.all([page.waitForEvent('download'), button('SVG に').click()])
  const svg = fs.readFileSync(await svgDownload.path(), 'utf8')
  check('SVG の範囲にも線の太さが入る', /viewBox="156 96 68 48"/.test(svg), svg.slice(0, 200))

  // ── PNG の背景 ──
  await row('Dot').click()
  await page.locator('.properties-panel label:has-text("背景") input').check()
  await page.locator('[aria-label="書き出しの背景の色"]').evaluate((input) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '#ff0000')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.locator('.properties-panel .export-options').screenshot({ path: path.join(OUT, '62-export-background.png') })
  const [bgDownload] = await Promise.all([page.waitForEvent('download'), button('PNG に書き出し').click()])
  const bgPath = path.join(OUT, 'small-rest-2-background.png')
  await bgDownload.saveAs(bgPath)
  const withBackground = await pngPixels(bgPath, [[0, 0], [20, 20]])
  check('背景を敷くと、円の外の角が背景の色になる', JSON.stringify(withBackground.at) === '[[255,0,0,255],[0,255,0,255]]', JSON.stringify(withBackground.at))
  await page.locator('.properties-panel label:has-text("背景") input').uncheck()
  const [plainDownload] = await Promise.all([page.waitForEvent('download'), button('PNG に書き出し').click()])
  const plainPath = path.join(OUT, 'small-rest-2-plain.png')
  await plainDownload.saveAs(plainPath)
  const plain = await pngPixels(plainPath, [[0, 0]])
  check('背景を外すと PNG の角は透明', plain.at[0][3] === 0, JSON.stringify(plain.at))

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('CRASHED', e); process.exit(1) })
