// 塗りの残り 3: 塗り・影ごとの表示の切り替え（目のボタン）、角度のグラデーション、内側の影。viewer の CSS と SVG の書き出しも
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
      request.onerror = () => reject(request.error)
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
  const bluish = (p) => p[0] < 90 && p[2] > 200 && p[3] === 255
  const typeSelect = (label) => page.locator(`.field:has(.field-label:text-is("${label}の種類")) select`)
  const canvasButton = page.locator('.properties-panel button:text-is("キャンバスで動かす"), .properties-panel button:text-is("キャンバスでの編集を終える")')

  // ── 塗りの目のボタン ──
  // 200 × 100 の長方形（ページの (100, 100) 〜 (300, 200)）
  await page.keyboard.press('r'); await drag([100, 100], [300, 200])
  await page.locator('[aria-label="塗りの色"]').fill('#ff0000')
  await deselect()
  const background = await pixel(200, 150).then(() => pixel(700, 500))
  await page.mouse.click(...at(200, 150))
  await page.locator('[aria-label="塗りを隠す"]').click()
  let rect = await byName('Rectangle 1')
  check('目のボタンで塗りを隠せる（消さずに残る）', rect.fills.length === 1 && rect.fills[0].visible === false && rect.fills[0].color === '#ff0000', JSON.stringify(rect.fills))
  await deselect()
  const hidden = await pixel(200, 150)
  check('隠した塗りは描かない', JSON.stringify(hidden) === JSON.stringify(background), `${hidden} / ${background}`)
  await page.mouse.click(...at(200, 150))
  await page.locator('[aria-label="塗りを表示する"]').click()
  rect = await byName('Rectangle 1')
  check('もう一度押すと表示に戻る', rect.fills[0].visible === true)

  // ── 角度のグラデーション ──
  await typeSelect('塗り').selectOption('conic')
  await page.locator('[aria-label="塗りの2 番目の色"]').fill('#0000ff')
  rect = await byName('Rectangle 1')
  check('角度のグラデーションにできる（中心と始まりの角度）', rect.fills[0].type === 'conic' && rect.fills[0].cx === 0.5 && rect.fills[0].angle === 0, JSON.stringify(rect.fills[0]))
  await deselect()
  // 始まりの向きは右（0°）で時計回り。中心のすぐ右下は始まりの色、右上は 1 周した終わりの色
  const start = await pixel(230, 155), end = await pixel(230, 145)
  check('中心のまわりに時計回りで色が変わる', reddish(start) && bluish(end), `${start} / ${end}`)
  await page.mouse.click(...at(200, 150))
  await canvasButton.click()
  // 中心 (200, 150) をつかんで左へ。向きの先は中心から右へ枠の短い辺の半分（50）
  await drag([200, 150], [150, 150])
  await drag([200, 150], [150, 100])
  rect = await byName('Rectangle 1')
  check('キャンバスで中心と向きを動かせる', rect.fills[0].cx === 0.25 && rect.fills[0].cy === 0.5 && rect.fills[0].angle === -90, JSON.stringify(rect.fills[0]))
  await page.keyboard.press('Escape')
  await set('始まりの角度', 0)
  await page.screenshot({ path: path.join(OUT, '43-conic-gradient.png') })

  // ── 内側の影 ──
  await page.keyboard.press('r'); await drag([400, 100], [600, 200])
  await page.locator('[aria-label="塗りの色"]').fill('#ffffff')
  await page.locator('label:has-text("影を付ける") input').check()
  await typeSelect('影').selectOption('inner-shadow')
  await set('ぼかし', 4)
  await set('濃さ', 80)
  let card = await byName('Rectangle 2')
  check('影の種類を内側の影にできる', card.effects[0].type === 'inner-shadow' && card.effects[0].y === 4, JSON.stringify(card.effects))
  await deselect()
  // 下へずれる影なので、内側の上の縁が暗く、中央と枠の外はそのまま
  const top = await pixel(500, 102), middle = await pixel(500, 150), outside = await pixel(500, 96)
  check('内側の影は図形の中の縁に付き、外にははみ出さない', top[0] < 200 && middle[0] > 250 && JSON.stringify(outside) === JSON.stringify(background), `${top} / ${middle} / ${outside}`)
  await page.mouse.click(...at(500, 150))
  await page.screenshot({ path: path.join(OUT, '44-inner-shadow.png') })
  await page.locator('[aria-label="影を隠す"]').click()
  card = await byName('Rectangle 2')
  await deselect()
  const unshadowed = await pixel(500, 102)
  check('影も目のボタンで隠せる', card.effects[0].visible === false && unshadowed[0] > 250, `${unshadowed}`)
  await page.mouse.click(...at(500, 150))
  await page.locator('[aria-label="影を表示する"]').click()

  // ── 書き出しと viewer ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'paint-rest-3.kdr')
  await download.saveAs(kdrPath)
  const json = await require('./kdr.cjs').parseKdrBytes(fs.readFileSync(kdrPath))
  const raw = JSON.stringify(json.raw)
  check('kdr に角度のグラデーションと内側の影が入り、表示（true）は書かない', raw.includes('"type":"conic"') && raw.includes('"type":"inner-shadow"') && !raw.includes('"visible":true'), raw.slice(0, 300))

  const viewer = await context.newPage()
  viewer.on('pageerror', (e) => errors.push('viewer: ' + String(e)))
  viewer.on('console', (m) => m.type() === 'error' && errors.push('viewer: ' + m.text()))
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  const panel = viewer.locator('.inspect-panel')
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Rectangle 1"))').click()
  const conicCss = await panel.locator('.inspect-code').first().textContent()
  check('viewer の CSS に conic-gradient が出る', conicCss.includes('background: conic-gradient(from 90deg at 25% 50%, #ff0000 0%, #0000ff 100%);'), conicCss)
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Rectangle 2"))').click()
  const insetCss = await panel.locator('.inspect-code').first().textContent()
  check('viewer の CSS に内側の影が inset で出る', insetCss.includes('box-shadow: inset 0 4px 4px rgba(0, 0, 0, 0.8);'), insetCss)
  const [svgDownload] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('button:text-is("SVG に")').first().click()])
  const svgText = fs.readFileSync(await svgDownload.path(), 'utf8')
  check('SVG に角度のグラデーション（pattern）と内側の影（filter）が入る', svgText.includes('<pattern') && svgText.includes('operator="out"'), svgText.slice(0, 200))

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('CRASHED', e); process.exit(1) })
