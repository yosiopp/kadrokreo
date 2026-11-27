const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')

const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors, savedDocument, pointer, fieldFinder } = require('./harness.cjs')
const FIXTURES = path.join(__dirname, 'fixtures')
/** いちばん下の塗りの色（e2e で作る図形は単色 1 つ） */
const fillOf = (node) => node.fills[0] && node.fills[0].color

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
  const layers = () => page.locator('.layer-row .layer-name').allTextContents()
  const selected = () => page.locator('.layer-row[data-selected="true"] .layer-name').allTextContents()
  const field = fieldFinder(page)
  const set = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Enter') }
  const button = (label) => page.locator(`button:text-is("${label}")`)
  const section = (title) => page.locator(`.properties-panel .section-title:text-is("${title}")`)
  const deselect = () => page.mouse.click(...at(740, 600))
  const saved = () => savedDocument(page)
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
  await set('上', 10); await set('右', 20); await set('下', 10); await set('左', 20)
  await page.locator('[aria-label="塗りを有効にする"]').click()
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
  check('上書きしていない項目は、元に合わせて変わる', fillOf(s.copy) === '#4f46e5', fillOf(s.copy))

  // ── インスタンス自身の塗りを変える ──
  await page.locator('.layer-row').nth(0).click()
  check('インスタンスでも塗りを変えられる', (await section('塗り').count()) === 1 && (await section('角丸').count()) === 0)
  await page.locator('[aria-label="塗りの色"]').fill('#e11d48')
  s = await read()
  check('インスタンスの塗りだけが変わる', fillOf(s.copy) === '#e11d48' && fillOf(s.main) === '#4f46e5' && s.copy.component.overrides[s.main.id].fills[0].color === '#e11d48', JSON.stringify(s.copy.component.overrides))

  // ── 一覧で中身を開き、写しを選ぶ ──
  await page.locator('.layer-row').nth(0).locator('.layer-caret').click()
  check('一覧でインスタンスの中身を開ける', (await layers()).join() === 'Frame 1,Text 1,Frame 1,Text 1' && (await page.locator('.layer-row[data-copy="true"]').count()) === 1, (await layers()).join())
  const copyRow = page.locator('.layer-row[data-copy="true"]')
  await copyRow.click()
  check('写しを選ぶと、上書きできる項目だけが出る（テキストは大きさ・太さ・書体だけ）', (await section('インスタンスの中身').count()) === 1 && (await section('塗り').count()) === 1 && (await section('位置とサイズ').count()) === 0 &&
    (await field('サイズ').count()) === 1 && (await field('行の高さ').count()) === 0 && (await page.locator('.properties-panel .field-label:text-is("折り返し")').count()) === 0)
  await page.locator('[aria-label="塗りの色"]').fill('#ffffff')
  s = await read()
  check('写しの文字の色だけが変わる', fillOf(s.copyText) === '#ffffff' && fillOf(s.mainText) === '#000000', `${fillOf(s.copyText)} / ${fillOf(s.mainText)}`)
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
  check('写しの上書きだけを戻せる', s.copyText.text === 'はい' && fillOf(s.copyText) === '#000000' && fillOf(s.copy) === '#e11d48' && s.copy.width === s.main.width, JSON.stringify(s.copy.component.overrides))
  check('上書きがなくなると、戻すボタンは出ない', (await button('元と同じに戻す').count()) === 0)
  await page.keyboard.press('Meta+z')
  await page.locator('.layer-row').nth(0).click()
  await button('上書きをすべて戻す').click()
  s = await read()
  check('インスタンスの上書きをすべて戻せる', fillOf(s.copy) === '#4f46e5' && s.copyText.text === 'はい' && Object.keys(s.copy.component.overrides).length === 0, JSON.stringify(s.copy.component.overrides))
  await page.keyboard.press('Meta+z')
  s = await read()
  check('undo で上書きが戻る', fillOf(s.copy) === '#e11d48' && s.copyText.text === '送信する' && fillOf(s.copyText) === '#ffffff')

  // ── 複製しても上書きは引き継がれる ──
  await page.keyboard.press('Meta+d')
  s = await read()
  const texts = s.copies.map((copy) => s.nodes.find((n) => n.id === copy.children[0]).text)
  check('インスタンスを複製すると、上書きも引き継がれる', s.copies.length === 2 && texts.join() === '送信する,送信する' && s.copies.every((copy) => fillOf(copy) === '#e11d48'), texts.join())

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
  check('読み込み直した後も、上書きを続けて変えられる', s.nodes.find((n) => n.id === reloaded.children[0]).text === '予約する' && s.mainText.text === 'はい' && fillOf(reloaded) === '#e11d48')

  // ── 書き出しと viewer ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'overrides.kdr')
  await download.saveAs(kdrPath)
  const json = await require('./kdr.cjs').parseKdrBytes(fs.readFileSync(kdrPath))
  const links = Object.values(json.document.pages[0].nodes).filter((n) => n.component)
  const exported = links.filter((n) => n.component.role === 'instance').map((n) => Object.values(n.component.overrides).map((o) => o.text || (o.fills && o.fills[0].color)).sort().join('+'))
  check('kdr v17 に上書きが入る。元は上書きを持たない', json.version === 17 && exported.sort().join() === '#e11d48+予約する,#e11d48+送信する' && links.filter((n) => n.component.role === 'main').every((n) => !('overrides' in n.component)), exported.join())

  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(300)
  check('viewer で開ける', (await viewer.locator('.app-message').count()) === 0)
  // インスタンスを選ぶと、元と違えている項目が出る（一覧の 2 行目が、文言を「予約する」にしたインスタンス）
  const inspectRows = (section) => viewer.locator(`.inspect-panel section[aria-label="${section}"] .inspect-row`).evaluateAll((rows) => rows.map((r) => `${r.querySelector('dt').textContent}=${r.querySelector('.inspect-value').textContent}`))
  await viewer.locator('.inspect-layer').nth(1).click()
  check('viewer で、インスタンスの上書きが分かる', (await inspectRows('上書き')).sort().join() === 'Frame 1=塗り,Text 1=文言・塗り' && (await inspectRows('コンポーネント')).join() === '種類=インスタンス,元の名前=Frame 1', `${await inspectRows('上書き')} / ${await inspectRows('コンポーネント')}`)
  await viewer.keyboard.press('Enter')
  check('viewer で、インスタンスの中身は、そのノードの上書きが分かる', (await viewer.locator('.inspect-panel .panel-title').textContent()) === 'Text 1' && (await inspectRows('コンポーネント')).join() === '種類=インスタンスの中身,インスタンス=Frame 1,元の名前=Frame 1,上書き=文言・塗り' && (await inspectRows('テキスト'))[0] === '内容=予約する', (await inspectRows('コンポーネント')).join())
  await viewer.screenshot({ path: path.join(OUT, '41-viewer-overrides.png') })
  await viewer.locator('.inspect-panel button:text-is("元のコンポーネントへ移動")').click()
  check('viewer で、インスタンスの中身から元へ移れる', (await viewer.locator('.inspect-panel .panel-title').textContent()) === 'Frame 1' && (await inspectRows('コンポーネント')).join() === '種類=元' && (await viewer.locator('.inspect-panel button:text-is("元のコンポーネントへ移動")').count()) === 0, (await inspectRows('コンポーネント')).join())
  // 14 以前の kdr は読まない（v15 で形を組み直したとき、後方互換を捨てた）。開くとエラーを出し、いまの表示は残す
  await viewer.locator('input[type=file]').setInputFiles(path.join(FIXTURES, 'sample-v13.kdr'))
  await viewer.waitForSelector('.app-message')
  check('古い version の kdr は開けず、理由を出す', (await viewer.locator('.app-message').innerText()).includes('古いバージョン'), await viewer.locator('.app-message').innerText())
  await viewer.locator('.app-message button').click()

  // ── 文字の書式の上書きと、元に反映 ──
  // 読み込み直した後に「予約する」にした写しを、まだ選んでいる
  await page.bringToFront()
  const overrideNote = () => page.locator('.properties-panel .override-keys').textContent()
  check('元と違えている項目が出る', (await overrideNote()) === '元と違えている項目: 文言・塗り', await overrideNote())
  await set('サイズ', 24)
  s = await read()
  let booked = s.copies.find((copy) => copy.x === 400)
  let bookedText = s.nodes.find((n) => n.id === booked.children[0])
  check('写しの文字の大きさを上書きできる', bookedText.fontSize === 24 && booked.component.overrides[s.mainText.id].fontSize === 24 && s.mainText.fontSize !== 24 && booked.width > s.main.width,
    `${bookedText.fontSize} ${booked.width}/${s.main.width}`)
  const marked = (selector) => page.locator(`.properties-panel ${selector} .override-mark`).count()
  check('上書きしている欄にだけ印が付く',
    (await marked('.field:has(.field-label:text-is("サイズ"))')) === 1 && (await marked('.field:has(.field-label:text-is("書体"))')) === 0 &&
    (await marked('.section-title:text-is("塗り")')) === 1 && (await page.locator('.properties-panel .override-mark').count()) === 3,
    String(await page.locator('.properties-panel .override-mark').count()))
  check('項目の一覧も変わる', (await overrideNote()) === '元と違えている項目: 文言・塗り・文字の大きさ', await overrideNote())
  await button('元に反映').click()
  s = await read()
  booked = s.copies.find((copy) => copy.x === 400)
  const other = s.copies.find((copy) => copy !== booked)
  const otherText = s.nodes.find((n) => n.id === other.children[0])
  check('元に反映すると、元が同じ文言と大きさになり、上書きが外れる',
    s.mainText.text === '予約する' && s.mainText.fontSize === 24 && s.main.width === booked.width && Object.keys(booked.component.overrides).length === 1,
    `${s.mainText.text} ${s.mainText.fontSize} ${JSON.stringify(booked.component.overrides)}`)
  check('ほかのインスタンスは、自分の上書き（文言）を保ったまま大きさが変わる', otherText.text === '送信する' && otherText.fontSize === 24, `${otherText.text} ${otherText.fontSize}`)
  await page.screenshot({ path: path.join(OUT, '42-push-overrides.png') })
  await page.keyboard.press('Meta+z')
  s = await read()
  check('undo で元に戻る', s.mainText.text === 'はい' && s.mainText.fontSize !== 24)

  // ── 複製したインスタンスを左右に反転すると、中身の配置も鏡に映る（上書きにはならない） ──
  await page.keyboard.press('Escape')
  await page.locator('.layer-row').nth(0).click()
  // 元に反映した後なので、写しの文字は元と同じ大きさ（上書きは文言と塗りだけ）
  await page.keyboard.press('Shift+H')
  s = await read()
  const mirrored = s.copies.find((copy) => copy.x !== 400)
  const mirroredText = s.nodes.find((n) => n.id === mirrored.children[0])
  check('インスタンスを反転すると、中の文字も裏返って右寄りへ移り、上書きは増えない',
    mirrored.component.flipX === true && mirroredText.flipX === true && mirroredText.x === mirrored.width - mirroredText.width - 20 &&
      Object.values(mirrored.component.overrides).every((o) => !('flipX' in o)),
    JSON.stringify({ link: mirrored.component, x: mirroredText.x, width: mirroredText.width, frame: mirrored.width }))

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
