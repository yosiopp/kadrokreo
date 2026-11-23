// SVG の取り込み: ファイルを開く・ドロップ・貼り付けで、SVG を図形のノードに変換して置く。
// スクリプトが動かないこと、SVG を DOM に入れないこと、落としたものを知らせることも確かめる
const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')

const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors } = require('./harness.cjs')
const SAMPLE = path.join(__dirname, 'fixtures', 'sample.svg')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  page.on('dialog', (d) => d.accept())
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const saved = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kadrokreo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction(['document'])
      const doc = tx.objectStore('document').get('current')
      tx.oncomplete = () => resolve({ ...doc.result.document, nodes: Object.assign({}, ...doc.result.document.pages.map((p) => p.nodes)) })
    }
  }))
  const byName = (doc, name) => Object.values(doc.nodes).filter((n) => n.name === name)
  const layers = () => page.locator('.layer-row .layer-name').allTextContents()

  // ── ツールバーの「画像・SVG を配置」から開く ──
  const input = page.locator('input[type=file][accept*=".svg"][multiple]')
  check('画像を置くファイル選択で SVG も選べる', (await input.count()) === 1)
  await input.setInputFiles(SAMPLE)
  await page.waitForSelector('.app-message')
  const message = await page.locator('.app-message').textContent()
  check('落としたものを知らせる', /sample\.svg/.test(message) && /スクリプト/.test(message) && /foreignObject/.test(message) && !/フィルタ/.test(message) && /外部の画像/.test(message), message)
  await page.waitForTimeout(700)
  let doc = await saved()
  const root = byName(doc, 'sample')[0]
  check('SVG 全体が 1 つのフレームになる（名前はファイル名、大きさは width / height）', root?.type === 'frame' && root.width === 240 && root.height === 160 && root.clipContent === true, JSON.stringify(root && { w: root.width, h: root.height }))
  const house = byName(doc, 'house')[0]
  check('g は入れ子のフレームになり、レイヤー名に id を使う', house?.type === 'frame' && house.parentId === root.id && house.children.length === 3)
  const wall = byName(doc, 'wall')[0]
  check('rect は矩形（viewBox の縮尺と g の transform を焼き込む）', wall?.type === 'rect' && wall.parentId === house.id && wall.width === 80 && wall.height === 60 && wall.cornerRadius === 4 && wall.strokes[0]?.color === '#222222', JSON.stringify(wall && { w: wall.width, h: wall.height, r: wall.cornerRadius }))
  const hill = byName(doc, 'hill')[0]
  check('path の曲線は制御点つきの頂点になる', hill?.type === 'path' && hill.closed && hill.points.some((p) => p.in || p.out))
  const background = byName(doc, 'background')[0]
  check('linearGradient は直線状のグラデーションになる', background?.fills[0]?.type === 'linear' && background.fills[0].x1 === background.fills[0].x2 && background.fills[0].y2 > background.fills[0].y1 && background.fills[0].stops[0].color === '#4f8ef7')
  const caption = byName(doc, 'caption')[0]
  check('text はテキストになる（中央揃え・白）', caption?.type === 'text' && caption.text === 'Hello SVG' && caption.textAlign === 'center' && caption.fills[0]?.color === '#ffffff' && caption.fontSize === 12)
  const blurred = byName(doc, 'window')[0]
  check('ぼかしだけの filter はレイヤーのぼかしになる（知らせない）', blurred?.effects?.[0]?.type === 'layer-blur' && blurred.effects[0].blur > 0, JSON.stringify(blurred?.effects))
  check('ほかの図形もノードになる', ['roof', 'window', 'sun', 'ground', 'bird'].every((name) => byName(doc, name).length === 1), (await layers()).join(','))
  const ring = byName(doc, 'ring')[0]
  check('輪郭が複数の path は穴のある 1 つのパスになり、CSS の塗りと fill-rule を写す', ring?.type === 'path' && ring.contours.length === 1 && ring.fillRule === 'evenodd' && ring.fills[0]?.color === '#8e4ec6', JSON.stringify(ring && { c: ring.contours.length, r: ring.fillRule }))
  const dashes = byName(doc, 'dashes')[0]
  check('CSS の stroke-dasharray は破線になる（viewBox の縮尺をかける）', dashes?.strokeDashes?.join(',') === '6,4', JSON.stringify(dashes?.strokeDashes))
  const porthole = byName(doc, 'porthole')[0]
  check('円の clip-path は角丸の切り取るフレームになる', porthole?.type === 'frame' && porthole.clipContent && porthole.width === 24 && porthole.cornerRadius === 12 && byName(doc, 'clipped')[0]?.parentId === porthole.id)
  const pixel = byName(doc, 'pixel')[0]
  const storedAsset = pixel && await page.evaluate((id) => new Promise((resolve) => {
    const open = indexedDB.open('kadrokreo')
    open.onsuccess = () => {
      const request = open.result.transaction(['assets']).objectStore('assets').get(id)
      request.onsuccess = () => resolve(request.result?.mime ?? null)
      request.onerror = () => resolve(null)
    }
  }), pixel.assetId)
  check('data URI の <image> は画像のノードになり、画像がドキュメントに入る', pixel?.type === 'image' && pixel.width === 16 && storedAsset === 'image/png', JSON.stringify({ type: pixel?.type, w: pixel?.width, storedAsset }))
  const pwned = await page.evaluate(() => window.svgPwned)
  check('SVG のスクリプトや onload は動かない', pwned === undefined, String(pwned))
  check('SVG を画面の DOM に入れない', (await page.locator('#fixture-root, foreignObject').count()) === 0)
  check('kdr に SVG の文字が残らない', !/svgPwned|example\.com|<svg/.test(JSON.stringify(doc)))
  check('取り込んだものが選ばれている', (await page.locator('.layer-row[data-selected="true"] .layer-name').allTextContents()).includes('sample'))
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, 'svg-import.png') })

  // ── Undo で 1 回で消える ──
  await page.locator('.app-message button').click()
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(700)
  check('取り込みは Undo 1 回で消える', byName(await saved(), 'sample').length === 0)
  await page.keyboard.press('Meta+Shift+z')

  // ── ドロップ ──
  const source = fs.readFileSync(SAMPLE, 'utf8')
  await page.evaluate((text) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([text], 'dropped.svg', { type: 'image/svg+xml' }))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
  }, source)
  await page.waitForTimeout(700)
  doc = await saved()
  check('ドロップした SVG も取り込む', byName(doc, 'dropped').length === 1 && byName(doc, 'sample').length === 1)

  // ── 貼り付け（「SVG としてコピー」した文字） ──
  await page.locator('.canvas-view canvas').click({ position: { x: 20, y: 20 } })
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="40"><rect id="pasted-box" width="50" height="40" fill="#123456"/></svg>')
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(700)
  doc = await saved()
  const pasted = byName(doc, 'pasted-box')[0]
  check('貼り付けた SVG の文字も取り込む', pasted?.type === 'rect' && pasted.fills[0]?.color === '#123456' && pasted.width === 50)

  // ── 壊れた SVG と、画像としての SVG ──
  fs.writeFileSync(path.join(OUT, 'broken.svg'), '<svg><g></svg>')
  await input.setInputFiles(path.join(OUT, 'broken.svg'))
  await page.waitForSelector('.app-message')
  check('壊れた SVG はエラーを出す', /broken\.svg/.test(await page.locator('.app-message').textContent()))
  await page.locator('.app-message button').click()
  // 画像の差し替えは SVG を受け付けない（IMAGE_MIME_TYPES に入っていない）
  const accepts = await page.locator('input[type=file]').evaluateAll((inputs) => inputs.map((i) => i.accept))
  check('kdr を開くボタンでも SVG を選べる', accepts.some((a) => a.includes('.kdr') && a.includes('.svg')), accepts.join(' | '))

  // ── 書き出した SVG を取り込み直しても、テキストが上下にずれない（基線と上端をブラウザで測った書体の高さで行き来する） ──
  const drift = await page.evaluate(async () => {
    const { svgMarkup } = await import('/src/canvas/exportSvg.ts')
    const { measureTextNode } = await import('/src/canvas/measure.ts')
    const { getAbsoluteBounds } = await import('/src/document/geometry.ts')
    const { convertSvgText } = await import('/src/editor/importSvg.ts')
    const { createFrame, createText } = await import('/src/editor/nodes.ts')
    const { convertSvg } = await import('/src/editor/svg/convert.ts')
    const { parseSvgDom } = await import('/src/editor/svg/xml.ts')
    const cases = [
      ['One', 'Hello', { fontSize: 16 }],
      ['Two', 'A\nBB\nCCC', { fontSize: 20, lineHeight: 1.5 }],
      ['Three', 'Left\nRight', { fontSize: 48, lineHeight: 1, textAlign: 'right', fontWeight: 700 }],
      ['Four', 'x\ny', { fontSize: 11, lineHeight: 2.25, textAlign: 'center', fontFamily: 'serif' }],
      ['Five', '日本語\nかな', { fontSize: 30, lineHeight: 1.3 }],
    ]
    const frame = { ...createFrame({ x: 0, y: 0, width: 400, height: 600 }), id: 'F', name: 'F', children: [] }
    const nodes = { F: frame }
    cases.forEach(([name, text, patch], i) => {
      const node = { ...createText({ x: 10 + i * 3, y: 20 + i * 110, width: 0, height: 0 }, text), ...patch, id: name, name, parentId: 'F' }
      nodes[name] = { ...node, ...measureTextNode(node) }
      frame.children.push(name)
    })
    const scene = { nodes, rootIds: ['F'] }
    const svg = svgMarkup(scene, {}, ['F'])
    const measure = (fragment) => {
      const back = { nodes: fragment.nodes, rootIds: fragment.rootIds }
      return cases.map(([name]) => {
        const node = Object.values(back.nodes).find((n) => n.type === 'text' && n.name === name)
        return { name, dy: getAbsoluteBounds(back, node.id).y - getAbsoluteBounds(scene, name).y, lineHeight: node.lineHeight, expected: nodes[name].lineHeight }
      })
    }
    return {
      after: measure(convertSvgText(svg, 'export').fragment),
      // 直す前の取り込み（書体の高さを見積もる）
      before: measure(convertSvg(parseSvgDom(svg), { name: 'export', measureText: measureTextNode }).fragment),
    }
  })
  const show = (rows) => rows.map((r) => `${r.name} ${r.dy.toFixed(2)}`).join(', ')
  check('書き出した SVG を取り込み直すと、テキストの上下の位置が 0.5px 以内で揃う（複数行・行の高さ・行揃え・大きさ・書体）',
    drift.after.every((r) => Math.abs(r.dy) <= 0.5), `直したもの: ${show(drift.after)} / 見積もり: ${show(drift.before)}`)
  check('複数行のテキストは行の高さも読み戻す', drift.after.filter((r) => r.name !== 'One').every((r) => Math.abs(r.lineHeight - r.expected) < 0.001), JSON.stringify(drift.after.map((r) => r.lineHeight)))

  // ── viewer は SVG を受け付けない（kdr として開こうとしてエラー） ──
  const viewer = await context.newPage()
  watchErrors(viewer, errors)
  await viewer.goto(VIEWER)
  // 開発サーバーの最初の読み込みは遅いことがある
  await viewer.waitForSelector('input[type=file]', { state: 'attached', timeout: 60000 })
  await viewer.locator('input[type=file]').first().setInputFiles(SAMPLE)
  await viewer.waitForSelector('.app-message')
  check('viewer は SVG を開かない', (await viewer.evaluate(() => window.svgPwned)) === undefined)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
