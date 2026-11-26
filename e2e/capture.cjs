// サンプルのデザインを実際の操作で組み立てて、画面のキャプチャを撮る（確認用のテストではない）。
//   npm run capture   → e2e/out/captures/*.png
const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const { pointer, fieldFinder, rowFinder } = require('./harness.cjs')

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
  const at = pointer(box)
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
  const row = rowFinder(page)
  const field = fieldFinder(page)
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
  await page.locator('.field:has(.field-label:text-is("塗りの種類")) select').selectOption('linear')
  await page.locator('[aria-label="塗りの2 番目の色"]').fill('#c026d3')
  await page.locator('button:text-is("塗りに色を足す")').click()
  await page.locator('[aria-label="塗りの2 番目の色"]').fill('#7c3aed')
  await set('角度', 30)
  // 上の 2 隅だけ、画面の角丸に合わせる
  await page.locator('label:has-text("角ごとに変える") input').check()
  await set('左上', 28)
  await set('右上', 28)
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
  await set('上', 12); await set('右', 36); await set('下', 12); await set('左', 36)
  await page.locator('[aria-label="塗りを有効にする"]').click()
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
  // グラデーションをキャンバスで動かすハンドルも見せる（撮ったら抜ける）
  await page.locator('.properties-panel button[aria-pressed]:not(.icon-button)').first().click()
  await shot(page, '1-editor-gradient.png')
  await page.keyboard.press('Escape')

  // 同じ名前のインスタンスがページ直下にもあるので、フレームの中にある元（一覧では下）を選ぶ
  await row('ボタン').last().click()
  await page.locator('.properties-panel').evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await shot(page, '2-editor-auto-layout.png')

  await row('Ellipse 1').click()
  await page.locator('.properties-panel').evaluate((el) => el.scrollTo(0, 0))
  await shot(page, '3-editor-rotation.png')

  // 頂点の編集。上の頂点をダブルクリックしてなめらかにし、制御点のハンドルを引き伸ばして曲線にする（撮ったら戻す）
  await page.mouse.dblclick(...at(760, 360))
  await page.mouse.dblclick(...at(760, 300))
  await drag([784, 302], [812, 296])
  await shot(page, '4-editor-path-vertices.png')
  await page.keyboard.press('Meta+z')
  await page.keyboard.press('Meta+z')
  await page.keyboard.press('Escape')

  // ボタンの元に説明文を付け、文言をプロパティにする（インスタンスでは欄で選べる）
  await page.locator('.layer-row[data-copy="false"]:has(.layer-name:text-is("Text 3"))').first().click()
  await page.locator('button:text-is("文言をプロパティに")').click()
  await row('ボタン').last().click()
  await page.locator('.component-properties input').first().fill('ラベル')
  await page.locator('.component-properties input').first().press('Enter')
  await page.locator('[aria-label="コンポーネントの説明"]').fill('画面でいちばん主な操作に使うボタン')
  await page.locator('[aria-label="コンポーネントの説明"]').press('Tab')

  // フレームの外に置いたインスタンス。一覧で中身を開いておく
  await click(600, 620)
  await row('ボタン').first().locator('.layer-caret').click()
  await shot(page, '9-editor-component-instance.png')

  await click(900, 700)
  await page.emulateMedia({ colorScheme: 'dark' })
  await shot(page, '5-editor-dark.png')
  await page.emulateMedia({ colorScheme: 'light' })

  // 右クリックメニュー（ヘッダーの右側を右クリックし、別のページへ移す先を開いておく）
  await page.mouse.click(...at(410, 200), { button: 'right' })
  await page.getByRole('menuitem', { name: '別のページへ移す' }).hover()
  await shot(page, '14-editor-context-menu.png')
  await page.keyboard.press('Escape')

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

  // フレームの外に置いたインスタンス（一覧では上）を選ぶ。元と違えている項目が出る
  await viewer.mouse.move(canvas.x + canvas.width / 2, canvas.y + 4)
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("ボタン"))').first().click()
  await shot(viewer, '11-viewer-instance.png')

  // カードを選び、コードの形式を Vue にする。子孫までまとめた .vue の中身が出る（形式は HTML に戻しておく）
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("カード"))').first().click()
  const codeFormat = viewer.locator('select[aria-label="コードの形式"]')
  await codeFormat.selectOption('vue')
  await viewer.locator('section[aria-label="Vue"]').scrollIntoViewIfNeeded()
  await shot(viewer, '13-viewer-vue.png')
  await codeFormat.selectOption('html')

  // ── editor のバリアント（ほかのキャプチャに写らないよう、最後に 2 ページ目で作る） ──
  await page.bringToFront()
  await page.locator('.page-row:has(.page-name:text-is("設定"))').click()
  await text(640, 140, 'タグ', { size: 14 })
  await page.keyboard.press('Shift+A')
  await set('上', 6); await set('右', 14); await set('下', 6); await set('左', 14)
  await page.locator('[aria-label="塗りを有効にする"]').click()
  await fill('#e0e7ff')
  await set('半径', 14)
  await rename(await page.locator('.layer-row[data-selected="true"] .layer-name').textContent(), 'タグ')
  await page.locator('button:text-is("コンポーネントにする")').click()
  await page.locator('button:text-is("バリアントを追加")').click()
  await set('種類', '選択中')
  await fill('#a5b4fc')
  // 真偽値のプロパティ「無効」を足す（インスタンスではチェック欄になる）
  await row('タグ').click()
  await page.locator('button:text-is("プロパティを追加")').click()
  await page.locator('.variant-property-block > .variant-property input').nth(1).fill('無効')
  await page.locator('.variant-property-block > .variant-property input').nth(1).press('Enter')
  await row('種類=標準, 無効=標準').click()
  await set('無効', 'false')
  await row('種類=選択中, 無効=標準').click()
  await set('無効', 'false')
  await row('種類=標準, 無効=false').click()
  await page.locator('button:text-is("インスタンスを作る")').click()
  // 2 ページ目の座標は、まとまりが (144, -317) あたりに来る。インスタンスはその下へ
  await set('X', 164)
  await set('Y', -220)
  await page.locator('.field:has(.field-label:text-is("種類")) select').selectOption('選択中')
  // 一覧でまとまりを開き、バリアントを選んで置けることを見せる
  await page.locator('.component-row:has(.component-name:text-is("タグ")) .component-toggle').click()
  await shot(page, '12-editor-variants.png')

  // 親の辺への固定。2 ページ目のフレーム（(120, 80)〜(520, 360)）の右下に、少し回した長方形を右・下に固定して選ぶ。
  // キャンバスに、回した図形を囲む矩形から親の右辺・下辺への破線が出る
  await page.locator('.component-row:has(.component-name:text-is("タグ")) .component-toggle').click()
  await page.keyboard.press('r')
  await drag([300, 200], [390, 240])
  await fill('#4f46e5')
  await set('回転', 12)
  await page.locator('.field:has(.field-label:text-is("横")) select').selectOption('end')
  await page.locator('.field:has(.field-label:text-is("縦")) select').selectOption('end')
  await shot(page, '15-editor-constraints.png')

  // editor を 2 つ目のタブで開いたときの知らせ（編集できるタブは 1 つだけ）
  const second = await context.newPage()
  await second.goto(EDITOR)
  await second.waitForSelector('.editor-notice[data-kind="elsewhere"]')
  await shot(second, '16-editor-elsewhere.png')

  await browser.close()
})().catch((e) => {
  console.error('CRASHED', e)
  process.exit(1)
})
