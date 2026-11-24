const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')

const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors, pointer } = require('./harness.cjs')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const box = await page.locator('.canvas-view').boundingBox()
  const at = pointer(box)
  const drag = async (from, to) => {
    await page.mouse.move(...at(...from)); await page.mouse.down()
    await page.mouse.move(...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), { steps: 4 })
    await page.mouse.move(...at(...to), { steps: 4 })
    await page.mouse.up()
  }
  const layers = () => page.locator('.layer-row .layer-name').allTextContents()
  const pages = () => page.locator('.page-row .page-name').allTextContents()
  const current = () => page.locator('.page-row[data-selected="true"] .page-name').textContent()
  const pageRow = (name) => page.locator(`.page-row:has(.page-name:text-is("${name}"))`)
  const zoom = () => page.locator('.zoom-value').textContent()

  // ── 追加と切り替え ──
  check('最初は 1 ページ', (await pages()).join() === 'Page 1')
  check('最後の 1 ページは消せない', await page.locator('[aria-label="Page 1 を削除"]').isDisabled())
  await page.keyboard.press('f'); await drag([100, 100], [400, 300])
  await page.keyboard.press('r'); await drag([150, 150], [250, 220])

  await page.locator('[aria-label="ページを追加"]').click()
  check('追加したページに切り替わる', (await pages()).join() === 'Page 1,Page 2' && (await current()) === 'Page 2', await current())
  check('新しいページは空', (await layers()).length === 0)
  await page.keyboard.press('o'); await drag([200, 200], [300, 300])
  check('描いたものは表示中のページに入る', (await layers()).join() === 'Ellipse 1', (await layers()).join())

  await pageRow('Page 1').click()
  check('ページを切り替えるとレイヤーも切り替わる', (await layers()).join() === 'Frame 1,Rectangle 1', (await layers()).join())
  check('切り替えると選択は解除される', (await page.locator('.layer-row[data-selected="true"]').count()) === 0)

  // ── ページごとの表示位置 ──
  await page.mouse.move(...at(300, 300))
  await page.keyboard.down('Meta'); await page.mouse.wheel(0, -50); await page.keyboard.up('Meta')
  const zoomed = await zoom()
  await pageRow('Page 2').click()
  check('別のページは別の表示位置', (await zoom()) === '100%', await zoom())
  await pageRow('Page 1').click()
  check('戻ると元の表示位置に戻る', (await zoom()) === zoomed && zoomed !== '100%', `${zoomed} / ${await zoom()}`)

  // ── 名前変更 ──
  await pageRow('Page 1').locator('.page-name').dblclick()
  await page.locator('.page-row input').fill('ホーム')
  await page.locator('.page-row input').press('Enter')
  check('ページ名を変更できる', (await pages()).join() === 'ホーム,Page 2', (await pages()).join())

  // ── 別ページの変更を undo すると、そのページへ移る ──
  await pageRow('Page 2').click()
  await page.keyboard.press('Meta+z')
  check('名前の変更を undo すると、そのページが表示される', (await pages()).join() === 'Page 1,Page 2' && (await current()) === 'Page 1', `${await pages()} / ${await current()}`)
  await page.keyboard.press('Meta+Shift+z')
  await pageRow('Page 2').click()
  await page.mouse.click(...at(250, 250))
  await page.keyboard.press('Backspace')
  check('Page 2 の楕円を削除', (await layers()).length === 0)
  await pageRow('ホーム').click()
  await page.keyboard.press('Meta+z')
  check('別ページの変更を undo すると、そのページが表示される', (await current()) === 'Page 2' && (await layers()).join() === 'Ellipse 1', `${await current()} / ${await layers()}`)

  // ── ページをまたいだコピー ──
  await pageRow('ホーム').click()
  await page.locator('.layer-row:has-text("Rectangle 1")').click()
  await page.keyboard.press('ControlOrMeta+c')
  await pageRow('Page 2').click()
  await page.keyboard.press('ControlOrMeta+v')
  check('別のページへ貼り付けられる', (await layers()).join() === 'Rectangle 1,Ellipse 1', (await layers()).join())

  // ── 複製・並べ替え・削除 ──
  await pageRow('ホーム').hover()
  await page.locator('[aria-label="ホーム を複製"]').click()
  check('複製は元のすぐ後ろに入り、そこへ切り替わる', (await pages()).join() === 'ホーム,ホーム のコピー,Page 2' && (await current()) === 'ホーム のコピー', (await pages()).join())
  check('複製には中身も入る', (await layers()).join() === 'Frame 1,Rectangle 1', (await layers()).join())

  await pageRow('Page 2').dragTo(pageRow('ホーム'), { targetPosition: { x: 40, y: 4 } })
  check('ドラッグで並べ替えられる', (await pages()).join() === 'Page 2,ホーム,ホーム のコピー', (await pages()).join())

  await pageRow('ホーム のコピー').hover()
  await page.locator('[aria-label="ホーム のコピー を削除"]').click()
  check('表示中のページを消すと先頭のページへ移る', (await pages()).join() === 'Page 2,ホーム' && (await current()) === 'Page 2', `${await pages()} / ${await current()}`)
  await page.keyboard.press('Meta+z')
  check('削除を undo すると、戻ったページが表示される', (await pages()).length === 3 && (await current()) === 'ホーム のコピー', `${await pages()} / ${await current()}`)
  await page.keyboard.press('Meta+Shift+z')
  await page.screenshot({ path: path.join(OUT, '19-pages.png') })

  // ── 自動保存 ──
  await page.waitForTimeout(800)
  await page.reload()
  await page.waitForSelector('.page-row')
  check('再読み込みでページも復元される', (await pages()).join() === 'Page 2,ホーム', (await pages()).join())

  // ── 書き出しと viewer ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'pages.kdr')
  await download.saveAs(kdrPath)
  const json = await require('./kdr.cjs').parseKdrBytes(fs.readFileSync(kdrPath))
  check('kdr に全ページが入る', json.version === 16 && json.document.pages.map((p) => p.name).join() === 'Page 2,ホーム', JSON.stringify(json.document.pages.map((p) => p.name)))

  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  check('viewer は開く前は一覧を出さない', (await viewer.locator('.viewer-sidebar').count()) === 0)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.viewer-sidebar')
  const viewerPages = () => viewer.locator('[aria-label="ページ"] .list-button').allTextContents()
  const viewerFrames = () => viewer.locator('[aria-label="フレーム"] .list-button').allTextContents()
  check('viewer にページ一覧が出る', (await viewerPages()).join() === 'Page 2,ホーム', (await viewerPages()).join())
  check('フレームのないページではフレーム一覧を出さない', (await viewerFrames()).length === 0)
  const shot = async () => (await viewer.locator('canvas').screenshot()).toString('base64')
  await viewer.waitForTimeout(200)
  const first = await shot()
  await viewer.locator('.list-button:text-is("ホーム")').click()
  await viewer.waitForTimeout(200)
  check('viewer でページを切り替えられる', (await shot()) !== first && (await viewerFrames()).join() === 'Frame 1', (await viewerFrames()).join())
  // 画面をずらしてから、フレーム名を押すとそのフレームへ戻る
  const home = await shot()
  await viewer.mouse.move(700, 400); await viewer.mouse.down(); await viewer.mouse.move(900, 600, { steps: 5 }); await viewer.mouse.up()
  check('ドラッグで画面が動く', (await shot()) !== home)
  await viewer.locator('.list-button:text-is("Frame 1")').click()
  await viewer.waitForTimeout(200)
  await viewer.screenshot({ path: path.join(OUT, '20-viewer-pages.png') })
  const frameBox = await viewer.evaluate(() => {
    const canvas = document.querySelector('.canvas-view canvas')
    const ctx = canvas.getContext('2d')
    const ratio = canvas.width / canvas.clientWidth
    // 画面中央はフレームの白で塗られているはず
    return [...ctx.getImageData(Math.round((canvas.clientWidth / 2) * ratio), Math.round((canvas.clientHeight / 2) * ratio), 1, 1).data]
  })
  check('フレーム名を押すとそのフレームが中央に来る', frameBox[3] === 255, frameBox.join())
  check('viewer に編集 UI がない', (await viewer.locator('.toolbar, .layers-panel, .properties-panel, .page-row').count()) === 0)

  // フレーム 1 つを PNG として保存できる
  const [framePng] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('[aria-label="Frame 1 を PNG に書き出し"]').click()])
  const framePath = path.join(OUT, 'export-frame.png')
  await framePng.saveAs(framePath)
  const png = fs.readFileSync(framePath)
  check('viewer でフレームを PNG に書き出せる', framePng.suggestedFilename() === 'Frame 1.png' && png.readUInt32BE(16) === 300 && png.readUInt32BE(20) === 200, `${framePng.suggestedFilename()} ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`)
  await viewer.screenshot({ path: path.join(OUT, '32-viewer-export.png') })

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
