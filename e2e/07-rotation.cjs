const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')

const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors, savedDocument, pointer, fieldFinder } = require('./harness.cjs')

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
  const selected = () => page.locator('.layer-row[data-selected="true"] .layer-name').allTextContents()
  const field = fieldFinder(page)
  const num = async (label) => Number(await field(label).inputValue())
  const set = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Enter') }
  const deselect = () => page.mouse.click(...at(740, 560))
  const saved = async () => (await savedDocument(page)).pages[0]
  const byName = async (name) => { await page.waitForTimeout(700); return Object.values((await saved()).nodes).find((n) => n.name === name) }
  // ページ上での四隅（回す前の左上・右上・右下・左下）。ページ直下のノード用
  const corners = (n) => {
    const r = (n.rotation * Math.PI) / 180, cx = n.x + n.width / 2, cy = n.y + n.height / 2
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const dx = (sx * n.width) / 2, dy = (sy * n.height) / 2
      return [cx + dx * Math.cos(r) - dy * Math.sin(r), cy + dx * Math.sin(r) + dy * Math.cos(r)]
    })
  }
  const near = (a, b, tolerance = 1.5) => Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance

  // ── ハンドルで回す ──
  await page.keyboard.press('r'); await drag([200, 200], [400, 300])
  // 回転ハンドルは上辺の中央の少し上。Shift で 15° 刻み
  await page.keyboard.down('Shift')
  await drag([300, 178], [375, 255])
  await page.keyboard.up('Shift')
  check('回転ハンドルで回せる（Shift で 15° 刻み）', (await num('回転')) === 90, String(await num('回転')))
  check('回しても幅と高さは変わらない', (await num('W')) === 200 && (await num('H')) === 100)
  await page.screenshot({ path: path.join(OUT, '21-rotated.png') })

  // ── 当たり判定 ──
  await deselect()
  await page.mouse.click(...at(300, 160))
  check('回した後の形の上をクリックして選択', (await selected()).join() === 'Rectangle 1', (await selected()).join())
  await deselect()
  await page.mouse.click(...at(215, 250))
  check('回す前に枠があった場所では選択されない', (await selected()).length === 0, (await selected()).join())

  // ── 回したままリサイズ ──
  await page.mouse.click(...at(300, 250))
  let rect = await byName('Rectangle 1')
  const fixed = corners(rect)[0]
  // 回す前の右下の角は、いまは左下（250, 350）にある。ページ上で左へ 20、下へ 40 引く
  await page.keyboard.down('Meta')
  await drag([250, 350], [230, 390])
  await page.keyboard.up('Meta')
  rect = await byName('Rectangle 1')
  check('回した向きに沿ってリサイズ', rect.width === 240 && rect.height === 120 && rect.rotation === 90, `${rect.width}x${rect.height} r=${rect.rotation}`)
  check('反対側の角は動かない', near(corners(rect)[0], fixed), `${corners(rect)[0]} / ${fixed}`)

  // ── 移動と undo ──
  const before = await byName('Rectangle 1')
  await page.keyboard.down('Meta')
  await drag([300, 250], [360, 280])
  await page.keyboard.up('Meta')
  let moved = await byName('Rectangle 1')
  check('回したまま移動できる', moved.x === before.x + 60 && moved.y === before.y + 30 && moved.rotation === 90, `${moved.x},${moved.y}`)
  await page.keyboard.press('Meta+z')
  await page.keyboard.press('Meta+z')
  await page.keyboard.press('Meta+z')
  rect = await byName('Rectangle 1')
  check('undo で回転も戻る', rect.rotation === 0 && rect.width === 200 && rect.height === 100, JSON.stringify([rect.rotation, rect.width, rect.height]))

  // ── 数値で回す ──
  await set('回転', 30)
  rect = await byName('Rectangle 1')
  check('角度を数値で指定できる', rect.rotation === 30 && rect.x === 200 && rect.y === 200, JSON.stringify([rect.rotation, rect.x, rect.y]))
  await set('回転', 400)
  check('角度は -180〜180 に収める', (await num('回転')) === 40, String(await num('回転')))
  await set('回転', 30)

  // ── 回したフレームの中に描く・入れる・出す ──
  await page.keyboard.press('f'); await drag([460, 120], [700, 320])
  await set('回転', 20)
  await page.keyboard.press('o'); await drag([540, 180], [620, 240])
  check('回したフレームの中に描くと子になる', (await layers()).join() === 'Frame 1,Ellipse 1,Rectangle 1', (await layers()).join())
  const ellipse = await byName('Ellipse 1')
  check('子はフレームと一緒に回る（自分の角度は 0）', ellipse.rotation === 0, String(ellipse.rotation))
  // 子をフレームの外へ出すと、見た目の向きを保つために 20° が付く
  await page.keyboard.down('Meta')
  await drag([580, 210], [580, 520])
  await page.keyboard.up('Meta')
  const out = await byName('Ellipse 1')
  check('外へ出しても見た目の向きは変わらない', out.parentId === null && out.rotation === 20, JSON.stringify([out.parentId, out.rotation]))
  await page.keyboard.press('Meta+z')

  // ── まとめて回す ──
  await page.keyboard.press('Meta+a')
  await page.waitForTimeout(700)
  const roots = Object.values((await saved()).nodes).filter((n) => n.parentId === null)
  const points = roots.flatMap(corners)
  const left = Math.min(...points.map((p) => p[0])), right = Math.max(...points.map((p) => p[0]))
  const top = Math.min(...points.map((p) => p[1])), bottom = Math.max(...points.map((p) => p[1]))
  const pivot = [(left + right) / 2, (top + bottom) / 2]
  // 囲む矩形の上辺中央の少し上にある回転ハンドルを、中心の右へ回す（90°）
  await page.keyboard.down('Shift')
  await drag([pivot[0], top - 22], [pivot[0] + 150, pivot[1] + 4])
  await page.keyboard.up('Shift')
  const frameAfter = await byName('Frame 1')
  const rectAfter = await byName('Rectangle 1')
  check('複数選択をまとめて回せる', frameAfter.rotation === 110 && rectAfter.rotation === 120, `${frameAfter.rotation}, ${rectAfter.rotation}`)
  const rectBefore = roots.find((n) => n.name === 'Rectangle 1')
  const center = (n) => [n.x + n.width / 2, n.y + n.height / 2]
  const [bx, by] = center(rectBefore)
  // 中心は、選択範囲の中心を軸に 90° 回った位置へ移る
  check('それぞれの中心は、選択範囲の中心を軸に回る', near(center(rectAfter), [pivot[0] - (by - pivot[1]), pivot[1] + (bx - pivot[0])], 2), `${center(rectAfter)}`)
  await page.keyboard.press('Meta+z')
  check('undo で元の角度に戻る', (await byName('Frame 1')).rotation === 20 && (await byName('Rectangle 1')).rotation === 30)

  // ── 回したテキストの編集 ──
  await deselect()
  await page.keyboard.press('t')
  await page.mouse.click(...at(200, 480))
  await page.keyboard.type('Rotated text')
  await page.keyboard.press('Escape')
  await set('回転', -25)
  await page.keyboard.press('Enter')
  await page.waitForSelector('.text-editor')
  const transform = await page.locator('.text-editor').evaluate((el) => el.style.transform)
  check('回したテキストの入力欄も同じ向きに回る', transform === 'rotate(-25deg)', transform)
  await page.screenshot({ path: path.join(OUT, '22-rotated-text-editing.png') })
  await page.keyboard.press('Escape')
  // テキストを左右に反転すると、字そのものが裏返り（flipX）、向きの符号が変わる
  await page.keyboard.press('Shift+H')
  const flipLeftRight = page.locator('.check-field:has-text("左右") input')
  await flipLeftRight.waitFor()
  await page.waitForTimeout(700)
  const flippedText = Object.values((await saved()).nodes).find((n) => n.type === 'text')
  check('テキストを反転すると字が裏返り、パネルの「左右」に印が付く',
    (await flipLeftRight.isChecked()) && flippedText?.flipX === true && flippedText.rotation === 25, JSON.stringify(flippedText && { flipX: flippedText.flipX, rotation: flippedText.rotation }))
  await page.screenshot({ path: path.join(OUT, '22b-flipped-text.png') })
  await deselect()
  await page.screenshot({ path: path.join(OUT, '23-rotation-done.png') })

  // ── 書き出しと viewer ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'rotation.kdr')
  await download.saveAs(kdrPath)
  const json = await require('./kdr.cjs').parseKdrBytes(fs.readFileSync(kdrPath))
  const rotations = Object.values(json.document.pages[0].nodes).map((n) => n.rotation).sort((a, b) => a - b)
  check('kdr に角度が入る', json.version === 17 && rotations.join() === '0,20,25,30', rotations.join())
  check('kdr にテキストの裏返しが入る', JSON.stringify(json.raw).includes('"flipX":true') && !JSON.stringify(json.raw).includes('"flipY"'))

  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(300)
  await viewer.screenshot({ path: path.join(OUT, '24-viewer-rotation.png') })

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
