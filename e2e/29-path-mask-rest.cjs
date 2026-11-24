// パスとマスクの残り: 元を残すブーリアン演算のノード（キー ⌥⇧S と右クリックメニューで作る・演算を変える・子を動かす・平らにする）、線の輪郭化（⌥⌘O）、
// 明るさのマスク（SVG の mask の取り込みと描画）
const { chromium } = require('playwright-core')
const path = require('path')

const { OUT, EDITOR, check, finish, crashed, watchErrors, savedDocument, pointer } = require('./harness.cjs')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const box = await page.locator('.canvas-view').boundingBox()
  const saved = async () => (await savedDocument(page)).pages[0]
  const nodes = async () => { await page.waitForTimeout(600); return Object.values((await saved()).nodes) }
  const named = async (name) => (await nodes()).filter((n) => n.name === name)

  const origin = { x: Math.round(box.width / 2 - 100), y: Math.round(box.height / 2 - 100) }
  const at = pointer(box, origin)
  const shiftClick = async (x, y) => { await page.keyboard.down('Shift'); await page.mouse.click(...at(x, y)); await page.keyboard.up('Shift') }
  /** キャンバスの 1 画素（SVG の座標で） */
  const pixel = (x, y) => page.evaluate(async ([x, y]) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const ratio = canvas.width / canvas.clientWidth
    return [...canvas.getContext('2d').getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data]
  }, [origin.x + x, origin.y + y])
  const reddish = (p) => p[0] > 200 && p[1] < 110 && p[2] < 110
  const pasteSvg = async (svg) => {
    await page.evaluate((text) => {
      const transfer = new DataTransfer()
      transfer.setData('text/plain', text)
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    }, svg)
    await page.waitForTimeout(700)
  }
  const menu = async (x, y, ...labels) => {
    await page.mouse.click(...at(x, y), { button: 'right' })
    for (const label of labels.slice(0, -1)) await page.locator(`.context-menu-label:text-is("${label}")`).hover()
    await page.locator(`.context-menu-label:text-is("${labels.at(-1)}")`).click()
    await page.waitForTimeout(600)
  }

  // 200×200 の SVG（左上の赤い正方形と、それに重なる円、右上の線だけの矩形）
  await pasteSvg('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
    '<rect id="a" x="20" y="20" width="100" height="100" fill="#e5484d"/><circle id="b" cx="120" cy="120" r="50" fill="#30a46c"/>' +
    '<rect id="edge" x="140" y="10" width="40" height="30" fill="none" stroke="#0000ff" stroke-width="6"/></svg>')
  const background = await pixel(195, 195)

  // ── 元を残す差し引き（⌥⇧S）: キーでもノードができる。Undo で戻す ──
  await page.keyboard.press('Escape')
  await page.mouse.click(...at(40, 40))
  await shiftClick(150, 150)
  await page.keyboard.press('Alt+Shift+KeyS')
  await page.waitForTimeout(600)
  let [keyed] = await named('差し引き')
  check('⌥⇧S で差し引きのノードができる（焼き込まない）', keyed?.type === 'frame' && keyed.booleanOperation === 'subtract' && (await named('a'))[0]?.type === 'rect',
    JSON.stringify(keyed && { type: keyed.type, op: keyed.booleanOperation }))
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(600)
  check('Undo で元の正方形と円に戻る', (await named('差し引き')).length === 0 && (await named('a'))[0]?.parentId !== keyed?.id)

  // ── 元を残す差し引き（右クリックメニュー）: 正方形から円を引いたノード。子は描かない ──
  await page.keyboard.press('Escape')
  await page.mouse.click(...at(40, 40))
  await shiftClick(150, 150)
  await page.mouse.click(...at(40, 40), { button: 'right' })
  await page.locator('.context-menu-label:text-is("ブーリアン演算（元を残す）")').hover()
  const shortcut = await page.locator('.context-menu-item:has(.context-menu-label:text-is("差し引き")) .context-menu-shortcut').allTextContents()
  check('メニューにキー（⌥⇧S。macOS 以外は Alt+Shift+S）が出る', shortcut.includes('⌥⇧S') || shortcut.includes('Alt+Shift+S'), JSON.stringify(shortcut))
  await page.keyboard.press('Escape')
  await menu(40, 40, 'ブーリアン演算（元を残す）', '差し引き')
  let [node] = await named('差し引き')
  const children = node ? node.children : []
  check('差し引きのノードができ、正方形と円を子に残す', node?.type === 'frame' && node.booleanOperation === 'subtract' && children.length === 2 &&
    (await named('a'))[0]?.parentId === node.id, JSON.stringify(node && { op: node.booleanOperation, children: node.children.length }))
  check('枠は結果（正方形）に合う', node && Math.abs(node.width - 100) < 0.05 && Math.abs(node.height - 100) < 0.05, JSON.stringify(node && { w: node.width, h: node.height }))
  check('重なった所は抜け、円だけの所は描かれない', reddish(await pixel(40, 40)) && !reddish(await pixel(100, 100)) &&
    JSON.stringify(await pixel(150, 150)) === JSON.stringify(background), JSON.stringify([await pixel(100, 100), await pixel(150, 150)]))
  check('プロパティに演算の欄が出る', (await page.locator('.properties-panel .field:has(.field-label:text-is("演算")) select').inputValue()) === 'subtract')
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, 'boolean-node-subtract.png') })

  // ── 演算を合体に変える（プロパティの「演算」） ──
  await page.locator('.properties-panel .field:has(.field-label:text-is("演算")) select').selectOption({ label: '合体' })
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, 'boolean-node-union.png') })
  ;[node] = await named('差し引き')
  check('合体に変えると、円の所も塗られ、枠が広がる', node?.booleanOperation === 'union' && Math.abs(node.width - 150) < 0.05 && reddish(await pixel(150, 150)),
    JSON.stringify(node && { op: node.booleanOperation, w: node.width, p: 0 }) + JSON.stringify(await pixel(150, 150)))

  // ── ダブルクリックで元の図形を選び、動かすと結果が変わる ──
  await page.mouse.dblclick(...at(40, 40))
  await page.waitForTimeout(300)
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  ;[node] = await named('差し引き')
  check('元の図形を動かすと、結果の枠も変わる（130 × 150）', node && Math.abs(node.width - 130) < 0.05 &&
    (await named('a'))[0]?.parentId === node.id, JSON.stringify(node && { x: node.x, w: node.width }))
  check('動かした跡（左端）は塗られない', !reddish(await pixel(25, 60)) && reddish(await pixel(50, 60)))

  // ── 平らにする ──
  await page.keyboard.press('Escape')
  await page.mouse.click(...at(150, 150))
  await menu(150, 150, 'ブーリアン演算（元を残す）', '平らにする')
  ;[node] = await named('差し引き')
  check('平らにすると、結果のパスになり子は消える', node?.type === 'path' && node.fillRule === 'evenodd' && (await named('a')).length === 0 && (await named('b')).length === 0)

  // ── 線の輪郭化（⌥⌘O）: 線だけの矩形が、線の色で塗ったパスになる ──
  await page.keyboard.press('Escape')
  await page.mouse.click(...at(160, 12))
  await page.keyboard.press('Alt+Meta+KeyO')
  const [edge] = await named('edge')
  check('線の輪郭化で、線の色で塗ったパス（46 × 36）になる', edge?.type === 'path' && edge.strokes.length === 0 && edge.fills[0]?.color === '#0000ff' &&
    Math.abs(edge.width - 46) < 0.05 && Math.abs(edge.height - 36) < 0.05 && edge.contours.length === 1, JSON.stringify(edge && { type: edge.type, w: edge.width, h: edge.height }))
  await page.keyboard.press('Meta+z')
  check('Undo で元の矩形に戻る', (await named('edge'))[0]?.type === 'rect')

  // ── 明るさのマスク: 左が白・右が黒のグラデーションの mask を取り込むと、明るさのマスクになり、右ほど透ける ──
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Delete')
  await pasteSvg('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><defs>' +
    '<linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#000000"/></linearGradient>' +
    '<mask id="fade"><rect x="0" y="0" width="200" height="200" fill="url(#g)"/></mask></defs>' +
    '<g mask="url(#fade)"><rect id="photo" x="0" y="0" width="200" height="200" fill="#e5484d"/></g></svg>')
  const [fade] = await named('fade')
  check('SVG のグラデーションの mask は、明るさのマスクになる', fade?.isMask === true && fade.maskType === 'luminance' && fade.fills[0]?.type === 'linear',
    JSON.stringify(fade && { isMask: fade.isMask, maskType: fade.maskType }))
  const left = await pixel(10, 100)
  const right = await pixel(190, 100)
  // キャンバスの背景は透明（画面の色は CSS）なので、不透明度で見る
  check('白い所は見え、黒い所は透ける', reddish(left) && left[3] > 200 && right[3] < 40, JSON.stringify({ left, right }))
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, 'luminance-mask.png') })

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
