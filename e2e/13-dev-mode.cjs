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
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

  // ── editor で確認用のデザインを作る ──
  // フレーム (100,100) 400×300 の中に、長方形 2 つ（(130,140) 60×60 と (250,140) 80×60）とテキスト
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const editorBox = await page.locator('.canvas-view').boundingBox()
  const drag = async (from, to) => {
    await page.mouse.move(editorBox.x + from[0], editorBox.y + from[1])
    await page.mouse.down()
    await page.mouse.move(editorBox.x + (from[0] + to[0]) / 2, editorBox.y + (from[1] + to[1]) / 2, { steps: 4 })
    await page.mouse.move(editorBox.x + to[0], editorBox.y + to[1], { steps: 4 })
    await page.mouse.up()
  }
  const field = (label) => page.locator(`.field:has(.field-label:text-is("${label}")) input`).first()
  const set = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Enter') }
  const editorRow = (name) => page.locator(`.layer-row:has(.layer-name:text-is("${name}"))`)
  await page.keyboard.press('f'); await drag([100, 100], [500, 400])
  await page.keyboard.press('r'); await drag([130, 140], [190, 200])
  await page.locator('[aria-label="塗りの色"]').fill('#4f46e5')
  await set('半径', 8)
  await page.keyboard.press('r'); await drag([250, 140], [330, 200])
  await page.keyboard.press('t')
  await page.mouse.click(editorBox.x + 130, editorBox.y + 300)
  await page.keyboard.type('Hello')
  await page.keyboard.press('Escape')
  // ロックしてあっても、viewer では選べる
  await editorRow('Rectangle 2').hover()
  await editorRow('Rectangle 2').locator('[aria-label="ロック"]').click()
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'dev-mode.kdr')
  await download.saveAs(kdrPath)

  // ── viewer ──
  const viewer = await context.newPage()
  viewer.on('pageerror', (e) => errors.push('viewer: ' + String(e)))
  viewer.on('console', (m) => m.type() === 'error' && errors.push('viewer: ' + m.text()))
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  const panel = viewer.locator('.inspect-panel')
  const title = () => panel.locator('.panel-title').textContent()
  const value = (section, label) => panel.locator(`section[aria-label="${section}"] .inspect-row:has(dt:text-is("${label}")) .inspect-value`)
  const tree = () => viewer.locator('.inspect-layer .layer-name').allTextContents()
  const treeSelected = () => viewer.locator('.inspect-layer[data-selected="true"] .layer-name').allTextContents()
  const clipboard = () => viewer.evaluate(() => navigator.clipboard.readText())
  // 全体表示にすると、フレーム（中心は (300,250)）がキャンバスの中央に等倍で来る
  let box
  const fit = async () => { await viewer.locator('button:text-is("全体表示")').click(); box = await viewer.locator('.canvas-view').boundingBox() }
  const at = (x, y) => [box.x + box.width / 2 + x - 300, box.y + box.height / 2 + y - 250]
  const pixel = (x, y) => viewer.evaluate(async ([x, y]) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const ratio = canvas.width / canvas.clientWidth
    return [...canvas.getContext('2d').getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data]
  }, [x, y])
  const pixelAt = (x, y) => { const [sx, sy] = at(x, y); return pixel(sx - box.x, sy - box.y) }
  const isRed = (p) => p[0] > 200 && p[1] < 120 && p[2] < 100

  // ── 開くと、切り替えなしで使える ──
  await fit()
  check('開くと、インスペクトのパネルとレイヤー一覧が出る', (await title()) === 'インスペクト' && (await tree()).join() === 'Frame 1,Text 1,Rectangle 2,Rectangle 1' && (await viewer.locator('button:text-is("Dev モード")').count()) === 0, (await tree()).join())

  // ── クリックで選ぶ ──
  await viewer.mouse.click(...at(160, 170))
  check('クリックした図形が選ばれ、一覧でも選ばれる', (await title()) === 'Rectangle 1' && (await treeSelected()).join() === 'Rectangle 1' && (await panel.locator('.inspect-type').textContent()) === '長方形', await title())
  const shown = await Promise.all([['位置とサイズ', 'X'], ['位置とサイズ', 'Y'], ['位置とサイズ', '幅'], ['位置とサイズ', '高さ'], ['位置とサイズ', '角丸'], ['塗り', '色']].map(([s, l]) => value(s, l).textContent()))
  check('位置・大きさ・角丸・色が出る', shown.join() === '30,40,60,60,8,#4F46E5', shown.join())
  const css = await panel.locator('.inspect-code').textContent()
  check('CSS が出る', css === ['position: absolute;', 'left: 30px;', 'top: 40px;', 'width: 60px;', 'height: 60px;', 'background: #4f46e5;', 'border-radius: 8px;'].join('\n'), JSON.stringify(css))
  const outline = await pixelAt(160, 140)
  check('選んだ図形に枠が出る', outline[2] > 200 && outline[0] < 100, outline.join())

  // ── 値をコピーする ──
  await value('塗り', '色').click()
  check('値を押すとコピーできる', (await clipboard()) === '#4F46E5' && (await value('塗り', '色').textContent()) === 'コピーしました', await clipboard())
  await panel.locator('button:text-is("CSS をコピー")').click()
  check('CSS をコピーできる', (await clipboard()) === css)

  // ── 間隔を測る ──
  await viewer.mouse.move(...at(290, 170))
  const gap = await pixelAt(200, 170)
  const above = await pixelAt(160, 110)
  check('選んだまま別の図形に重ねると、間隔の線が出る', isRed(gap) && !isRed(above), `${gap.join()} / ${above.join()}`)
  await viewer.screenshot({ path: path.join(OUT, '42-dev-mode-distance.png') })
  // フレームの余白のところに重ねると、フレームの辺までの線が出る（左は 100 → 130）
  await viewer.mouse.move(...at(400, 380))
  const left = await pixelAt(105, 170)
  const top = await pixelAt(160, 110)
  check('親のフレームに重ねると、辺までの余白の線が出る', isRed(left) && isRed(top), `${left.join()} / ${top.join()}`)

  // ── ロック中のもの、テキスト ──
  await viewer.mouse.click(...at(290, 170))
  check('ロックしてある図形も選べる', (await title()) === 'Rectangle 2' && (await value('位置とサイズ', 'X').textContent()) === '150', await title())
  await viewer.mouse.click(...at(140, 300))
  check('テキストは内容と文字の設定が出る', (await title()) === 'Text 1' && (await value('テキスト', '内容').textContent()) === 'Hello' && (await value('テキスト', 'サイズ').textContent()) === '16' && (await panel.locator('.inspect-code').textContent()).includes('font-size: 16px;'))

  // ── ドラッグは画面の移動のまま ──
  const [fromX, fromY] = at(160, 170)
  await viewer.mouse.move(fromX, fromY)
  await viewer.mouse.down()
  await viewer.mouse.move(fromX + 40, fromY + 30, { steps: 4 })
  await viewer.mouse.up()
  const moved = await pixel(fromX - box.x + 40, fromY - box.y + 30)
  check('ドラッグしても選択は変わらず、画面が動く', (await title()) === 'Text 1' && moved[0] === 0x4f && moved[1] === 0x46 && moved[2] === 0xe5, `${await title()} ${moved.join()}`)
  await fit()

  // ── 一覧から選ぶ、書き出す ──
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Frame 1"))').click()
  check('一覧から選べる', (await title()) === 'Frame 1' && (await value('位置とサイズ', '幅').textContent()) === '400' && (await panel.locator('.inspect-code').textContent()).startsWith('position: relative;'))
  const [png] = await Promise.all([viewer.waitForEvent('download'), panel.locator('button:text-is("PNG に書き出し")').click()])
  check('選んだものを PNG に書き出せる', png.suggestedFilename() === 'Frame 1.png', png.suggestedFilename())

  // ── 選択を外す ──
  await viewer.mouse.click(...at(700, 250))
  check('何もない所を押すと、選択が外れる', (await title()) === 'インスペクト' && (await treeSelected()).length === 0)
  await viewer.mouse.click(...at(160, 170))
  await viewer.keyboard.press('Escape')
  check('Esc でも選択が外れる', (await title()) === 'インスペクト')

  // ── http で配信しているとき（Clipboard API が使えない）もコピーできる ──
  await viewer.evaluate(() => navigator.clipboard.writeText('前の内容'))
  await viewer.evaluate(() => Object.defineProperty(window, 'isSecureContext', { value: false }))
  await viewer.mouse.click(...at(160, 170))
  await value('位置とサイズ', '幅').click()
  check('Clipboard API が使えなくてもコピーできる', (await clipboard()) === '60', await clipboard())

  // ── ドキュメントは変わらない。ブラウザにも何も残さない ──
  for (const key of ['Backspace', 'ArrowRight', 'Meta+d', 'Meta+z']) await viewer.keyboard.press(key)
  check('選んでいても、キー操作で何も変わらない', (await title()) === 'Rectangle 1' && (await value('位置とサイズ', 'X').textContent()) === '30' && (await tree()).join() === 'Frame 1,Text 1,Rectangle 2,Rectangle 1')
  check('viewer はブラウザに何も保存しない', (await viewer.evaluate(() => localStorage.length)) === 0)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('CRASHED', e); process.exit(1) })
