// 塗りの残り: キャンバスでグラデーションを動かす操作、塗りごとの不透明度、画像の切り抜きの拡大
const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')

const OUT = path.join(__dirname, 'out')
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
  const drag = async (from, to, options = {}) => {
    if (options.shift) await page.keyboard.down('Shift')
    await page.mouse.move(...at(...from)); await page.mouse.down()
    await page.mouse.move(...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), { steps: 4 })
    await page.mouse.move(...at(...to), { steps: 4 })
    await page.mouse.up()
    if (options.shift) await page.keyboard.up('Shift')
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
  const pixel = (x, y) => page.evaluate(async ([x, y]) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const ratio = canvas.width / canvas.clientWidth
    return [...canvas.getContext('2d').getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data]
  }, [x, y])
  const reddish = (p) => p[0] > 200 && p[1] < 90 && p[2] < 90 && p[3] === 255
  const bluish = (p) => p[0] < 60 && p[2] > 200 && p[3] === 255
  const whitish = (p) => p[0] > 240 && p[1] > 240 && p[2] > 240 && p[3] === 255
  const typeSelect = (label) => page.locator(`.field:has(.field-label:text-is("${label}の種類")) select`)
  const canvasButton = page.locator('.properties-panel button[aria-pressed]:not(.icon-button)')

  // ── 直線のグラデーションをキャンバスで動かす ──
  // 200 × 100 の長方形。角度 0 なら、色が並ぶ線は左辺の中央 (100, 150) から右辺の中央 (300, 150)
  await page.keyboard.press('r'); await drag([100, 100], [300, 200])
  await page.locator('[aria-label="塗りの色"]').fill('#ff0000')
  await typeSelect('塗り').selectOption('linear')
  await page.locator('[aria-label="塗りの2 番目の色"]').fill('#0000ff')
  await set('角度', 0)
  await canvasButton.click()
  check('「キャンバスで動かす」で編集に入る', (await canvasButton.getAttribute('aria-pressed')) === 'true' && (await canvasButton.textContent()) === 'キャンバスでの編集を終える')

  // 終点は自由に置ける（始点はそのまま）。位置は枠に対する割合
  await drag([300, 150], [200, 260])
  let rect = await byName('Rectangle 1')
  const line = rect.fills[0]
  check('終点をつかんで自由に置ける', line.x1 === 0 && line.y1 === 0.5 && line.x2 === 0.5 && line.y2 === 1.6, JSON.stringify(line))
  // Shift なら、終点 (200, 260) を中心に向きを 15° 刻みにする（左上 45° の向き）
  await drag([100, 150], [90, 160], { shift: true })
  rect = await byName('Rectangle 1')
  const snapped = rect.fills[0]
  const dx = (snapped.x2 - snapped.x1) * 200
  const dy = (snapped.y2 - snapped.y1) * 100
  check('始点も動かせて、Shift で 15° 刻み', Math.abs(dx - dy) < 0.5 && dx > 0 && snapped.x2 === 0.5, JSON.stringify(snapped))
  await set('角度', 90)
  rect = await byName('Rectangle 1')
  check('角度を入れると、枠の中心を通る線に戻る', JSON.stringify([rect.fills[0].x1, rect.fills[0].y1, rect.fills[0].x2, rect.fills[0].y2]) === '[0.5,0,0.5,1]', JSON.stringify(rect.fills[0]))

  // 角度 90 なら線は (200, 100) から (200, 200)。色の印は線の右へ 18px 離れた (218, 100) と (218, 200)
  await drag([218, 100], [218, 125])
  rect = await byName('Rectangle 1')
  check('色の印をつかんで位置を動かせる', rect.fills[0].stops[0].offset === 0.25 && rect.fills[0].stops[1].offset === 1, JSON.stringify(rect.fills[0].stops))
  check('つかんだ色がパネルでも選ばれる', (await page.locator('.stop-row.selected').count()) === 1 && (await page.locator('.stop-row').first().getAttribute('class')).includes('selected'))

  // 線の上をダブルクリックすると、そこに色を足して選ぶ。Delete で選んだ色を消す（図形は消えない）
  await page.mouse.dblclick(...at(200, 175))
  rect = await byName('Rectangle 1')
  const stops = rect.fills[0].stops
  check('線の上のダブルクリックで色を足せる', stops.length === 3 && stops[1].offset === 0.75 && stops[1].color !== '#ff0000' && stops[1].color !== '#0000ff', JSON.stringify(stops))
  check('足した色が選ばれる', (await page.locator('.stop-row.selected').count()) === 1 && (await page.locator('.stop-row').nth(1).getAttribute('class')).includes('selected'))
  await page.screenshot({ path: path.join(OUT, '41-gradient-canvas.png') })
  await page.keyboard.press('Delete')
  rect = await byName('Rectangle 1')
  check('Delete で選んだ色を消せる（図形は残る）', rect && rect.fills[0].stops.length === 2, JSON.stringify(rect?.fills))
  await page.keyboard.press('Escape')
  check('Esc で編集を抜ける（選択は残る）', (await canvasButton.getAttribute('aria-pressed')) === 'false' && (await page.locator('.properties-panel').count()) === 1)

  // ── 円形のグラデーション ──
  // 中心 (200, 150)、横の半径の先 (300, 150)、縦の半径の先 (200, 200)
  await typeSelect('塗り').selectOption('radial')
  await canvasButton.click()
  await drag([200, 150], [150, 130])
  rect = await byName('Rectangle 1')
  check('円形の中心を動かせる', rect.fills[0].cx === 0.25 && rect.fills[0].cy === 0.3, JSON.stringify(rect.fills[0]))
  await drag([150, 180], [150, 200])
  rect = await byName('Rectangle 1')
  check('縦の半径を変えられる', rect.fills[0].ry === 0.7 && rect.fills[0].rx === 0.5, JSON.stringify(rect.fills[0]))
  await drag([250, 130], [190, 130], { shift: true })
  rect = await byName('Rectangle 1')
  check('Shift で縦横の半径を揃えて円にできる', rect.fills[0].rx === 0.2 && rect.fills[0].ry === 0.4 && rect.fills[0].angle === 0, JSON.stringify(rect.fills[0]))
  // 半径の先を中心の真下へ回すと、楕円が 90° 回る
  await drag([190, 130], [150, 170])
  rect = await byName('Rectangle 1')
  check('半径の先を回すと楕円が回る', rect.fills[0].angle === 90 && rect.fills[0].rx === 0.2, JSON.stringify(rect.fills[0]))
  await drag([150, 170], [190, 130])
  // 別の図形を選ぶと抜ける
  await deselect()
  await page.mouse.click(...at(200, 150))
  check('選び直すと編集は終わっている', (await canvasButton.getAttribute('aria-pressed')) === 'false')

  // ── 塗りごとの不透明度 ──
  await typeSelect('塗り').selectOption('solid')
  await page.locator('[aria-label="塗りの色"]').fill('#ff0000')
  await set('不透明度 %', 50)
  rect = await byName('Rectangle 1')
  check('塗りの不透明度を変えられる', rect.fills[0].opacity === 0.5 && rect.opacity === 1, JSON.stringify(rect.fills))
  await page.locator('[aria-label="塗りの色"]').fill('#0000ff')
  rect = await byName('Rectangle 1')
  check('色を変えても塗りの不透明度は残る', rect.fills[0].opacity === 0.5 && rect.fills[0].color === '#0000ff', JSON.stringify(rect.fills))
  await deselect()
  const half = await pixel(200, 150)
  check('半透明に描かれる', half[2] > 200 && half[3] > 100 && half[3] < 160, `${half}`)
  // 下に不透明な赤を重ねると、上の青が半分透けて紫になる
  await page.mouse.click(...at(200, 150))
  await page.locator('[aria-label="塗りを足す"]').click()
  await page.locator('[aria-label="塗りの色"]').fill('#ff0000')
  await page.locator('[aria-label="塗りを下へ"]').click()
  await deselect()
  const mixed = await pixel(200, 150)
  check('下の塗りが透けて見える', mixed[0] > 100 && mixed[2] > 100 && mixed[3] === 255, `${mixed}`)

  // ── 画像の切り抜きの拡大 ──
  // 200 × 100 の赤い画像の中央に、100 × 50 の白い四角
  const photo = path.join(OUT, 'crop-source.png')
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 100
    const ctx = c.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 200, 100)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(50, 25, 100, 50)
    return c.toDataURL('image/png')
  })
  fs.writeFileSync(photo, Buffer.from(dataUrl.split(',')[1], 'base64'))
  await page.locator('input[type=file][accept^="image/"]').setInputFiles(photo)
  await page.waitForFunction(() => [...document.querySelectorAll('.layer-name')].some((e) => e.textContent === 'crop-source'))
  await set('X', 500); await set('Y', 400); await set('W', 100); await set('H', 100)
  await deselect()
  check('拡大する前は上下に赤が見える', reddish(await pixel(550, 410)) && whitish(await pixel(550, 450)), `${await pixel(550, 410)}`)
  await page.mouse.click(...at(550, 450))
  await set('拡大 %', 200)
  let image = await byName('crop-source')
  check('切り抜きを拡大できる', image.scale === 2, JSON.stringify(image))
  await deselect()
  check('拡大すると白い四角が枠いっぱいに広がる', whitish(await pixel(550, 410)) && whitish(await pixel(505, 495)), `${await pixel(550, 410)} / ${await pixel(505, 495)}`)
  await page.mouse.click(...at(550, 450))
  await set('縦の位置 %', 0)
  await deselect()
  // 拡大した画像（400 × 200）を上に寄せると、白い四角（縦 50〜150）の上の赤が枠の上端に来る
  check('拡大した画像の残す場所を寄せる位置で選べる', reddish(await pixel(550, 410)) && whitish(await pixel(550, 470)), `${await pixel(550, 410)} / ${await pixel(550, 470)}`)
  await page.mouse.click(...at(550, 450))
  await set('拡大 %', 50)
  image = await byName('crop-source')
  check('100% より小さくはできない', image.scale === 1, JSON.stringify(image.scale))
  await set('拡大 %', 200)
  await page.screenshot({ path: path.join(OUT, '42-image-crop.png') })

  // ── 書き出しと viewer ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'paint-rest.kdr')
  await download.saveAs(kdrPath)
  const json = await require('./kdr.cjs').parseKdrBytes(fs.readFileSync(kdrPath))
  const raw = JSON.stringify(json.raw)
  check('kdr に塗りの不透明度と拡大が入り、1 の不透明度は書かない', raw.includes('"opacity":0.5') && raw.includes('"scale":2') && !raw.includes('"opacity":1'), raw.slice(0, 300))

  const viewer = await context.newPage()
  viewer.on('pageerror', (e) => errors.push('viewer: ' + String(e)))
  viewer.on('console', (m) => m.type() === 'error' && errors.push('viewer: ' + m.text()))
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  const panel = viewer.locator('.inspect-panel')
  const value = (section, label) => panel.locator(`section[aria-label="${section}"] .inspect-row:has(dt:text-is("${label}")) .inspect-value`)
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("crop-source"))').click()
  const imageCss = await panel.locator('.inspect-code').first().textContent()
  check('viewer に拡大と object-view-box が出る', (await value('画像', '拡大').textContent()) === '200%' && imageCss.includes('object-view-box: inset(0% 25% 50% 25%);'), imageCss)
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Rectangle 1"))').click()
  const rectCss = await panel.locator('.inspect-code').first().textContent()
  check('viewer に塗りの不透明度が出て、CSS は色の alpha になる', (await value('塗り', '不透明度').textContent()) === '50%' && rectCss.includes('rgba(0, 0, 255, 0.5)'), rectCss)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('CRASHED', e); process.exit(1) })
