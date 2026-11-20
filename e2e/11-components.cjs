const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const zlib = require('zlib')

const OUT = path.join(__dirname, 'out')
const FIXTURES = path.join(__dirname, 'fixtures')
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
  const layers = () => page.locator('.layer-row .layer-name').allTextContents()
  const selected = () => page.locator('.layer-row[data-selected="true"] .layer-name').allTextContents()
  const row = (name) => page.locator(`.layer-row:has(.layer-name:text-is("${name}"))`)
  const field = (label) => page.locator(`.field:has(.field-label:text-is("${label}")) input`).first()
  const set = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Enter') }
  const button = (label) => page.locator(`button:text-is("${label}")`)
  const deselect = () => page.mouse.click(...at(740, 600))
  const saved = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kadrokreo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const request = open.result.transaction('document').objectStore('document').get('current')
      request.onsuccess = () => resolve(request.result.document)
    }
  }))
  const nodesOf = async (pageIndex = 0) => { await page.waitForTimeout(700); return Object.values((await saved()).pages[pageIndex].nodes) }
  const instances = (nodes) => nodes.filter((n) => n.type === 'frame' && n.component && n.component.role === 'instance')
  const textsIn = (nodes, root) => root.children.map((id) => nodes.find((n) => n.id === id)).filter((n) => n.type === 'text').map((n) => n.text)

  // ── ボタンを作って、コンポーネントにする ──
  await page.keyboard.press('t')
  await page.mouse.click(...at(140, 140))
  await page.keyboard.type('OK')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+A')
  await set('左右', 20); await set('上下', 10)
  await page.locator('[aria-label="塗りを有効にする"]').check()
  await button('コンポーネントにする').click()
  let nodes = await nodesOf()
  const main = nodes.find((n) => n.type === 'frame')
  check('フレームをコンポーネントの元にできる', main.component && main.component.role === 'main', JSON.stringify(main.component))

  // ── インスタンスを作る ──
  await button('インスタンスを作る').click()
  nodes = await nodesOf()
  let copies = instances(nodes)
  check('インスタンスができ、選択される', copies.length === 1 && (await selected()).join() === 'Frame 1' && copies[0].x === main.x + 20, JSON.stringify(copies.map((c) => [c.x, c.y])))
  check('インスタンスに元の中身が写る', textsIn(nodes, copies[0]).join() === 'OK' && copies[0].width === main.width)
  check('一覧では、インスタンスの中身は閉じた状態で出る', (await layers()).join() === 'Frame 1,Frame 1,Text 1', (await layers()).join())
  check('インスタンスでは、上書きできない見た目の項目を出さない', (await page.locator('.section-title:text-is("角丸")').count()) === 0 && (await page.locator('.section-title:text-is("影")').count()) === 0 && (await field('W').isDisabled()))

  // インスタンスを離れた場所へ動かす
  await set('X', 400); await set('Y', 300)
  await deselect()

  // ── インスタンスの中身は個別に選べない ──
  await page.mouse.click(...at(425, 318))
  check('インスタンスの文字を押しても、選ばれるのは全体', (await selected()).length === 1 && (await page.locator('.panel-title').last().textContent()) !== 'テキスト', await page.locator('.properties-panel .panel-title').first().textContent())
  await deselect()

  // ── 元を変えると、インスタンスにも反映される ──
  await page.mouse.dblclick(...at(165, 152))
  await page.waitForSelector('.text-editor')
  await page.keyboard.type('保存する')
  await page.screenshot({ path: path.join(OUT, '36-component-editing.png') })
  await page.keyboard.press('Escape')
  nodes = await nodesOf()
  copies = instances(nodes)
  const mainNow = nodes.find((n) => n.type === 'frame' && n.component && n.component.role === 'main')
  check('元の文字を変えると、インスタンスの文字と大きさも変わる', textsIn(nodes, copies[0]).join() === '保存する' && copies[0].width === mainNow.width && mainNow.width > main.width, `${textsIn(nodes, copies[0])} ${copies[0].width}/${mainNow.width}`)
  check('インスタンスの位置は変わらない', copies[0].x === 400 && copies[0].y === 300)
  await page.keyboard.press('Meta+z')
  nodes = await nodesOf()
  check('undo で元もインスタンスも戻る', textsIn(nodes, instances(nodes)[0]).join() === 'OK')
  await page.keyboard.press('Meta+Shift+z')

  // ── 複製・貼り付けでもインスタンスになる ──
  await row('Text 1').click()
  await page.keyboard.press('Escape')
  await page.locator('.layer-row').nth(1).click()
  check('一覧の 2 行目が元', (await button('インスタンスを作る').count()) === 1)
  await page.keyboard.press('Meta+d')
  nodes = await nodesOf()
  check('元を複製するとインスタンスになる', instances(nodes).length === 2 && nodes.filter((n) => n.component && n.component.role === 'main').length === 1, String(instances(nodes).length))

  // 別のページへ貼り付けても、元に追従する
  await page.keyboard.press('Meta+c')
  await page.locator('[aria-label="ページを追加"]').click()
  await page.keyboard.press('Meta+v')
  let second = await nodesOf(1)
  check('別のページへ貼り付けてもインスタンスになる', instances(second).length === 1 && textsIn(second, instances(second)[0]).join() === '保存する', JSON.stringify(instances(second).map((n) => n.name)))
  await button('元を表示').click()
  check('「元を表示」で元のあるページへ移る', (await page.locator('.page-row[data-selected="true"] .page-name').textContent()) === 'Page 1' && (await button('インスタンスを作る').count()) === 1)

  // 元の色を変えると、別のページのインスタンスも変わる
  await page.locator('[aria-label="塗りの色"]').fill('#4f46e5')
  second = await nodesOf(1)
  check('別のページのインスタンスにも反映される', instances(second)[0].fill === '#4f46e5', instances(second)[0].fill)
  await page.screenshot({ path: path.join(OUT, '37-components.png') })

  // ── 切り離す ──
  await deselect()
  await page.mouse.click(...at(425, 318))
  await button('切り離して編集できるようにする').click()
  nodes = await nodesOf()
  check('切り離すと、ただのフレームになり中身が一覧に出る', instances(nodes).length === 1 && (await layers()).filter((n) => n === 'Text 1').length === 2, (await layers()).join())
  await page.keyboard.press('Meta+z')

  // ── 元を消すと、インスタンスはただのフレームになる ──
  await page.locator('.layer-row').nth(2).click()
  const wasMain = (await button('インスタンスを作る').count()) === 1
  await page.keyboard.press('Backspace')
  nodes = await nodesOf()
  second = await nodesOf(1)
  check('元を消すと、インスタンスは中身を残してただのフレームになる', wasMain && instances(nodes).length === 0 && instances(second).length === 0 && nodes.filter((n) => n.type === 'text').length === 2, `main=${wasMain} ${instances(nodes).length} texts=${nodes.filter((n) => n.type === 'text').length}`)
  await page.keyboard.press('Meta+z')
  nodes = await nodesOf()
  check('undo で元とインスタンスに戻る', instances(nodes).length === 2)

  // ── 書き出しと viewer ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'components.kdr')
  await download.saveAs(kdrPath)
  const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(kdrPath)).toString('utf8'))
  const links = json.document.pages.flatMap((p) => Object.values(p.nodes)).filter((n) => n.component).map((n) => n.component.role).sort()
  check('kdr につながりが入る', json.version === 10 && links.join() === 'instance,instance,instance,main', links.join())

  const viewer = await context.newPage()
  viewer.on('pageerror', (e) => errors.push('viewer: ' + String(e)))
  viewer.on('console', (m) => m.type() === 'error' && errors.push('viewer: ' + m.text()))
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(300)
  await viewer.screenshot({ path: path.join(OUT, '38-viewer-components.png') })
  await viewer.locator('input[type=file]').setInputFiles(path.join(FIXTURES, 'sample-v8.kdr'))
  await viewer.waitForTimeout(400)
  check('version 8 の kdr も開ける', (await viewer.locator('.app-message').count()) === 0)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('CRASHED', e); process.exit(1) })
