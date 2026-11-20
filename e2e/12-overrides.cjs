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
  const field = (label) => page.locator(`.field:has(.field-label:text-is("${label}")) input`).first()
  const set = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Enter') }
  const button = (label) => page.locator(`button:text-is("${label}")`)
  const section = (title) => page.locator(`.properties-panel .section-title:text-is("${title}")`)
  const deselect = () => page.mouse.click(...at(740, 600))
  const saved = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kadrokreo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const request = open.result.transaction('document').objectStore('document').get('current')
      request.onsuccess = () => resolve(request.result.document)
    }
  }))
  // 保存された 1 ページ目から、元・インスタンス・それぞれの文字を取り出す
  const read = async () => {
    await page.waitForTimeout(700)
    const nodes = Object.values((await saved()).pages[0].nodes)
    const textOf = (root) => nodes.find((n) => n.id === root.children[0])
    const main = nodes.find((n) => n.type === 'frame' && n.component && n.component.role === 'main')
    const copies = nodes.filter((n) => n.type === 'frame' && n.component && n.component.role === 'instance')
    return { nodes, main, mainText: textOf(main), copies, copy: copies[0], copyText: copies[0] && textOf(copies[0]) }
  }

  // ── ボタンを作ってコンポーネントにし、インスタンスを離れた場所に置く ──
  await page.keyboard.press('t')
  await page.mouse.click(...at(140, 140))
  await page.keyboard.type('OK')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+A')
  await set('左右', 20); await set('上下', 10)
  await page.locator('[aria-label="塗りを有効にする"]').check()
  await button('コンポーネントにする').click()
  await button('インスタンスを作る').click()
  await set('X', 400); await set('Y', 300)
  await deselect()

  // ── インスタンスの文言だけを変える ──
  await page.mouse.dblclick(...at(425, 318))
  await page.waitForSelector('.text-editor')
  check('インスタンスの文字をダブルクリックすると、編集に入る', (await page.locator('.text-editor').count()) === 1)
  await page.keyboard.type('送信する')
  await page.screenshot({ path: path.join(OUT, '39-override-editing.png') })
  await page.keyboard.press('Escape')
  let s = await read()
  check('インスタンスの文言だけが変わり、元は変わらない', s.copyText.text === '送信する' && s.mainText.text === 'OK', `${s.copyText.text} / ${s.mainText.text}`)
  check('上書きとして、元のノードの id で覚える', JSON.stringify(s.copy.component.overrides) === JSON.stringify({ [s.mainText.id]: { text: '送信する' } }), JSON.stringify(s.copy.component.overrides))
  check('文言に合わせて、インスタンスの大きさが変わる', s.copy.width > s.main.width && s.copy.width === s.copyText.width + 40 && s.copy.x === 400, `${s.copy.width} / ${s.main.width} / ${s.copyText.width}`)
  await page.keyboard.press('Meta+z')
  s = await read()
  check('undo 1 回で文言と大きさが戻る', s.copyText.text === 'OK' && s.copy.width === s.main.width && Object.keys(s.copy.component.overrides).length === 0)
  await page.keyboard.press('Meta+Shift+z')

  // ── 元を変えても、上書きした項目は残る ──
  await deselect()
  await page.mouse.dblclick(...at(170, 150))
  await page.waitForSelector('.text-editor')
  await page.keyboard.type('はい')
  await page.keyboard.press('Escape')
  await page.locator('.layer-row').nth(1).click()
  check('一覧の 2 行目が元', (await button('インスタンスを作る').count()) === 1)
  await page.locator('[aria-label="塗りの色"]').fill('#4f46e5')
  s = await read()
  check('元の文言を変えても、上書きしたインスタンスの文言は残る', s.mainText.text === 'はい' && s.copyText.text === '送信する', `${s.mainText.text} / ${s.copyText.text}`)
  check('上書きしていない項目は、元に合わせて変わる', s.copy.fill === '#4f46e5', s.copy.fill)

  // ── インスタンス自身の塗りを変える ──
  await page.locator('.layer-row').nth(0).click()
  check('インスタンスでも塗りを変えられる', (await section('塗り').count()) === 1 && (await section('角丸').count()) === 0)
  await page.locator('[aria-label="塗りの色"]').fill('#e11d48')
  s = await read()
  check('インスタンスの塗りだけが変わる', s.copy.fill === '#e11d48' && s.main.fill === '#4f46e5' && s.copy.component.overrides[s.main.id].fill === '#e11d48', JSON.stringify(s.copy.component.overrides))

  // ── 一覧で中身を開き、写しを選ぶ ──
  await page.locator('.layer-row').nth(0).locator('.layer-caret').click()
  check('一覧でインスタンスの中身を開ける', (await layers()).join() === 'Frame 1,Text 1,Frame 1,Text 1' && (await page.locator('.layer-row[data-copy="true"]').count()) === 1, (await layers()).join())
  const copyRow = page.locator('.layer-row[data-copy="true"]')
  await copyRow.click()
  check('写しを選ぶと、上書きできる項目だけが出る', (await section('インスタンスの中身').count()) === 1 && (await section('塗り').count()) === 1 && (await section('位置とサイズ').count()) === 0 && (await section('テキスト').count()) === 0)
  await page.locator('[aria-label="塗りの色"]').fill('#ffffff')
  s = await read()
  check('写しの文字の色だけが変わる', s.copyText.fill === '#ffffff' && s.mainText.fill === '#000000', `${s.copyText.fill} / ${s.mainText.fill}`)
  await page.screenshot({ path: path.join(OUT, '40-overrides.png') })

  // 写しは、動かしたり消したり複製したりできない
  const before = s
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Meta+d')
  await page.keyboard.press(']')
  s = await read()
  check('写しは動かせず、消せず、複製できない', s.nodes.length === before.nodes.length && s.copyText.x === before.copyText.x && (await selected()).join() === 'Text 1', `${s.nodes.length} / ${before.nodes.length}`)
  check('写しの行はドラッグできず、名前も変えられない', (await copyRow.getAttribute('draggable')) === 'false' && (await copyRow.locator('[aria-label="ロック"]').count()) === 0)

  // 表示を切り替える
  await copyRow.locator('[aria-label="非表示にする"]').click()
  s = await read()
  check('写しを隠すと、そのインスタンスだけ詰まる', s.copyText.visible === false && s.mainText.visible === true && s.copy.width === 40 && s.main.width > 40, `${s.copy.width} / ${s.main.width}`)
  await copyRow.locator('[aria-label="表示する"]').click()
  s = await read()
  check('表示を元と同じに戻すと、その上書きは消える', s.copyText.visible === true && !('visible' in s.copy.component.overrides[s.mainText.id]), JSON.stringify(s.copy.component.overrides))

  // ── 上書きを戻す ──
  await button('元と同じに戻す').click()
  s = await read()
  check('写しの上書きだけを戻せる', s.copyText.text === 'はい' && s.copyText.fill === '#000000' && s.copy.fill === '#e11d48' && s.copy.width === s.main.width, JSON.stringify(s.copy.component.overrides))
  check('上書きがなくなると、戻すボタンは出ない', (await button('元と同じに戻す').count()) === 0)
  await page.keyboard.press('Meta+z')
  await page.locator('.layer-row').nth(0).click()
  await button('上書きをすべて戻す').click()
  s = await read()
  check('インスタンスの上書きをすべて戻せる', s.copy.fill === '#4f46e5' && s.copyText.text === 'はい' && Object.keys(s.copy.component.overrides).length === 0, JSON.stringify(s.copy.component.overrides))
  await page.keyboard.press('Meta+z')
  s = await read()
  check('undo で上書きが戻る', s.copy.fill === '#e11d48' && s.copyText.text === '送信する' && s.copyText.fill === '#ffffff')

  // ── 複製しても上書きは引き継がれる ──
  await page.keyboard.press('Meta+d')
  s = await read()
  const texts = s.copies.map((copy) => s.nodes.find((n) => n.id === copy.children[0]).text)
  check('インスタンスを複製すると、上書きも引き継がれる', s.copies.length === 2 && texts.join() === '送信する,送信する' && s.copies.every((copy) => copy.fill === '#e11d48'), texts.join())

  // ── 読み込み直しても残る ──
  await page.reload()
  await page.waitForSelector('.canvas-view canvas')
  await page.waitForTimeout(300)
  // 表示位置が変わっているので、一覧から写しを選び、Enter で編集に入る（2 行目が、複製する前からあるインスタンス）
  await page.locator('.layer-row').nth(1).locator('.layer-caret').click()
  await copyRow.click()
  await page.keyboard.press('Enter')
  await page.waitForSelector('.text-editor')
  await page.keyboard.type('予約する')
  await page.keyboard.press('Escape')
  s = await read()
  const reloaded = s.copies.find((copy) => copy.x === 400)
  check('読み込み直した後も、上書きを続けて変えられる', s.nodes.find((n) => n.id === reloaded.children[0]).text === '予約する' && s.mainText.text === 'はい' && reloaded.fill === '#e11d48')

  // ── 書き出しと viewer ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'overrides.kdr')
  await download.saveAs(kdrPath)
  const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(kdrPath)).toString('utf8'))
  const links = Object.values(json.document.pages[0].nodes).filter((n) => n.component)
  const exported = links.filter((n) => n.component.role === 'instance').map((n) => Object.values(n.component.overrides).map((o) => o.text || o.fill).sort().join('+'))
  check('kdr v10 に上書きが入る。元は上書きを持たない', json.version === 10 && exported.sort().join() === '#e11d48+予約する,#e11d48+送信する' && links.filter((n) => n.component.role === 'main').every((n) => !('overrides' in n.component)), exported.join())

  const viewer = await context.newPage()
  viewer.on('pageerror', (e) => errors.push('viewer: ' + String(e)))
  viewer.on('console', (m) => m.type() === 'error' && errors.push('viewer: ' + m.text()))
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(300)
  check('viewer で開ける', (await viewer.locator('.app-message').count()) === 0)
  await viewer.screenshot({ path: path.join(OUT, '41-viewer-overrides.png') })
  await viewer.locator('input[type=file]').setInputFiles(path.join(FIXTURES, 'sample-v9.kdr'))
  await viewer.waitForTimeout(400)
  check('version 9 の kdr も開ける', (await viewer.locator('.app-message').count()) === 0)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('CRASHED', e); process.exit(1) })
