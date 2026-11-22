// 塗りの残り 4: 描画モード（ノード・塗り）、影の広がり、ぼかしの効果、円形のグラデーションを回す形。viewer の CSS と SVG の書き出しも
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
  const select = (label) => page.locator(`.properties-panel .field:has(.field-label:text-is("${label}")) select`).first()
  const typeSelect = (label) => page.locator(`.field:has(.field-label:text-is("${label}の種類")) select`)

  await deselect()
  const background = await pixel(700, 500)

  // ── ノードの描画モード ──
  // 赤（ページの (100, 100) 〜 (300, 200)）の上に、白（(200, 150) 〜 (400, 250)）を重ねる
  await page.keyboard.press('r'); await drag([100, 100], [300, 200])
  await page.locator('[aria-label="塗りの色"]').fill('#ff0000')
  await page.keyboard.press('r'); await drag([200, 150], [400, 250])
  await page.locator('[aria-label="塗りの色"]').fill('#ffffff')
  await select('描画モード').selectOption('multiply')
  let top = await byName('Rectangle 2')
  check('ノードの描画モードを選べる', top.blendMode === 'multiply', top.blendMode)
  await deselect()
  // 白を乗算で重ねると下の赤のまま。重ならない所は白
  const overlap = await pixel(250, 175), alone = await pixel(350, 225)
  check('乗算で重ねると下の色が透ける', reddish(overlap) && alone[0] > 250 && alone[1] > 250, `${overlap} / ${alone}`)

  // ── 塗りの描画モード ──
  await page.mouse.click(...at(350, 225))
  await select('描画モード').selectOption('normal')
  await select('塗りの描画モード').selectOption('darken')
  top = await byName('Rectangle 2')
  check('塗りの描画モードを選べる', top.blendMode === 'normal' && top.fills[0].blendMode === 'darken', JSON.stringify(top.fills))
  await deselect()
  const darker = await pixel(250, 175)
  check('塗りの描画モード（比較（暗））で下の赤が残る', reddish(darker), `${darker}`)

  // ── 影の広がり ──
  // 白い (100, 320) 〜 (200, 400)。ずれ 0・ぼかし 0 の影は、広がりがあるときだけ左の縁の外に見える
  await page.keyboard.press('r'); await drag([100, 320], [200, 400])
  await page.locator('[aria-label="塗りの色"]').fill('#ffffff')
  await page.locator('label:has-text("影を付ける") input').check()
  await set('縦', 0)
  await set('ぼかし', 0)
  await set('濃さ', 100)
  await deselect()
  const before = await pixel(95, 360)
  await page.mouse.click(...at(150, 360))
  await set('広がり', 10)
  let card = await byName('Rectangle 3')
  check('影の広がりを決められる', card.effects[0].spread === 10, JSON.stringify(card.effects))
  await deselect()
  const spread = await pixel(95, 360), beyond = await pixel(85, 360)
  check('広がりの分だけ影が太る', JSON.stringify(before) === JSON.stringify(background) && spread[0] < 40 && JSON.stringify(beyond) === JSON.stringify(background), `${before} / ${spread} / ${beyond}`)

  // ── レイヤーのぼかし ──
  // 赤い (300, 320) 〜 (400, 400)
  await page.keyboard.press('r'); await drag([300, 320], [400, 400])
  await page.locator('[aria-label="塗りの色"]').fill('#ff0000')
  await page.locator('label:has-text("影を付ける") input').check()
  await typeSelect('影').selectOption('layer-blur')
  await set('ぼかし', 20)
  card = await byName('Rectangle 4')
  check('効果の種類をレイヤーのぼかしにできる（影の項目はなくなる）', card.effects[0].type === 'layer-blur' && card.effects[0].blur === 20 && !('x' in card.effects[0]), JSON.stringify(card.effects))
  await deselect()
  const edge = await pixel(300, 360), outer = await pixel(294, 360), center = await pixel(350, 360)
  check('ぼかすと縁がにじむ（縁は半ば透け、外にもはみ出す）', reddish(center) && edge[3] > 60 && edge[3] < 200 && outer[3] > 0 && JSON.stringify(outer) !== JSON.stringify(background), `${edge} / ${outer} / ${center}`)
  await page.screenshot({ path: path.join(OUT, '45-blend-blur.png') })

  // ── 円形のグラデーションを回す ──
  await page.keyboard.press('r'); await drag([500, 320], [600, 400])
  await typeSelect('塗り').selectOption('radial')
  await set('半径 縦 %', 20)
  await set('回す角度', 30)
  card = await byName('Rectangle 5')
  check('円形のグラデーションを回せる', card.fills[0].type === 'radial' && card.fills[0].angle === 30 && card.fills[0].ry === 0.2, JSON.stringify(card.fills[0]))

  // ── 背景のぼかし ──
  // 赤い (100, 450) 〜 (200, 500) の右の縁に、塗りの透明なガラス（(150, 430) 〜 (250, 520)）を重ねる
  await page.keyboard.press('r'); await drag([100, 450], [200, 500])
  await page.locator('[aria-label="塗りの色"]').fill('#ff0000')
  await page.keyboard.press('r'); await drag([150, 430], [250, 520])
  await set('不透明度 %', 0)
  await deselect()
  const sharp = await pixel(197, 475)
  await page.mouse.click(...at(240, 510))
  await page.locator('label:has-text("影を付ける") input').check()
  await typeSelect('影').selectOption('background-blur')
  await set('ぼかし', 20)
  card = await byName('Rectangle 7')
  check('効果の種類を背景のぼかしにできる', card.effects[0].type === 'background-blur' && card.effects[0].blur === 20, JSON.stringify(card.effects))
  await deselect()
  const frosted = await pixel(197, 475), uncovered = await pixel(120, 475)
  check('背景のぼかしは形の内側で後ろをぼかす', sharp[3] === 255 && frosted[3] < 230 && frosted[3] > 0 && reddish(uncovered), `${sharp} / ${frosted} / ${uncovered}`)

  // ── テキストの影 ──
  await page.keyboard.press('t')
  await drag([400, 450], [560, 490])
  await page.keyboard.type('Shadow')
  await page.keyboard.press('Escape')
  await page.locator('label:has-text("影を付ける") input').check()
  const kinds = await typeSelect('影').locator('option').allTextContents()
  check('テキストの効果はすべての種類を選べる', JSON.stringify(kinds) === JSON.stringify(['落ち影', '内側の影', 'レイヤーのぼかし', '背景のぼかし']), JSON.stringify(kinds))
  await set('縦', 12)
  await set('ぼかし', 0)
  await set('濃さ', 100)
  const label = await byName('Text 1')
  check('テキストに影を付けられる', label.effects.length === 1 && label.effects[0].y === 12, JSON.stringify(label.effects))
  await page.screenshot({ path: path.join(OUT, '46-background-blur-text-shadow.png') })

  // ── 書き出しと viewer ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'paint-rest-4.kdr')
  await download.saveAs(kdrPath)
  const json = await require('./kdr.cjs').parseKdrBytes(fs.readFileSync(kdrPath))
  const raw = JSON.stringify(json.raw)
  check('kdr に描画モード・広がり・ぼかし・回す角度が入り、normal は書かない', raw.includes('"blendMode":"darken"') && raw.includes('"spread":10') && raw.includes('"type":"layer-blur"') && raw.includes('"angle":30') && !raw.includes('"blendMode":"normal"'), raw.slice(0, 300))

  const viewer = await context.newPage()
  viewer.on('pageerror', (e) => errors.push('viewer: ' + String(e)))
  viewer.on('console', (m) => m.type() === 'error' && errors.push('viewer: ' + m.text()))
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  const panel = viewer.locator('.inspect-panel')
  const cssOf = async (name) => {
    await viewer.locator(`.inspect-layer:has(.layer-name:text-is("${name}"))`).click()
    return panel.locator('.inspect-code').first().textContent()
  }
  const blendCss = await cssOf('Rectangle 2')
  check('viewer の CSS に塗りの描画モードが mix-blend-mode で出る', blendCss.includes('mix-blend-mode: darken;'), blendCss)
  const spreadCss = await cssOf('Rectangle 3')
  check('viewer の CSS に影の広がりが出る', spreadCss.includes('box-shadow: 0 0 0 10px rgba(0, 0, 0, 1);'), spreadCss)
  const blurCss = await cssOf('Rectangle 4')
  check('viewer の CSS にレイヤーのぼかしが filter で出る', blurCss.includes('filter: blur(10px);'), blurCss)
  const glassCss = await cssOf('Rectangle 7')
  check('viewer の CSS に背景のぼかしが backdrop-filter で出る', glassCss.includes('backdrop-filter: blur(10px);'), glassCss)
  const textCss = await cssOf('Text 1')
  check('viewer の CSS にテキストの影が text-shadow で出る', textCss.includes('text-shadow: 0 12px 0 rgba(0, 0, 0, 1);'), textCss)
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Rectangle 3"))').click()
  const [svgDownload] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('button:text-is("SVG に")').first().click()])
  const svgText = fs.readFileSync(await svgDownload.path(), 'utf8')
  check('SVG に影の広がり（feMorphology）が入る', svgText.includes('<feMorphology'), svgText.slice(0, 300))

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('CRASHED', e); process.exit(1) })
