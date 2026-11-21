const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const zlib = require('zlib')

const OUT = path.join(__dirname, 'out')
const FIXTURES = path.join(__dirname, 'fixtures')
fs.mkdirSync(OUT, { recursive: true })
const EDITOR = process.env.EDITOR_URL || 'http://localhost:5180'
const VIEWER = process.env.VIEWER_URL || 'http://localhost:5181'
let failures = 0
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const box = await page.locator('.canvas-view').boundingBox()
  const at = (x, y) => [box.x + x, box.y + y]
  const drag = async (from, to) => {
    await page.mouse.move(...at(...from)); await page.mouse.down()
    await page.mouse.move(...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), { steps: 4 })
    await page.mouse.move(...at(...to), { steps: 4 })
    await page.mouse.up()
  }
  const field = (label) => page.locator(`.field:has(.field-label:text-is("${label}")) input`).first()
  const set = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Enter') }
  const deselect = () => page.mouse.click(...at(740, 600))
  const saved = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kadrokreo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const request = open.result.transaction('document').objectStore('document').get('current')
      request.onsuccess = () => resolve(request.result.document.pages[0])
    }
  }))
  const byName = async (name) => { await page.waitForTimeout(700); return Object.values((await saved()).nodes).find((n) => n.name === name) }
  // 描画は requestAnimationFrame でまとめられるので、2 フレーム待ってから読む
  const pixel = (x, y) => page.evaluate(async ([x, y]) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const ratio = canvas.width / canvas.clientWidth
    return [...canvas.getContext('2d').getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data]
  }, [x, y])
  const reddish = (p) => p[0] > 200 && p[1] < 90 && p[2] < 90 && p[3] === 255
  const bluish = (p) => p[0] < 60 && p[2] > 200 && p[3] === 255
  const whitish = (p) => p[0] > 240 && p[1] > 240 && p[2] > 240 && p[3] === 255
  /** PNG のヘッダから幅と高さを読む */
  const pngSize = (file) => {
    const bytes = fs.readFileSync(file)
    const signature = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    return { signature, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }

  // ── グラデーション ──
  await page.keyboard.press('r'); await drag([100, 100], [300, 200])
  await page.locator('.color-field input[type=color]').first().fill('#ff0000')
  await page.locator('label:has-text("グラデーション") input').check()
  await page.locator('[aria-label="グラデーションの終わりの色"]').fill('#0000ff')
  await set('角度', 0)
  let rect = await byName('Rectangle 1')
  check('グラデーションが保存される', JSON.stringify(rect.fillGradient) === JSON.stringify({ angle: 0, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] }), JSON.stringify(rect.fillGradient))
  await deselect()
  const left = await pixel(103, 150), right = await pixel(297, 150), middle = await pixel(200, 150)
  check('左から右へ色が変わる', reddish(left) && bluish(right) && middle[0] > 80 && middle[2] > 80, `${left} / ${middle} / ${right}`)

  await page.mouse.click(...at(200, 150))
  await set('角度', 90)
  await deselect()
  const top = await pixel(200, 103), bottom = await pixel(200, 197)
  check('角度 90 で上から下へ変わる', reddish(top) && bluish(bottom), `${top} / ${bottom}`)

  // 塗りの色を変えると、始まりの色も変わる
  await page.mouse.click(...at(200, 150))
  await page.locator('.color-field input[type=color]').first().fill('#00ff00')
  rect = await byName('Rectangle 1')
  check('塗りの色を変えると始まりの色も変わる', rect.fill === '#00ff00' && rect.fillGradient.stops[0].color === '#00ff00' && rect.fillGradient.stops[1].color === '#0000ff', JSON.stringify(rect.fillGradient))
  await page.keyboard.press('Meta+z')
  await page.screenshot({ path: path.join(OUT, '29-gradient.png') })

  // ── PNG 書き出し ──
  await page.locator('[aria-label="書き出しの倍率"]').selectOption('2')
  const [selectionPng] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("PNG に書き出し")').click()])
  const selectionPath = path.join(OUT, 'export-selection.png')
  await selectionPng.saveAs(selectionPath)
  const size = pngSize(selectionPath)
  check('選択したものを 2 倍で書き出せる', selectionPng.suggestedFilename() === 'Rectangle 1@2x.png' && size.signature && size.width === 400 && size.height === 200, `${selectionPng.suggestedFilename()} ${JSON.stringify(size)}`)
  // 書き出した画像の中身（左上は赤、右下は青、選択枠は写らない）
  const exported = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0)
    const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data]
    return { top: at(200, 4), bottom: at(200, 195), corner: at(0, 0) }
  }, fs.readFileSync(selectionPath).toString('base64'))
  check('書き出した PNG にグラデーションが写り、選択枠は写らない', reddish(exported.top) && bluish(exported.bottom) && reddish(exported.corner), JSON.stringify(exported))

  // 何も選んでいなければページ全体
  await page.keyboard.press('o'); await drag([400, 150], [460, 250])
  await deselect()
  const [pagePng] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("このページを PNG に書き出し")').click()])
  const pagePath = path.join(OUT, 'export-page.png')
  await pagePng.saveAs(pagePath)
  const pageSize = pngSize(pagePath)
  check('何も選んでいなければページ全体を書き出す', pagePng.suggestedFilename() === 'Untitled - Page 1.png' && pageSize.width === 360 && pageSize.height === 150, `${pagePng.suggestedFilename()} ${JSON.stringify(pageSize)}`)

  // ── 画像の収め方 ──
  // 200 × 100 の赤い画像の中央に、100 × 50 の白い四角
  const photo = path.join(OUT, 'fit-source.png')
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 100
    const ctx = c.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 200, 100)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(50, 25, 100, 50)
    return c.toDataURL('image/png')
  })
  fs.writeFileSync(photo, Buffer.from(dataUrl.split(',')[1], 'base64'))
  await page.locator('input[type=file][accept^="image/"]').setInputFiles(photo)
  await page.waitForFunction(() => [...document.querySelectorAll('.layer-name')].some((e) => e.textContent === 'fit-source'))
  await set('X', 500); await set('Y', 400); await set('W', 100); await set('H', 100)
  let image = await byName('fit-source')
  check('新しい画像は「枠を埋めて切り抜く」', image.fit === 'cover' && image.width === 100 && image.height === 100, JSON.stringify([image.fit, image.width, image.height]))
  const fitSelect = page.locator('.field:has(.field-label:text-is("収め方")) select')
  await deselect()
  // 枠の左端・上下中央。切り抜きなら白い四角が左右いっぱいに広がる
  check('切り抜き: 画像の中央が枠いっぱいに広がる', whitish(await pixel(505, 450)) && reddish(await pixel(550, 410)), `${await pixel(505, 450)} / ${await pixel(550, 410)}`)
  await page.mouse.click(...at(550, 450))
  await fitSelect.selectOption('stretch')
  await deselect()
  check('引き伸ばし: 画像全体が枠に合わせて歪む', reddish(await pixel(505, 450)) && whitish(await pixel(550, 450)), `${await pixel(505, 450)}`)
  await page.mouse.click(...at(550, 450))
  await fitSelect.selectOption('contain')
  await deselect()
  const margin = await pixel(550, 410)
  check('全体を収める: 上下に余白が空く', margin[3] === 0 && reddish(await pixel(505, 450)), `${margin}`)
  await page.screenshot({ path: path.join(OUT, '30-image-fit.png') })

  // ── 書き出しと viewer ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'paint.kdr')
  await download.saveAs(kdrPath)
  const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(kdrPath)).toString('utf8'))
  const nodes = Object.values(json.document.pages[0].nodes)
  check('kdr にグラデーションと収め方が入る', json.version === 11 && nodes.some((n) => n.fillGradient) && nodes.some((n) => n.fit === 'contain'))

  const viewer = await context.newPage()
  viewer.on('pageerror', (e) => errors.push('viewer: ' + String(e)))
  viewer.on('console', (m) => m.type() === 'error' && errors.push('viewer: ' + m.text()))
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(400)
  await viewer.screenshot({ path: path.join(OUT, '31-viewer-paint.png') })
  // viewer でもページやフレームを PNG として保存できる（ドキュメントは変更しない）
  await viewer.locator('[aria-label="書き出しの倍率"]').selectOption('2')
  const [viewerPng] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('button:text-is("ページを PNG に")').click()])
  const viewerPath = path.join(OUT, 'export-viewer.png')
  await viewerPng.saveAs(viewerPath)
  const viewerSize = pngSize(viewerPath)
  // ページ全体: 長方形の左端 100 から画像の右端 600、上端 100 から下端 500
  check('viewer でページを PNG に書き出せる', viewerPng.suggestedFilename() === 'Untitled - Page 1@2x.png' && viewerSize.signature && viewerSize.width === 1000 && viewerSize.height === 800, `${viewerPng.suggestedFilename()} ${JSON.stringify(viewerSize)}`)
  check('viewer に編集 UI がない', (await viewer.locator('.toolbar, .layers-panel, .properties-panel, .page-row').count()) === 0)
  await viewer.locator('input[type=file]').setInputFiles(path.join(FIXTURES, 'sample-v6.kdr'))
  await viewer.waitForTimeout(400)
  check('version 6 の kdr も開ける', (await viewer.locator('.app-message').count()) === 0)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('CRASHED', e); process.exit(1) })
