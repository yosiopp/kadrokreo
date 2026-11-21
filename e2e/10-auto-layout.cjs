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
  const drag = async (from, to) => {
    await page.mouse.move(...at(...from)); await page.mouse.down()
    await page.mouse.move(...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), { steps: 4 })
    await page.mouse.move(...at(...to), { steps: 4 })
    await page.mouse.up()
  }
  const layers = () => page.locator('.layer-row .layer-name').allTextContents()
  const row = (name) => page.locator(`.layer-row:has(.layer-name:text-is("${name}"))`)
  const field = (label) => page.locator(`.field:has(.field-label:text-is("${label}")) input`).first()
  const select = (label) => page.locator(`.field:has(.field-label:text-is("${label}")) select`)
  const set = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Enter') }
  const deselect = () => page.mouse.click(...at(740, 600))
  const saved = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kadrokreo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const request = open.result.transaction('document').objectStore('document').get('current')
      request.onsuccess = () => resolve(request.result.document.pages[0])
    }
  }))
  const nodesByName = async () => { await page.waitForTimeout(700); return Object.fromEntries(Object.values((await saved()).nodes).map((n) => [n.name, n])) }

  // ── 既存のフレームを自動で並べる ──
  await page.keyboard.press('f'); await drag([100, 100], [500, 300])
  await page.keyboard.press('r'); await drag([130, 140], [190, 200])
  await page.keyboard.press('r'); await drag([220, 140], [300, 180])
  await page.keyboard.press('r'); await drag([330, 140], [370, 220])
  await row('Frame 1').click()
  await page.locator('label:has-text("中身を自動で並べる") input').check()
  let n = await nodesByName()
  check('いまの並びから向き・間隔・余白を決める', JSON.stringify(n['Frame 1'].layout) === JSON.stringify({ direction: 'horizontal', gap: 30, paddingTop: 40, paddingRight: 130, paddingBottom: 80, paddingLeft: 30, align: 'start', justify: 'start', widthMode: 'hug', heightMode: 'hug', wrap: false, crossGap: 30 }), JSON.stringify(n['Frame 1'].layout))
  check('見た目の位置もフレームの大きさも変わらない', n['Rectangle 1'].x === 30 && n['Rectangle 2'].x === 120 && n['Rectangle 3'].x === 230 && n['Frame 1'].width === 400 && n['Frame 1'].height === 200, `${n['Rectangle 2'].x}, ${n['Rectangle 3'].x}, ${n['Frame 1'].width}x${n['Frame 1'].height}`)
  check('レイヤー一覧は並び順のまま（先頭が上）', (await layers()).join() === 'Frame 1,Rectangle 1,Rectangle 2,Rectangle 3', (await layers()).join())

  // ── 設定を変える ──
  await set('間隔', 10)
  await set('右', 20); await set('下', 40); await set('左', 20)
  await select('揃え').selectOption('center')
  n = await nodesByName()
  check('間隔・余白・揃えを変えると並べ直す', n['Rectangle 1'].x === 20 && n['Rectangle 2'].x === 90 && n['Rectangle 3'].x === 180 && n['Frame 1'].width === 240 && n['Rectangle 2'].y === 60, `${n['Rectangle 2'].x}, ${n['Rectangle 3'].x}, ${n['Frame 1'].width}, y=${n['Rectangle 2'].y}`)
  await page.screenshot({ path: path.join(OUT, '33-auto-layout.png') })

  // ── ドラッグで並べ替える ──
  // Rectangle 1（フレーム内 20〜80）を右端へ
  await drag([150, 180], [320, 180])
  n = await nodesByName()
  check('ドラッグで順番を入れ替えられる', n['Rectangle 2'].x === 20 && n['Rectangle 3'].x === 110 && n['Rectangle 1'].x === 160, `${n['Rectangle 2'].x}, ${n['Rectangle 3'].x}, ${n['Rectangle 1'].x}`)
  check('一覧の順番も入れ替わる', (await layers()).join() === 'Frame 1,Rectangle 2,Rectangle 3,Rectangle 1', (await layers()).join())
  await page.keyboard.press('Meta+z')
  check('並べ替えは undo 1 回で戻る', (await layers()).join() === 'Frame 1,Rectangle 1,Rectangle 2,Rectangle 3', (await layers()).join())

  // ── 子の大きさ・表示・削除に追従する ──
  await row('Rectangle 2').click()
  await set('W', 200)
  n = await nodesByName()
  check('子を大きくすると後ろがずれ、フレームも伸びる', n['Rectangle 3'].x === 300 && n['Frame 1'].width === 360, `${n['Rectangle 3'].x}, ${n['Frame 1'].width}`)
  await page.keyboard.press('Backspace')
  n = await nodesByName()
  check('子を消すと詰める', n['Rectangle 3'].x === 90 && n['Frame 1'].width === 150, `${n['Rectangle 3'].x}, ${n['Frame 1'].width}`)
  await page.keyboard.press('Meta+z')

  // ── 外から入れる・中で描く ──
  await page.keyboard.press('o'); await drag([600, 400], [640, 440])
  // フレームの左端（先頭）へドラッグ
  await drag([620, 420], [108, 180])
  n = await nodesByName()
  check('外からドラッグすると、落とした位置の順番に入る', n['Ellipse 1'].parentId === n['Frame 1'].id && n['Ellipse 1'].x === 20 && n['Rectangle 1'].x === 70, `${n['Ellipse 1'].x}, ${n['Rectangle 1'].x}`)
  await page.keyboard.press('Meta+z')

  // ── 大きさを固定して寄せる ──
  await row('Frame 1').click()
  await set('W', 500)
  n = await nodesByName()
  check('幅を数値で指定すると固定になる', n['Frame 1'].layout.widthMode === 'fixed' && n['Frame 1'].width === 500 && (await select('幅').inputValue()) === 'fixed', JSON.stringify(n['Frame 1'].layout))
  await select('寄せ').selectOption('space-between')
  n = await nodesByName()
  check('均等に配る', n['Rectangle 1'].x === 20 && n['Rectangle 3'].x === 440, `${n['Rectangle 1'].x}, ${n['Rectangle 3'].x}`)
  await select('幅').selectOption('hug')
  n = await nodesByName()
  check('中身に合わせるに戻せる', n['Frame 1'].width === 360, String(n['Frame 1'].width))
  await select('向き').selectOption('vertical')
  n = await nodesByName()
  check('縦に並べ替えられる', n['Rectangle 1'].y === 40 && n['Rectangle 2'].y === 110 && n['Rectangle 3'].y === 160 && n['Frame 1'].height === 280, `${n['Rectangle 2'].y}, ${n['Rectangle 3'].y}, ${n['Frame 1'].height}`)

  // ── 子を親いっぱいに伸ばす（縦に並べ、幅は中身に合わせているフレーム） ──
  const fillBox = (label) => page.locator(`.properties-panel section:has(.section-title:text-is("親いっぱいに伸ばす")) label:has-text("${label}") input`)
  await row('Rectangle 2').click()
  await fillBox('幅').check()
  n = await nodesByName()
  const widest = Math.max(n['Rectangle 1'].width, n['Rectangle 3'].width)
  check('直交する向きに伸ばすと、いちばん広い子に合わせて余白の内側いっぱいになる',
    n['Rectangle 2'].width === widest && n['Rectangle 2'].x === n['Frame 1'].layout.paddingLeft && n['Rectangle 2'].layoutFill.width,
    `${n['Rectangle 2'].width} / ${widest}`)
  await fillBox('高さ').check()
  n = await nodesByName()
  const { paddingTop, paddingBottom, gap } = n['Frame 1'].layout
  const rest = n['Frame 1'].height - paddingTop - paddingBottom - gap * 2 - n['Rectangle 1'].height - n['Rectangle 3'].height
  check('並べる向きに伸ばすと、中身に合わせていた親は固定になり、残りを埋める',
    n['Frame 1'].layout.heightMode === 'fixed' && n['Rectangle 2'].height === rest && (await select('高さ').count()) === 0,
    `${n['Frame 1'].layout.heightMode} ${n['Rectangle 2'].height} / ${rest}`)
  await row('Frame 1').click()
  await set('H', 400)
  n = await nodesByName()
  const grown = 400 - paddingTop - paddingBottom - gap * 2 - n['Rectangle 1'].height - n['Rectangle 3'].height
  check('親を大きくすると、伸ばした子も伸びる', n['Frame 1'].height === 400 && n['Rectangle 2'].height === grown, `${n['Rectangle 2'].height} / ${grown}`)
  await page.keyboard.press('Meta+z'); await page.keyboard.press('Meta+z'); await page.keyboard.press('Meta+z')
  n = await nodesByName()
  check('undo で伸ばす指定が外れる', !n['Rectangle 2'].layoutFill.width && n['Frame 1'].layout.heightMode === 'hug' && n['Frame 1'].height === 280, `${n['Frame 1'].height}`)

  // ── 矢印キーで並べ替える（縦に並べているので上下の矢印）。ページ直下の Ellipse 1 は数えない ──
  const frameLayers = async () => (await layers()).filter((name) => name !== 'Ellipse 1').join()
  await row('Rectangle 1').click()
  await page.keyboard.press('ArrowDown')
  n = await nodesByName()
  check('並べる向きの矢印キーで順番を入れ替える', (await frameLayers()) === 'Frame 1,Rectangle 2,Rectangle 1,Rectangle 3' && n['Rectangle 2'].y < n['Rectangle 1'].y, await frameLayers())
  await page.keyboard.press('ArrowRight')
  check('直交する向きの矢印キーでは動かさない', (await frameLayers()) === 'Frame 1,Rectangle 2,Rectangle 1,Rectangle 3')
  await page.keyboard.press('Meta+z')
  check('矢印キーでの並べ替えは undo で戻る', (await frameLayers()) === 'Frame 1,Rectangle 1,Rectangle 2,Rectangle 3', await frameLayers())

  // ── 並びから外す ──
  await row('Rectangle 2').click()
  const before2 = (await nodesByName())['Rectangle 2']
  await page.locator('label:has-text("並びから外す") input').check()
  n = await nodesByName()
  check('並びから外すと、その場に残り、ほかの子が詰める', n['Rectangle 2'].layoutPositioning === 'absolute' && n['Rectangle 2'].y === before2.y && n['Rectangle 3'].y === n['Rectangle 1'].y + n['Rectangle 1'].height + n['Frame 1'].layout.gap && n['Frame 1'].height < 280,
    `${n['Rectangle 2'].y} ${n['Rectangle 3'].y} ${n['Frame 1'].height}`)
  check('外した子には、伸ばす指定を出さない', (await page.locator('.section-title:text-is("親いっぱいに伸ばす")').count()) === 0)
  await set('X', 300)
  n = await nodesByName()
  check('外した子は位置を自由に決められる', n['Rectangle 2'].x === 300, String(n['Rectangle 2'].x))
  await page.keyboard.press('Meta+z'); await page.keyboard.press('Meta+z')
  n = await nodesByName()
  check('undo で並びに戻る', n['Rectangle 2'].layoutPositioning === 'auto' && n['Frame 1'].height === 280)

  // ── 折り返す（横に並べ直して、幅を狭める） ──
  await row('Frame 1').click()
  await select('向き').selectOption('horizontal')
  await page.locator('label:has-text("収まらなければ折り返す") input').check()
  n = await nodesByName()
  check('折り返すようにすると、幅は固定になる', n['Frame 1'].layout.wrap && n['Frame 1'].layout.widthMode === 'fixed' && n['Frame 1'].width === 360, JSON.stringify(n['Frame 1'].layout))
  await set('W', 200)
  n = await nodesByName()
  check('収まらない子は次の行へ送り、高さが伸びる',
    n['Rectangle 2'].x === 20 && n['Rectangle 2'].y > n['Rectangle 1'].y + n['Rectangle 1'].height && n['Rectangle 3'].y > n['Rectangle 2'].y && n['Frame 1'].height > 200,
    `${n['Rectangle 2'].x},${n['Rectangle 2'].y} ${n['Rectangle 3'].y} ${n['Frame 1'].height}`)
  await set('行の間隔', 20)
  n = await nodesByName()
  check('行の間隔を変えられる', n['Rectangle 2'].y === n['Rectangle 1'].y + n['Rectangle 1'].height + 20, `${n['Rectangle 1'].y} ${n['Rectangle 2'].y}`)

  // ── 大きさの下限・上限（幅は固定、高さは中身に合わせている） ──
  const limitTitle = page.locator('.section-title:text-is("大きさの下限・上限")')
  check('中身に合わせている向きの欄だけ出す', (await limitTitle.count()) === 1 && (await field('最小 H').count()) === 1 && (await page.locator('.field-label:text-is("最小 W")').count()) === 0)
  const hugHeight = n['Frame 1'].height
  await set('最小 H', 500)
  n = await nodesByName()
  check('下限を決めると、中身より大きくなる', n['Frame 1'].minHeight === 500 && n['Frame 1'].height === 500, `${n['Frame 1'].height}`)
  await set('最小 H', '')
  n = await nodesByName()
  check('空欄にすると下限をやめる', n['Frame 1'].minHeight === null && n['Frame 1'].height === hugHeight, `${n['Frame 1'].height}`)

  // ── Shift + A でボタンを作る ──
  await deselect()
  await page.keyboard.press('t')
  await page.mouse.click(...at(600, 150))
  await page.keyboard.type('OK')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+A')
  check('Shift + A でフレームにまとめる', (await layers())[0] === 'Frame 2' && (await page.locator('.layer-row[data-selected="true"] .layer-name').textContent()) === 'Frame 2', (await layers()).join())
  await set('上', 8); await set('右', 16); await set('下', 8); await set('左', 16)
  n = await nodesByName()
  const before = n['Frame 2'].width
  check('余白を付けるとテキストを囲む大きさになる', before === n['Text 1'].width + 32 && n['Frame 2'].height === n['Text 1'].height + 16, `${before} / ${n['Text 1'].width}`)
  // 文字を増やすと、打っている最中からフレームが伸びる
  await page.mouse.dblclick(...at(600 + 16 + 4, 150))
  await page.waitForSelector('.text-editor')
  await page.keyboard.type('キャンセルする')
  await page.keyboard.press('Escape')
  n = await nodesByName()
  check('テキストを打ち替えるとフレームも伸びる', n['Frame 2'].width === n['Text 1'].width + 32 && n['Frame 2'].width > before, `${before} -> ${n['Frame 2'].width}`)
  await deselect()
  await page.screenshot({ path: path.join(OUT, '34-auto-layout-done.png') })

  // ── 書き出しと viewer ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'layout.kdr')
  await download.saveAs(kdrPath)
  const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(kdrPath)).toString('utf8'))
  const frames = Object.values(json.document.pages[0].nodes).filter((node) => node.type === 'frame')
  check('kdr に設定が入る', json.version === 14 && frames.every((frame) => frame.layout), JSON.stringify(frames.map((f) => f.layout && f.layout.direction)))

  const viewer = await context.newPage()
  viewer.on('pageerror', (e) => errors.push('viewer: ' + String(e)))
  viewer.on('console', (m) => m.type() === 'error' && errors.push('viewer: ' + m.text()))
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(300)
  await viewer.screenshot({ path: path.join(OUT, '35-viewer-layout.png') })
  await viewer.locator('.layer-row:has(.layer-name:text-is("Frame 1"))').click()
  const inspectText = await viewer.locator('.inspect-panel').innerText()
  check('viewer の CSS に折り返しが出る', inspectText.includes('flex-wrap: wrap;') && inspectText.includes('gap: 20px 10px;'), inspectText.slice(0, 200))
  await viewer.locator('input[type=file]').setInputFiles(path.join(FIXTURES, 'sample-v13.kdr'))
  await viewer.waitForTimeout(400)
  check('version 13 の kdr も開ける', (await viewer.locator('.app-message').count()) === 0)
  await viewer.locator('input[type=file]').setInputFiles(path.join(FIXTURES, 'sample-v7.kdr'))
  await viewer.waitForTimeout(400)
  check('version 7 の kdr も開ける', (await viewer.locator('.app-message').count()) === 0)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('CRASHED', e); process.exit(1) })
