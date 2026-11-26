// テキストの字間・下線・取り消し線。取り込んだ letter-spacing / text-decoration が字間・装飾になり、キャンバスの文字が
// 書き出した SVG（と元の SVG）をブラウザで描いた文字と同じ範囲に並ぶこと、プロパティパネルで変えると大きさを測り直すこと、
// viewer でも同じ形に描いてコード（CSS）に letter-spacing / text-decoration が出ることを確かめる
const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')

const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors, savedDocument, rowFinder, fieldFinder, blankPage } = require('./harness.cjs')

// 線に沿う文字（まっすぐな線なので、装飾の線も 1 本につながって見える）
const ALONG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120">' +
  '<rect id="marker" width="10" height="10" fill="#0000ff"/>' +
  '<defs><path id="guide" d="M20 80 L380 80"/></defs>' +
  '<text font-family="sans-serif" font-size="28" fill="#ff0000" letter-spacing="5" text-decoration="underline"><textPath href="#guide">Along line</textPath></text>' +
  '</svg>'

const SOURCE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120">' +
  '<rect id="marker" width="10" height="10" fill="#0000ff"/>' +
  '<text id="Spaced" x="20" y="70" font-family="sans-serif" font-size="32" fill="#ff0000" letter-spacing="6" text-decoration="underline">Spaced 字間</text>' +
  '</svg>'

/** 絵の赤い画素と青い目印の画素を囲む矩形と、赤い画素の数（位置は青い目印の左上から。ratio で CSS ピクセルに直す） */
function inkOf(data, width, height, ratio) {
  const box = () => ({ left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, count: 0 })
  const red = box()
  const blue = box()
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]]
      if (a < 128) continue
      const target = r > 180 && g < 110 && b < 110 ? red : r < 40 && g < 40 && b > 200 ? blue : null
      if (!target) continue
      target.left = Math.min(target.left, x)
      target.top = Math.min(target.top, y)
      target.right = Math.max(target.right, x + 1)
      target.bottom = Math.max(target.bottom, y + 1)
      target.count++
    }
  }
  // 装飾の線: 赤い画素が文字の範囲の幅の 8 割より多く並ぶ行（文字だけの行はそこまで続かない）
  const rows = []
  for (let y = red.top; y < red.bottom; y++) {
    let count = 0
    for (let x = red.left; x < red.right; x++) {
      const i = (y * width + x) * 4
      if (data[i + 3] >= 128 && data[i] > 180 && data[i + 1] < 110 && data[i + 2] < 110) count++
    }
    if (count > (red.right - red.left) * 0.8) rows.push(y)
  }
  const s = (value) => Math.round((value / ratio) * 10) / 10
  return {
    left: s(red.left - blue.left),
    top: s(red.top - blue.top),
    right: s(red.right - blue.left),
    bottom: s(red.bottom - blue.top),
    count: Math.round(red.count / ratio / ratio),
    rule: rows.length === 0 ? null : { top: s(rows[0] - blue.top), bottom: s(rows[rows.length - 1] + 1 - blue.top) },
  }
}

/**
 * 2 つの範囲がほぼ同じか。どれも左揃えなので、左端と縦の中心は tolerance px 以内、幅・高さは 8%（か tolerance + 1 px）以内、
 * 画素の数は 25% 以内（SVG を透明なキャンバスに描いた絵は、字の縁が背景と混ざらず赤のまま残るので多めに出る）。
 * 装飾の線は、文字の範囲の縦の中心からの位置で、上端・下端とも 2px 以内。
 * Linux の Chrome では、SVG を画像として描くときの書体が Canvas と違い、文字の送り幅と字の高さが少しずれる
 * （線に沿う 10 字で幅が 6px、字の位置が 2.5px ほど。macOS ではほぼ同じ）ので、大きさは割合で、線は文字からの位置で見る
 */
function sameInk(a, b, tolerance = 3) {
  const middle = (box) => (box.top + box.bottom) / 2
  const size = (box, from, to) => box[to] - box[from]
  const near = (x, y, slack) => Math.abs(x - y) <= slack
  const rule = a.rule === null || b.rule === null
    ? a.rule === b.rule
    : near(a.rule.top - middle(a), b.rule.top - middle(b), 2) && near(a.rule.bottom - middle(a), b.rule.bottom - middle(b), 2)
  return near(a.left, b.left, tolerance) &&
    near(middle(a), middle(b), tolerance) &&
    near(size(a, 'left', 'right'), size(b, 'left', 'right'), Math.max(tolerance + 1, size(b, 'left', 'right') * 0.08)) &&
    near(size(a, 'top', 'bottom'), size(b, 'top', 'bottom'), Math.max(tolerance + 1, size(b, 'top', 'bottom') * 0.08)) &&
    Math.abs(a.count - b.count) <= b.count * 0.25 &&
    rule
}

async function canvasInk(page) {
  const { data, width, height, ratio } = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
    return { data: Array.from(image.data), width: canvas.width, height: canvas.height, ratio: canvas.width / canvas.clientWidth }
  })
  return inkOf(data, width, height, ratio)
}

/** SVG をブラウザで描いた絵の範囲（2 倍で描く）。page は何も読み込んでいないページ（アプリのページは CSP が blob: の画像を止める） */
async function svgInk(page, text) {
  const { data, width, height } = await page.evaluate(async (svg) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth * 2
    canvas.height = img.naturalHeight * 2
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    URL.revokeObjectURL(url)
    return { data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data), width: canvas.width, height: canvas.height }
  }, text)
  return inkOf(data, width, height, 2)
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const saved = async () => { await page.waitForTimeout(600); return (await savedDocument(page)).pages[0] }
  const row = rowFinder(page, { first: true })
  const field = fieldFinder(page)

  // ── Canvas の letterSpacing は、字間を文字のまとまりごとに（最後の文字の後ろにも）足す（測り方の前提） ──
  const spacing = await page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d')
    ctx.font = '20px sans-serif'
    const text = 'Ab 日本👍🏽é'
    const raw = ctx.measureText(text).width
    ctx.letterSpacing = '5px'
    const spaced = ctx.measureText(text).width
    const count = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)).length
    return { supported: 'letterSpacing' in ctx, raw, spaced, count }
  })
  check('Canvas の letterSpacing は、書記素ごとの字間の足し算と同じ幅になる',
    spacing.supported && Math.abs(spacing.spaced - (spacing.raw + 5 * spacing.count)) < 0.5, JSON.stringify(spacing))

  // ── 取り込み: letter-spacing / text-decoration がテキストの字間・装飾になる ──
  await page.evaluate((svg) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', svg)
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, SOURCE)
  await page.waitForTimeout(600)
  let nodes = (await saved()).nodes
  const text = Object.values(nodes).find((node) => node.type === 'text')
  check('取り込んだ letter-spacing・text-decoration が字間・下線になる', text?.letterSpacing === 6 && text.textDecoration === 'underline',
    JSON.stringify(text && { letterSpacing: text.letterSpacing, textDecoration: text.textDecoration }))

  // ── 書き出した SVG をブラウザで描くと、キャンバスと同じ範囲に文字と下線が並ぶ ──
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("SVG に")').click()])
  const svgPath = path.join(OUT, 'text-style.svg')
  await download.saveAs(svgPath)
  const exported = fs.readFileSync(svgPath, 'utf8')
  const drawn = await canvasInk(page)
  const blank = await blankPage(context, errors)
  const fromSvg = await svgInk(blank, exported)
  const original = await svgInk(blank, SOURCE)
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, '49-text-style.png') })
  check('書き出した SVG は letter-spacing・text-decoration で書く', exported.includes(' letter-spacing="6" text-decoration="underline"'))
  check('キャンバスの文字と下線は、書き出した SVG をブラウザで描いたものと同じ範囲', drawn.count > 300 && sameInk(drawn, fromSvg),
    `canvas ${JSON.stringify(drawn)} / svg ${JSON.stringify(fromSvg)}`)
  check('取り込む前の SVG をブラウザで描いたものとも同じ範囲', sameInk(drawn, original), `canvas ${JSON.stringify(drawn)} / 元 ${JSON.stringify(original)}`)

  // ── プロパティパネル: 字間を変えると幅を測り直し、装飾を外す・取り消し線にする ──
  await row(text.name).click()
  const letterSpacing = field('字間（px）')
  check('テキストを選ぶと字間・装飾の欄が出る', (await letterSpacing.inputValue()) === '6'
    && (await page.locator('.field:has(.field-label:text-is("装飾")) select').first().inputValue()) === 'underline')
  await letterSpacing.fill('0')
  await letterSpacing.press('Enter')
  nodes = (await saved()).nodes
  // 「Spaced 字間」は 9 文字なので、字間 6 を外すと 54 狭くなる
  check('字間を 0 にすると、文字の数 × 字間だけ幅が狭くなる', nodes[text.id].letterSpacing === 0 && Math.abs(text.width - nodes[text.id].width - 54) <= 1,
    `${text.width} → ${nodes[text.id].width}`)
  const select = page.locator('.field:has(.field-label:text-is("装飾")) select').first()
  await select.selectOption('none')
  nodes = (await saved()).nodes
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  const plain = await canvasInk(page)
  check('下線は文字の範囲いっぱいに、基線の少し下に引く', drawn.rule !== null && drawn.rule.top > 70 - 43.5 && drawn.rule.bottom - drawn.rule.top <= 3, JSON.stringify(drawn.rule))
  check('装飾を「なし」にすると線が消える', nodes[text.id].textDecoration === 'none' && plain.rule === null && plain.count < drawn.count, JSON.stringify(plain))
  await row(text.name).click()
  await letterSpacing.fill('4')
  await letterSpacing.press('Enter')
  await select.selectOption('line-through')
  nodes = (await saved()).nodes
  await page.screenshot({ path: path.join(OUT, '49-text-style-panel.png') })
  check('字間 4・取り消し線にできる', nodes[text.id].letterSpacing === 4 && nodes[text.id].textDecoration === 'line-through')

  // ── 編集中の入力欄も同じ字間・装飾で文字を出す ──
  await page.keyboard.press('Enter')
  const editor = page.locator('textarea.text-editor')
  await editor.waitFor()
  const editorStyle = await editor.evaluate((el) => ({ spacing: getComputedStyle(el).letterSpacing, decoration: getComputedStyle(el).textDecorationLine }))
  check('編集中の入力欄にも字間と装飾がかかる', editorStyle.decoration === 'line-through' && parseFloat(editorStyle.spacing) > 0, JSON.stringify(editorStyle))
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  const struck = await canvasInk(page)
  check('取り消し線は文字の真ん中あたりに引く', struck.rule !== null && struck.rule.top > struck.top + 5 && struck.rule.bottom < drawn.rule.top - 5, JSON.stringify(struck.rule))
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, '49-text-style-struck.png') })

  // ── viewer: 同じ形に描き、CSS に letter-spacing / text-decoration が出る ──
  const [kdr] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'text-style.kdr')
  await kdr.saveAs(kdrPath)
  const [again] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("SVG に")').click()])
  const struckSvg = fs.readFileSync(await again.path(), 'utf8')
  const struckFromSvg = await svgInk(blank, struckSvg)
  await blank.close()
  check('取り消し線も、書き出した SVG をブラウザで描いたものと同じ範囲', sameInk(struck, struckFromSvg),
    `canvas ${JSON.stringify(struck)} / svg ${JSON.stringify(struckFromSvg)}`)
  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(500)
  const zoom = await viewer.evaluate(() => {
    const label = [...document.querySelectorAll('button, span')].map((e) => e.textContent).find((t) => /^\d+%$/.test(t?.trim() ?? ''))
    return label ? parseInt(label) / 100 : 1
  })
  const inViewer = await canvasInk(viewer)
  const scale = (value, key) => (key === 'count' ? value / zoom / zoom : value / zoom)
  const scaled = Object.fromEntries(Object.entries(inViewer).map(([key, value]) => [
    key,
    key === 'rule' ? value && { top: scale(value.top), bottom: scale(value.bottom) } : scale(value, key),
  ]))
  check('viewer でも editor と同じ形に描く', sameInk(scaled, struck, 3), `viewer ${JSON.stringify(scaled)}（${zoom * 100}%）/ editor ${JSON.stringify(struck)}`)
  await viewer.locator(`.layer-row:has(.layer-name:text-is("${text.name}"))`).first().click()
  const code = await viewer.locator('.inspect-panel').innerText()
  check('viewer のコードに letter-spacing・text-decoration が出る', code.includes('letter-spacing: 4px;') && code.includes('text-decoration: line-through;'), code.slice(0, 400))
  check('viewer のインスペクトに字間・装飾が出る', code.includes('4px（0.13em）') && code.includes('取り消し線'))
  await viewer.screenshot({ path: path.join(OUT, '49-text-style-viewer.png') })

  // ── 線に沿う文字も、字間を送り幅に足し、装飾の線を文字ごとに引く（ブラウザの textPath と同じ範囲） ──
  await page.bringToFront()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Backspace')
  await page.evaluate((svg) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', svg)
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, ALONG)
  await page.waitForTimeout(600)
  const along = Object.values((await saved()).nodes).find((node) => node.type === 'text')
  check('線に沿う文字にも字間・装飾が入る', along?.textPath !== null && along?.letterSpacing === 5 && along.textDecoration === 'underline',
    JSON.stringify(along && { textPath: along.textPath !== null, letterSpacing: along.letterSpacing, textDecoration: along.textDecoration }))
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  const [alongDownload] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("SVG に")').click()])
  const alongSvg = fs.readFileSync(await alongDownload.path(), 'utf8')
  const alongDrawn = await canvasInk(page)
  const alongBlank = await blankPage(context, errors)
  const alongFromSvg = await svgInk(alongBlank, alongSvg)
  const alongOriginal = await svgInk(alongBlank, ALONG)
  await alongBlank.close()
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, '49-text-style-path.png') })
  check('線に沿う文字の字間と下線は、書き出した SVG をブラウザで描いたものと同じ範囲', alongDrawn.count > 200 && sameInk(alongDrawn, alongFromSvg),
    `canvas ${JSON.stringify(alongDrawn)} / svg ${JSON.stringify(alongFromSvg)}`)
  check('取り込む前の SVG をブラウザで描いたものとも同じ範囲', sameInk(alongDrawn, alongOriginal), `canvas ${JSON.stringify(alongDrawn)} / 元 ${JSON.stringify(alongOriginal)}`)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
