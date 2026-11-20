// サンプルのデザインを実際の操作で組み立てて、画面のキャプチャを撮る（確認用のテストではない）。
//   npm run capture   → e2e/out/captures/*.png
const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')

const OUT = path.join(__dirname, 'out', 'captures')
fs.mkdirSync(OUT, { recursive: true })
const EDITOR = process.env.EDITOR_URL || 'http://localhost:5180'
const VIEWER = process.env.VIEWER_URL || 'http://localhost:5181'

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    acceptDownloads: true,
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.log('pageerror', String(e)))
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const box = await page.locator('.canvas-view').boundingBox()
  const at = (x, y) => [box.x + x, box.y + y]
  const drag = async (from, to, { mod = false } = {}) => {
    if (mod) await page.keyboard.down('Meta')
    await page.mouse.move(...at(...from))
    await page.mouse.down()
    await page.mouse.move(...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), { steps: 4 })
    await page.mouse.move(...at(...to), { steps: 4 })
    await page.mouse.up()
    if (mod) await page.keyboard.up('Meta')
  }
  const click = (x, y) => page.mouse.click(...at(x, y))
  const row = (name) => page.locator(`.layer-row:has(.layer-name:text-is("${name}"))`)
  const field = (label) => page.locator(`.field:has(.field-label:text-is("${label}")) input`).first()
  const set = async (label, value) => {
    await field(label).fill(String(value))
    await field(label).press('Enter')
  }
  const fill = (color) => page.locator('[aria-label="塗りの色"]').fill(color)
  const text = async (x, y, content, { size, color, bold } = {}) => {
    await page.keyboard.press('t')
    await click(x, y)
    await page.keyboard.type(content)
    await page.keyboard.press('Escape')
    if (size) await set('サイズ', size)
    if (color) await fill(color)
    if (bold) await page.locator('[aria-label="太字"]').click()
  }
  const rename = async (from, to) => {
    await row(from).locator('.layer-name').dblclick()
    await page.locator('.layer-name-input').fill(to)
    await page.locator('.layer-name-input').press('Enter')
  }
  const shot = async (target, name) => {
    await target.waitForTimeout(300)
    await target.screenshot({ path: path.join(OUT, name) })
    console.log('captured', name)
  }

  await page.locator('.document-name').fill('サンプルデザイン')
  await page.locator('.document-name').press('Enter')

  // ── スマホ画面のフレーム ──
  await page.keyboard.press('f')
  await drag([80, 50], [440, 610])
  await set('半径', 28)
  await page.locator('label:has-text("影を付ける") input').check()
  await set('ぼかし', 40)
  await set('濃さ', 18)
  await rename('Frame 1', 'ホーム画面')

  // ヘッダー（グラデーション）
  await page.keyboard.press('r')
  await drag([80, 50], [440, 220])
  await fill('#4f46e5')
  await page.locator('label:has-text("グラデーション") input').check()
  await page.locator('[aria-label="グラデーションの終わりの色"]').fill('#c026d3')
  await set('角度', 30)
  await rename('Rectangle 1', 'ヘッダー')

  await text(108, 120, 'デザインを共有', { size: 26, color: '#ffffff', bold: true })
  await text(108, 164, 'kdr ファイルを開くだけで見られます', { size: 13, color: '#e0e7ff' })

  // 画像（その場で作る）
  const photo = path.join(OUT, '_photo.png')
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 560
    c.height = 280
    const ctx = c.getContext('2d')
    const sky = ctx.createLinearGradient(0, 0, 0, 280)
    sky.addColorStop(0, '#fde68a')
    sky.addColorStop(1, '#fb7185')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, 560, 280)
    ctx.fillStyle = '#fff7ed'
    ctx.beginPath()
    ctx.arc(420, 90, 46, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#7c3aed'
    ctx.beginPath()
    ctx.moveTo(0, 280)
    ctx.lineTo(160, 120)
    ctx.lineTo(300, 230)
    ctx.lineTo(400, 160)
    ctx.lineTo(560, 280)
    ctx.fill()
    return c.toDataURL('image/png')
  })
  fs.writeFileSync(photo, Buffer.from(dataUrl.split(',')[1], 'base64'))
  await page.locator('input[type=file][accept^="image/"]').setInputFiles(photo)
  await page.waitForFunction(() => [...document.querySelectorAll('.layer-name')].some((e) => e.textContent === '_photo'))
  await set('X', 104)
  await set('Y', 250)
  await set('W', 312)
  await set('H', 140)
  await set('半径', 16)
  // フレームの中へ入れる（少し動かすと、下にあるフレームの子になる）
  await drag([260, 320], [260, 324], { mod: true })
  await rename('_photo', '写真')

  // カード 3 枚 → 自動で並べる
  const cards = [
    ['#fde68a', [104, 420], [192, 490]],
    ['#a7f3d0', [200, 440], [288, 510]],
    ['#bfdbfe', [300, 420], [388, 490]],
  ]
  for (const [color, from, to] of cards) {
    await page.keyboard.press('r')
    await drag(from, to)
    await fill(color)
    await set('半径', 14)
  }
  await row('Rectangle 2').click()
  await row('Rectangle 3').click({ modifiers: ['Shift'] })
  await row('Rectangle 4').click({ modifiers: ['Shift'] })
  await page.keyboard.press('Shift+A')
  await set('間隔', 16)
  await page.locator('.field:has(.field-label:text-is("揃え")) select').selectOption('center')
  await page.locator('[aria-label="左右中央揃え"]').click()
  await rename('Frame 2', 'カード')

  // ボタン（テキストをまとめて余白を付ける）
  await text(210, 560, 'はじめる', { size: 15, color: '#ffffff', bold: true })
  await page.keyboard.press('Shift+A')
  await set('左右', 36)
  await set('上下', 12)
  await page.locator('[aria-label="塗りを有効にする"]').check()
  await fill('#4f46e5')
  await set('半径', 22)
  await page.locator('[aria-label="左右中央揃え"]').click()
  await rename('Frame 3', 'ボタン')

  // ボタンをコンポーネントにして、インスタンスをフレームの外にも置く
  await page.locator('button:text-is("コンポーネントにする")').click()
  await page.locator('button:text-is("インスタンスを作る")').click()
  await set('X', 560)
  await set('Y', 600)
  // このインスタンスだけ、色と文言を変える（文言は、中の文字をダブルクリックして打ち直す）
  await fill('#0f766e')
  await page.mouse.dblclick(...at(626, 622))
  await page.waitForSelector('.text-editor')
  await page.keyboard.type('あとで見る')
  await page.keyboard.press('Escape')

  // ── フレームの外の注釈 ──
  await page.keyboard.press('l')
  await drag([640, 150], [460, 130])
  await page.locator('.field:has(.field-label:text-is("終点")) select').selectOption('arrow')
  await set('太さ', 2)
  await text(652, 150, 'ヘッダーはグラデーション', { size: 14 })

  await page.keyboard.press('p')
  for (const [x, y] of [[700, 330], [760, 300], [820, 340], [800, 410], [720, 400], [700, 330]]) await click(x, y)
  await fill('#fca5a5')
  await page.locator('label:has-text("影を付ける") input').check()

  await page.keyboard.press('o')
  await drag([640, 470], [760, 540])
  await fill('#86efac')
  await set('回転', -20)

  // ── 2 ページ目 ──
  await page.locator('[aria-label="ページを追加"]').click()
  await page.keyboard.press('f')
  await drag([120, 80], [520, 360])
  await text(150, 130, '設定画面（下書き）', { size: 20, bold: true })
  for (const [from, to] of [['Page 1', 'ホーム'], ['Page 2', '設定']]) {
    await page.locator(`.page-row:has(.page-name:text-is("${from}")) .page-name`).dblclick()
    await page.locator('.page-row input').fill(to)
    await page.locator('.page-row input').press('Enter')
  }
  await page.locator('.page-row:has(.page-name:text-is("ホーム"))').click()

  // ── キャプチャ ──
  await row('ヘッダー').click()
  await shot(page, '1-editor-gradient.png')

  // 同じ名前のインスタンスがページ直下にもあるので、フレームの中にある元（一覧では下）を選ぶ
  await row('ボタン').last().click()
  await page.locator('.properties-panel').evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await shot(page, '2-editor-auto-layout.png')

  await row('Ellipse 1').click()
  await page.locator('.properties-panel').evaluate((el) => el.scrollTo(0, 0))
  await shot(page, '3-editor-rotation.png')

  await page.mouse.dblclick(...at(760, 360))
  await shot(page, '4-editor-path-vertices.png')
  await page.keyboard.press('Escape')

  // フレームの外に置いたインスタンス。一覧で中身を開いておく
  await click(600, 620)
  await row('ボタン').first().locator('.layer-caret').click()
  await shot(page, '9-editor-component-instance.png')

  await click(900, 700)
  await page.emulateMedia({ colorScheme: 'dark' })
  await shot(page, '5-editor-dark.png')
  await page.emulateMedia({ colorScheme: 'light' })

  // ── viewer ──
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('button:text-is("kdr に書き出し")').click(),
  ])
  const kdrPath = path.join(OUT, 'sample.kdr')
  await download.saveAs(kdrPath)

  const viewer = await context.newPage()
  await viewer.goto(VIEWER)
  await shot(viewer, '6-viewer-empty.png')
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await shot(viewer, '7-viewer.png')
  await viewer.locator('.list-button:text-is("ホーム画面")').click()
  await shot(viewer, '8-viewer-frame.png')

  // カードの中の長方形を選び、隣の長方形にポインタを重ねて間隔を出す
  await viewer.locator('button:text-is("全体表示")').click()
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Rectangle 2"))').click()
  // 全体表示では、デザイン全体（中心は (450,346)）がキャンバスの中央に等倍で来る。Rectangle 3 の中心は (260,455)
  const canvas = await viewer.locator('.canvas-view').boundingBox()
  await viewer.mouse.move(canvas.x + canvas.width / 2 + 260 - 450, canvas.y + canvas.height / 2 + 455 - 346)
  await shot(viewer, '10-viewer-inspect.png')

  await browser.close()
})().catch((e) => {
  console.error('CRASHED', e)
  process.exit(1)
})
