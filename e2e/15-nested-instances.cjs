const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')

// コンポーネントの一覧からドラッグするときの入る先の表示と、入れ子のインスタンスの差し替え
const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors, savedDocument, pointer, fieldFinder, rowFinder } = require('./harness.cjs')

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
  const field = fieldFinder(page)
  const set = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Enter') }
  const button = (label) => page.locator(`button:text-is("${label}")`)
  const row = rowFinder(page)
  const deselect = () => page.mouse.click(...at(700, 720))
  const saved = () => savedDocument(page)
  const nodesOf = async () => { await page.waitForTimeout(700); return Object.values((await saved()).pages[0].nodes) }
  const mainNamed = (nodes, name) => nodes.find((n) => n.name === name && n.component && n.component.role === 'main')
  /** 画面の (x, y) の周り 3 画素に、色 rgb の画素があるか */
  const hasColor = (x, y, rgb) => page.evaluate(([x, y, rgb]) => {
    const canvas = document.querySelector('.canvas-view canvas')
    const ratio = canvas.width / canvas.clientWidth
    const data = canvas.getContext('2d').getImageData(Math.round(x * ratio), Math.round(y * ratio) - 2, 1, 5).data
    return [0, 4, 8, 12, 16].some((i) => data[i] === rgb[0] && data[i + 1] === rgb[1] && data[i + 2] === rgb[2])
  }, [x, y, rgb])
  const drawFrame = async (x1, y1, x2, y2) => {
    await page.keyboard.press('f')
    await page.mouse.move(...at(x1, y1)); await page.mouse.down()
    await page.mouse.move(...at((x1 + x2) / 2, (y1 + y2) / 2), { steps: 4 }); await page.mouse.move(...at(x2, y2), { steps: 4 }); await page.mouse.up()
  }

  // ── ボタン（Frame 1）をコンポーネントにし、カード（Frame 2）を作る ──
  await page.keyboard.press('t')
  await page.mouse.click(...at(140, 140))
  await page.keyboard.type('OK')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+A')
  await page.locator('[aria-label="塗りを有効にする"]').click()
  await button('コンポーネントにする').click()
  await deselect()
  await drawFrame(500, 100, 800, 300)
  await deselect()

  // ── 一覧からドラッグすると、入る先のフレームを青い枠で示す ──
  const componentRow = page.locator('.component-row').first()
  await componentRow.hover()
  await page.mouse.down()
  await page.mouse.move(...at(600, 220), { steps: 8 })
  await page.mouse.move(...at(620, 230), { steps: 2 })
  await page.waitForTimeout(100)
  const highlighted = await hasColor(700, 100, [0x0d, 0x99, 0xff])
  await page.screenshot({ path: path.join(OUT, '43-component-drop-target.png') })
  await page.mouse.up()
  check('一覧からドラッグしている間、入る先のフレームを青い枠で示す', highlighted)
  await page.waitForTimeout(100)
  check('置き終えると枠は消える', !(await hasColor(700, 100, [0x0d, 0x99, 0xff])))
  let nodes = await nodesOf()
  const card = nodes.find((n) => n.name === 'Frame 2')
  const placed = nodes.find((n) => n.component && n.component.role === 'instance')
  check('示したフレームの中にインスタンスが入る', placed && placed.parentId === card.id, JSON.stringify(placed && placed.parentId))

  // ── カードをコンポーネントにしてインスタンスを作り、アイコン（40 × 40）の元も作る ──
  await row('Frame 2').click()
  await button('コンポーネントにする').click()
  await button('インスタンスを作る').click()
  await set('X', 500); await set('Y', 400)
  await deselect()
  await drawFrame(100, 500, 140, 540)
  await button('コンポーネントにする').click()
  await deselect()
  nodes = await nodesOf()
  // アイコンの名前（自動で付く番号は、インスタンスの分も数えるので決め打ちしない）
  const iconName = nodes.find((n) => n.component && n.component.role === 'main' && n.width === 40).name

  // ── カードのインスタンスの中のボタンを、アイコンに差し替える ──
  await page.mouse.click(...at(790, 590))
  await page.locator('.layer-row[data-selected="true"] .layer-caret').click()
  await page.locator('.layer-row[data-copy="true"]:has(.layer-name:text-is("Frame 1"))').click()
  const nestedSelect = page.locator('[aria-label="入れ子のインスタンスの元"]')
  check('入れ子のインスタンスの写しを選ぶと、元を選べる', (await nestedSelect.count()) === 1 && (await nestedSelect.inputValue()) === mainNamed(nodes, 'Frame 1').component.id)
  const options = await nestedSelect.locator('option').evaluateAll((list) => list.map((o) => `${o.textContent}${o.disabled ? '×' : ''}`))
  check('自分を含むことになる元（カード）は選べない', options.join() === `Frame 1,Frame 2×,${iconName}`, options.join())
  check('差し替える前は印がない', (await page.locator('.properties-panel .field:has([aria-label="入れ子のインスタンスの元"]) .override-mark').count()) === 0)
  await nestedSelect.selectOption({ label: iconName })
  nodes = await nodesOf()
  const icon = mainNamed(nodes, iconName)
  const instance = nodes.find((n) => n.component && n.component.role === 'instance' && n.x === 500 && n.y === 400)
  const nestedKey = Object.keys(instance.component.overrides)[0]
  const swappedCopy = nodes.find((n) => n.parentId === instance.id)
  check('差し替えると、上書きに元の id を覚える', instance.component.overrides[nestedKey].componentId === icon.component.id, JSON.stringify(instance.component.overrides))
  check('写しが新しい元の大きさと中身になる', swappedCopy.width === 40 && swappedCopy.height === 40 && swappedCopy.children.length === 0 && swappedCopy.name === iconName,
    JSON.stringify([swappedCopy.name, swappedCopy.width, swappedCopy.children.length]))
  check('元のカードの中は変わらない', nodes.find((n) => n.id === nestedKey).component.id === mainNamed(nodes, 'Frame 1').component.id)
  check('差し替えた欄に印が付き、項目の一覧にも出る',
    (await page.locator('.properties-panel .field:has([aria-label="入れ子のインスタンスの元"]) .override-mark').count()) === 1 &&
    (await page.locator('.properties-panel .override-keys').textContent()).includes('入れ子のインスタンスの元'))
  await page.screenshot({ path: path.join(OUT, '44-nested-swap.png') })

  // ── 書き出しと viewer ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'nested.kdr')
  await download.saveAs(kdrPath)
  const json = await require('./kdr.cjs').parseKdrBytes(fs.readFileSync(kdrPath))
  const exported = Object.values(json.document.pages[0].nodes).find((n) => n.id === instance.id)
  check('kdr に差し替えが入る', json.version === 17 && exported.component.overrides[nestedKey].componentId === icon.component.id)

  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(300)
  const inspectRows = (section) => viewer.locator(`.inspect-panel section[aria-label="${section}"] .inspect-row`).evaluateAll((rows) => rows.map((r) => `${r.querySelector('dt').textContent}=${r.querySelector('.inspect-value').textContent}`))
  // 差し替えた写しを、URL のハッシュで選ぶ
  await viewer.evaluate(([pageId, id]) => { location.hash = `page=${pageId}&select=${id}` }, [json.document.pages[0].id, swappedCopy.id])
  await viewer.waitForTimeout(200)
  const rows = await inspectRows('コンポーネント')
  check('viewer で、差し替えた入れ子のインスタンスの元が分かる', rows.includes(`差し替えた元=${iconName}`) && rows.includes('上書き=入れ子のインスタンスの元'), rows.join())

  // ── 元と同じに戻す ──
  await page.bringToFront()
  await button('元と同じに戻す').click()
  nodes = await nodesOf()
  const restored = nodes.find((n) => n.id === instance.id)
  check('元と同じに戻すと、ボタンの写しに戻る', Object.keys(restored.component.overrides).length === 0 && nodes.find((n) => n.parentId === instance.id).children.length > 0)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
