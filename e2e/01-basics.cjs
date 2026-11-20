const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')

const OUT = path.join(__dirname, 'out')
require('fs').mkdirSync(OUT, { recursive: true })
const EDITOR = process.env.EDITOR_URL || 'http://localhost:5180'
const VIEWER = process.env.VIEWER_URL || 'http://localhost:5181'

let failures = 0
function check(name, condition, detail = '') {
  if (!condition) failures++
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

  await page.goto(EDITOR)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.waitForSelector('.canvas-view canvas')
  const box = await page.locator('.canvas-view').boundingBox()
  const at = (x, y) => [box.x + x, box.y + y]
  const drag = async (from, to) => {
    await page.mouse.move(...at(...from))
    await page.mouse.down()
    await page.mouse.move(...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), { steps: 4 })
    await page.mouse.move(...at(...to), { steps: 4 })
    await page.mouse.up()
  }
  const layers = () => page.locator('.layer-row .layer-name').allTextContents()
  const field = (label) => page.locator(`.field:has(.field-label:text-is("${label}")) input`).first()

  // フレームを描く
  await page.keyboard.press('f')
  await drag([100, 100], [500, 400])
  check('フレームが作られる', (await layers()).join() === 'Frame 1', (await layers()).join())
  check('作成後は選択ツールに戻る', (await page.locator('[aria-label="選択"]').getAttribute('aria-pressed')) === 'true')
  check('W が 400', (await field('W').inputValue()) === '400', await field('W').inputValue())

  // フレームの中に長方形
  await page.keyboard.press('r')
  await drag([150, 150], [300, 250])
  check('長方形はフレームの子になる', (await layers()).join() === 'Frame 1,Rectangle 1', (await layers()).join())
  check('X は親からの相対座標', (await field('X').inputValue()) === '50', await field('X').inputValue())

  // フレームの外に楕円
  await page.keyboard.press('o')
  await drag([600, 150], [700, 250])
  check('楕円はページ直下で最前面', (await layers())[0] === 'Ellipse 1', (await layers()).join())

  // テキスト
  await page.keyboard.press('t')
  await page.mouse.click(...at(160, 320))
  await page.waitForSelector('.text-editor')
  await page.keyboard.type('Hello 世界')
  await page.screenshot({ path: path.join(OUT, '1-text-editing.png') })
  await page.keyboard.press('Escape')
  check('テキストが確定される', (await layers()).includes('Text 1'), (await layers()).join())
  check('入力欄が消える', (await page.locator('.text-editor').count()) === 0)
  await page.screenshot({ path: path.join(OUT, '2-created.png') })

  // 移動と undo / redo
  await page.mouse.click(...at(650, 200))
  const x0 = await field('X').inputValue()
  await drag([650, 200], [700, 260])
  const x1 = await field('X').inputValue()
  check('ドラッグで移動する', Number(x1) === Number(x0) + 50, `${x0} -> ${x1}`)
  await page.keyboard.press('Meta+z')
  check('undo で戻る', (await field('X').inputValue()) === x0, await field('X').inputValue())
  await page.keyboard.press('Meta+Shift+z')
  check('redo でやり直す', (await field('X').inputValue()) === x1, await field('X').inputValue())

  // リサイズ（右下のハンドル）
  const w0 = Number(await field('W').inputValue())
  await drag([750, 310], [790, 350])
  check('ハンドルでリサイズする', Number(await field('W').inputValue()) === w0 + 40, await field('W').inputValue())

  // フレームの中へドラッグすると子になる
  await drag([700, 280], [400, 200])
  check('フレームへドラッグすると子になる', (await layers()).join() === 'Frame 1,Ellipse 1,Text 1,Rectangle 1', (await layers()).join())

  // プロパティ編集
  await field('X').fill('10')
  await field('X').press('Enter')
  check('X を数値で変更できる', (await field('X').inputValue()) === '10')

  // 範囲選択と削除・復元
  await page.mouse.click(...at(60, 600))
  check('空白クリックで選択解除', (await page.locator('.layer-row[data-selected="true"]').count()) === 0)
  await page.locator('.layer-row:has-text("Rectangle 1")').click()
  await page.keyboard.press('Backspace')
  check('Delete で削除', !(await layers()).includes('Rectangle 1'), (await layers()).join())
  await page.keyboard.press('Meta+z')
  check('undo で復元', (await layers()).includes('Rectangle 1'))

  // 複製
  await page.locator('.layer-row:has-text("Rectangle 1")').click()
  await page.keyboard.press('Meta+d')
  check('複製される', (await layers()).filter((n) => n === 'Rectangle 1').length === 2, (await layers()).join())
  await page.keyboard.press('Meta+z')

  // フレームのラベルをつかんで動かす
  await page.mouse.click(...at(110, 92))
  check('ラベルでフレームを選択', (await page.locator('.layer-row[data-selected="true"] .layer-name').allTextContents()).join() === 'Frame 1')

  // ズームとパン
  await page.mouse.move(...at(300, 300))
  await page.keyboard.down('Meta')
  await page.mouse.wheel(0, -100)
  await page.keyboard.up('Meta')
  const zoomText = await page.locator('.zoom-value').textContent()
  check('ホイールでズーム', zoomText !== '100%', zoomText)
  await page.locator('button:text-is("全体表示")').click()
  await page.screenshot({ path: path.join(OUT, '3-editor-final.png') })

  // 自動保存
  await page.waitForTimeout(800)
  await page.reload()
  await page.waitForSelector('.layer-row')
  check('再読み込みで復元される', (await layers()).length === 4, (await layers()).join())

  // 書き出し
  await page.locator('.document-name').fill('テスト デザイン')
  await page.locator('.document-name').press('Enter')
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'sample.kdr')
  await download.saveAs(kdrPath)
  const bytes = fs.readFileSync(kdrPath)
  check('ファイル名はドキュメント名.kdr', download.suggestedFilename() === 'テスト デザイン.kdr', download.suggestedFilename())
  check('gzip である', bytes[0] === 0x1f && bytes[1] === 0x8b)
  const json = JSON.parse(require('zlib').gunzipSync(bytes).toString('utf8'))
  check('中身は 1 つの JSON', json.format === 'kadrokreo' && json.version === 10 && json.document.pages.length === 1 && Object.keys(json.document.pages[0].nodes).length === 4)

  // viewer で読み込む
  const viewer = await context.newPage()
  viewer.on('pageerror', (e) => errors.push('viewer: ' + String(e)))
  viewer.on('console', (m) => m.type() === 'error' && errors.push('viewer: ' + m.text()))
  await viewer.goto(VIEWER)
  check('viewer に編集 UI がない', (await viewer.locator('.toolbar, .layers-panel, .properties-panel').count()) === 0)
  await viewer.screenshot({ path: path.join(OUT, '4-viewer-empty.png') })
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  check('viewer にドキュメント名が出る', (await viewer.locator('.document-name').textContent()) === 'テスト デザイン')
  await viewer.waitForTimeout(200)
  await viewer.screenshot({ path: path.join(OUT, '5-viewer-loaded.png') })

  // 壊れたファイル
  const bad = path.join(OUT, 'bad.kdr')
  fs.writeFileSync(bad, 'not a kdr')
  await viewer.locator('input[type=file]').setInputFiles(bad)
  await viewer.waitForSelector('.app-message')
  check('壊れたファイルはエラー表示', (await viewer.locator('.app-message').textContent()).includes('gzip'))

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error('CRASHED', e)
  process.exit(1)
})
