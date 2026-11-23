const { chromium } = require('playwright-core')
const path = require('path')

// editor の細かい改善: レイヤーの Shift 範囲選択、選択枠の内側をつかんで移動、複製を元の直上に置く、
// 右クリックメニュー、選択へズーム、別のページへ移す
const { OUT, EDITOR, check, finish, watchErrors, savedDocument } = require('./harness.cjs')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)

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
  const row = (name) => page.locator(`.layer-row:has(.layer-name:text-is("${name}"))`).first()
  const pageRow = (name) => page.locator(`.page-row:has(.page-name:text-is("${name}"))`)
  const menu = page.locator('.context-menu').first()
  const item = (name) => page.getByRole('menuitem', { name, exact: false }).first()
  const zoom = async () => Number((await page.locator('.zoom-value').textContent()).replace('%', ''))
  const saved = () => savedDocument(page)
  const nodeOf = async (name, pageIndex = 0) =>
    Object.values((await saved()).pages[pageIndex].nodes).find((n) => n.name === name)

  // 素材: フレーム 1 つ、長方形 3 つ（ページ直下）
  await page.keyboard.press('f')
  await drag([50, 80], [350, 380])
  for (const [from, to] of [[[420, 100], [520, 200]], [[560, 100], [660, 200]], [[420, 260], [520, 360]]]) {
    await page.keyboard.press('r')
    await drag(from, to)
  }
  check('4 つ作られる', (await layers()).join() === 'Rectangle 3,Rectangle 2,Rectangle 1,Frame 1', (await layers()).join())

  // ── レイヤーパネルの Shift 範囲選択 ──
  await row('Rectangle 1').click()
  await row('Rectangle 3').click({ modifiers: ['Shift'] })
  check('Shift で起点から押した行までを選ぶ', (await selected()).join() === 'Rectangle 3,Rectangle 2,Rectangle 1', (await selected()).join())
  await row('Rectangle 2').click({ modifiers: ['Meta'] })
  check('Cmd で 1 行ずつ外せる', (await selected()).join() === 'Rectangle 3,Rectangle 1', (await selected()).join())
  await row('Frame 1').click({ modifiers: ['Shift'] })
  check('Shift の起点は最後に押した行', (await selected()).join() === 'Rectangle 2,Rectangle 1,Frame 1', (await selected()).join())

  // ── 選択枠の内側（図形のない所）をつかんで移動 ──
  await drag([400, 60], [700, 240])
  check('範囲選択で 2 つ選ばれる', (await selected()).join() === 'Rectangle 2,Rectangle 1', (await selected()).join())
  await drag([540, 150], [540, 200])
  await page.waitForTimeout(700)
  const r1 = await nodeOf('Rectangle 1')
  const r2 = await nodeOf('Rectangle 2')
  check('選択枠の内側の空いた所をつかむと、選んでいるもの全体が動く', r1.y === 150 && r2.y === 150 && (await selected()).length === 2, `${r1.y} ${r2.y}`)
  await page.mouse.click(...at(540, 200))
  check('選択枠の内側の空いた所をクリックすると、選択が外れる', (await selected()).length === 0, (await selected()).join())

  // ── 複製を元の直上に置く ──
  await row('Rectangle 1').click()
  await page.keyboard.press('Meta+d')
  check('複製は元のすぐ上（重なり順で 1 つ前面）に入る', (await layers()).join() === 'Rectangle 3,Rectangle 2,Rectangle 1,Rectangle 1,Frame 1', (await layers()).join())
  check('複製したものが選ばれる', (await page.locator('.layer-row').nth(2).getAttribute('data-selected')) === 'true')
  await page.keyboard.press('Meta+z')

  // ── 右クリックメニュー ──
  await page.mouse.click(...at(610, 200), { button: 'right' })
  check('右クリックでメニューが出る', await menu.isVisible())
  check('右クリックした図形が選ばれる', (await selected()).join() === 'Rectangle 2', (await selected()).join())
  await page.screenshot({ path: path.join(OUT, '17-context-menu.png') })
  await item('複製').click()
  check('メニューの複製', (await layers()).filter((n) => n === 'Rectangle 2').length === 2 && !(await menu.isVisible()), (await layers()).join())
  await page.keyboard.press('Meta+z')
  await page.mouse.click(...at(610, 200), { button: 'right' })
  await item('最背面へ').click()
  check('メニューの最背面へ', (await layers()).at(-1) === 'Rectangle 2', (await layers()).join())
  await page.mouse.click(...at(610, 200), { button: 'right' })
  await page.keyboard.press('Escape')
  check('Esc でメニューだけを閉じる（選択は残る）', !(await menu.isVisible()) && (await selected()).join() === 'Rectangle 2', (await selected()).join())
  await page.mouse.click(...at(610, 200), { button: 'right' })
  await page.mouse.click(...at(680, 520))
  check('メニューの外を押すと閉じる', !(await menu.isVisible()))
  await page.mouse.click(...at(680, 520), { button: 'right' })
  check('何もない所の右クリックは選択を外し、貼り付けなどを出す', (await selected()).length === 0 && (await item('貼り付け').isVisible()) && !(await item('複製').isVisible()))
  await page.keyboard.press('Escape')
  await row('Frame 1').click()
  await page.mouse.click(...at(200, 200), { button: 'right' })
  await item('コンポーネントにする').click()
  await page.waitForTimeout(700)
  check('メニューからコンポーネントにする', (await nodeOf('Frame 1')).component?.role === 'main')
  await page.keyboard.press('Meta+z')

  // ── 選択へズーム（Shift + 2） ──
  await row('Rectangle 1').click()
  await page.keyboard.press('Shift+2')
  check('Shift + 2 で選んだものが画面いっぱいに映る（100% を超えて拡大）', (await zoom()) > 300, String(await zoom()))
  await page.keyboard.press('Shift+1')
  const fitted = await zoom()
  check('Shift + 1 で全体表示に戻る', fitted <= 100, String(fitted))
  const canvasCenter = [box.width / 2, box.height / 2]

  // ── 別のページへ移す ──
  await page.locator('[aria-label="ページを追加"]').click()
  await pageRow('Page 1').click()
  const moving = await nodeOf('Rectangle 3')
  await row('Rectangle 3').click()
  // レイヤーで選んだものを右クリックするため、選択へズームで中央に映す。縮小しても中央に残るので、メニューからもう一度ズームする
  await page.keyboard.press('Shift+2')
  for (let i = 0; i < 6; i++) await page.keyboard.press('Meta+-')
  await page.mouse.click(...at(...canvasCenter), { button: 'right' })
  await item('選択へズーム').click()
  check('メニューの選択へズーム', (await zoom()) > 300, String(await zoom()))
  await page.mouse.click(...at(...canvasCenter), { button: 'right' })
  check('右クリックしても選択はそのまま', (await selected()).join() === 'Rectangle 3', (await selected()).join())
  await item('別のページへ移す').hover()
  await item('Page 2').click()
  await page.waitForTimeout(700)
  check('移したものは今のページから消える', !(await layers()).includes('Rectangle 3') && (await layers()).length === 3, (await layers()).join())
  const moved = await nodeOf('Rectangle 3', 1)
  check('移した先のページに、同じ id・同じ位置で入る', moved?.id === moving.id && moved.x === moving.x && moved.y === moving.y, JSON.stringify(moved))
  await pageRow('Page 2').click()
  check('移した先のページで見える', (await layers()).join() === 'Rectangle 3', (await layers()).join())
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(700)
  check('Undo 1 回で元のページへ戻る', (await nodeOf('Rectangle 3'))?.id === moving.id && !(await nodeOf('Rectangle 3', 1)))

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch((e) => {
  console.error('CRASHED', e)
  process.exit(1)
})
