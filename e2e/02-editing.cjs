const { chromium } = require('playwright-core')
const path = require('path')

const { OUT, EDITOR, VIEWER, check, finish, watchErrors } = require('./harness.cjs')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  page.on('dialog', (d) => d.accept())

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
  const selected = () => page.locator('.layer-row[data-selected="true"] .layer-name').allTextContents()
  const row = (name) => page.locator(`.layer-row:has(.layer-name:text-is("${name}"))`)
  const field = (label) => page.locator(`.field:has(.field-label:text-is("${label}")) input`).first()
  const saved = () =>
    page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('kadrokreo')
          open.onerror = () => reject(open.error)
          open.onsuccess = () => {
            const request = open.result.transaction('document').objectStore('document').get('current')
            request.onerror = () => reject(request.error)
            request.onsuccess = () => resolve(((doc) => ({ ...doc, nodes: Object.assign({}, ...doc.pages.map((page) => page.nodes)) }))(request.result.document))
          }
        }),
    )
  const byName = async (name) => Object.values((await saved()).nodes).find((n) => n.name === name)

  // 素材: フレーム 1 つ、長方形 2 つ（ページ直下）
  await page.keyboard.press('f')
  await drag([50, 80], [350, 380])
  await page.keyboard.press('r')
  await drag([420, 100], [520, 200])
  await page.keyboard.press('r')
  await drag([560, 100], [660, 200])
  check('3 つ作られる', (await layers()).join() === 'Rectangle 2,Rectangle 1,Frame 1', (await layers()).join())

  // 範囲選択
  await drag([400, 60], [700, 240])
  check('範囲選択で 2 つ選ばれる', (await selected()).sort().join() === 'Rectangle 1,Rectangle 2', (await selected()).join())
  check('値が揃わない項目は混在', (await field('X').getAttribute('placeholder')) === '混在')
  check('揃っている値は表示', (await field('W').inputValue()) === '100')

  // まとめて移動（矢印キー）
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(700)
  check('矢印キーで移動', (await byName('Rectangle 1')).y === 110 && (await byName('Rectangle 1')).x === 421)

  // Shift クリックで選択から外す
  await page.keyboard.down('Shift')
  await page.mouse.click(...at(610, 160))
  await page.keyboard.up('Shift')
  check('Shift クリックで選択から外れる', (await selected()).join() === 'Rectangle 1', (await selected()).join())

  // 色の変更
  await page.locator('.color-field input[type=color]').first().fill('#ff3366')
  await page.waitForTimeout(700)
  check('塗りの色が変わる', (await byName('Rectangle 1')).fills[0].color === '#ff3366')
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(700)
  check('色の変更は undo 1 回で戻る', (await byName('Rectangle 1')).fills[0].color === '#d9d9d9', JSON.stringify((await byName('Rectangle 1')).fills))
  await page.keyboard.press('Meta+Shift+z')

  // 線を有効にして太さを変える
  await page.locator('[aria-label="線を有効にする"]').click()
  await field('太さ').fill('4')
  await field('太さ').press('Enter')
  await field('半径').fill('12')
  await field('半径').press('Enter')
  await page.waitForTimeout(700)
  const styled = await byName('Rectangle 1')
  check('線・太さ・角丸が反映', styled.strokes[0].color === '#000000' && styled.strokeWidth === 4 && styled.cornerRadius === 12, JSON.stringify(styled))

  // コピー & ペースト
  await page.mouse.click(...at(470, 160))
  await page.keyboard.press('ControlOrMeta+c')
  await page.keyboard.press('ControlOrMeta+v')
  check('ペーストで増える', (await layers()).filter((n) => n === 'Rectangle 1').length === 2, (await layers()).join())
  await page.keyboard.press('Meta+z')

  // レイヤーのドラッグで親を変える
  await row('Rectangle 2').dragTo(row('Frame 1'))
  await page.waitForTimeout(700)
  const frame = await byName('Frame 1')
  check('レイヤーをフレームへドロップすると子になる', (await byName('Rectangle 2')).parentId === frame.id, (await layers()).join())
  check('見た目の位置は変わらない', (await byName('Rectangle 2')).x === 561 - 50, String((await byName('Rectangle 2')).x))

  // 重なり順
  await row('Frame 1').click()
  await page.keyboard.press(']')
  check('] で最前面へ', (await layers())[0] === 'Frame 1', (await layers()).join())
  await page.keyboard.press('[')
  check('[ で最背面へ', (await layers()).at(-2) === 'Frame 1' || (await layers()).at(-1) === 'Rectangle 2', (await layers()).join())

  // 名前変更
  await row('Rectangle 1').locator('.layer-name').dblclick()
  await page.locator('.layer-name-input').fill('ボタン')
  await page.locator('.layer-name-input').press('Enter')
  check('レイヤー名を変更できる', (await layers()).includes('ボタン'), (await layers()).join())

  // 非表示・ロック
  await row('ボタン').hover()
  await row('ボタン').locator('[aria-label="ロック"]').click()
  await page.mouse.click(...at(60, 600))
  await page.mouse.click(...at(470, 160))
  check('ロック中はキャンバスで選択できない', (await selected()).length === 0, (await selected()).join())
  await row('ボタン').locator('[aria-label="ロックを解除"]').click()
  await row('ボタン').hover()
  await row('ボタン').locator('[aria-label="非表示にする"]').click()
  await page.mouse.click(...at(60, 600))
  await page.mouse.click(...at(470, 160))
  check('非表示のものはキャンバスで選択できない', (await selected()).length === 0, (await selected()).join())
  await row('ボタン').locator('[aria-label="表示する"]').click()

  // テキスト: 作成 → 再編集 → サイズ変更
  await page.keyboard.press('t')
  await page.mouse.click(...at(100, 150))
  await page.keyboard.type('見出し')
  await page.keyboard.press('Enter')
  await page.keyboard.type('2 行目')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(700)
  const text1 = await byName('Text 1')
  check('複数行テキスト', text1.text === '見出し\n2 行目' && text1.parentId === frame.id, JSON.stringify(text1.text))
  await page.mouse.dblclick(...at(110, 155))
  await page.waitForSelector('.text-editor')
  await page.keyboard.type('置き換え')
  await page.mouse.click(...at(60, 600))
  await page.waitForTimeout(700)
  check('ダブルクリックで再編集', (await byName('Text 1')).text === '置き換え', (await byName('Text 1')).text)
  await row('Text 1').click()
  const before = await byName('Text 1')
  await field('サイズ').fill('32')
  await field('サイズ').press('Enter')
  await page.waitForTimeout(700)
  const after = await byName('Text 1')
  check('文字サイズを変えると大きさも追従', after.fontSize === 32 && after.width > before.width * 1.8 && after.height > before.height * 1.8, `${before.width}x${before.height} -> ${after.width}x${after.height}`)

  // 空のテキストは残らない
  const count = (await layers()).length
  await page.keyboard.press('t')
  await page.mouse.click(...at(500, 500))
  await page.keyboard.press('Escape')
  check('空のテキストは作られない', (await layers()).length === count, (await layers()).join())
  await page.keyboard.press('Meta+z')
  await page.keyboard.press('Meta+Shift+z')
  check('空テキストの取り消しは履歴に残らない', (await layers()).length === count)

  // Space + ドラッグでパン（ノードは動かない）
  await page.waitForTimeout(700)
  const docBefore = JSON.stringify(await saved())
  await page.keyboard.down('Space')
  await drag([200, 200], [260, 240])
  await page.keyboard.up('Space')
  await page.waitForTimeout(700)
  check('Space ドラッグではノードが動かない', JSON.stringify(await saved()) === docBefore)
  await page.screenshot({ path: path.join(OUT, '6-more.png') })

  // editor で kdr を開く
  await page.locator('input[type=file][accept^=".kdr"]').setInputFiles(path.join(OUT, 'sample.kdr'))
  await page.waitForFunction(() => document.querySelector('.document-name').value === 'テスト デザイン')
  check('editor でも kdr を開ける', (await layers()).length === 4, (await layers()).join())
  check('開いた直後は undo できない', await page.locator('[aria-label="元に戻す"]').isDisabled())

  // viewer: ドラッグしても中身は変わらない
  const viewer = await context.newPage()
  viewer.on('pageerror', (e) => errors.push('viewer: ' + String(e)))
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(path.join(OUT, 'sample.kdr'))
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(200)
  // ポインタを重ねた図形には枠が出るので、キャンバスの外へ出してから撮る
  const shot = async () => { await viewer.mouse.move(600, 10); return (await viewer.locator('canvas').screenshot()).toString('base64') }
  const a = await shot()
  await viewer.mouse.move(600, 400)
  await viewer.mouse.down()
  await viewer.mouse.move(700, 450, { steps: 5 })
  await viewer.mouse.up()
  const b = await shot()
  await viewer.mouse.move(600, 400)
  await viewer.mouse.down()
  await viewer.mouse.move(500, 350, { steps: 5 })
  await viewer.mouse.up()
  const c = await shot()
  check('viewer はドラッグで画面が動く', a !== b)
  check('viewer で戻すと元の絵に戻る（中身は不変）', a === c)
  for (const key of ['Backspace', 'r', 'Meta+a', 'Meta+z', 'Meta+d']) await viewer.keyboard.press(key)
  check('viewer はキー操作で何も変わらない', (await shot()) === c)
  check('viewer は localStorage に書かない', (await viewer.evaluate(() => localStorage.length)) === 0 || (await viewer.evaluate(() => Object.keys(localStorage).join())) === 'kadrokreo:document')

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch((e) => {
  console.error('CRASHED', e)
  process.exit(1)
})
