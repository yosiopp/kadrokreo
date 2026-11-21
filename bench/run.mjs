// 大きなデザインでの性能を測る。npm run check には入れていない（数分かかり、値も揺れるため）。
//   npm run bench                         決まった 2 つの大きさ（medium・large）で測る
//   npm run bench -- --preset medium      1 つだけ
//   npm run bench -- --nodes 5000 --depth 6 --instances 500 --images 20   大きさを指定して測る
//   npm run bench -- --no-build           dist/ のビルドをそのまま使う
//   npm run bench -- --runs 50            1 つの操作で測る回数（既定 30）
// 本番と同じビルド（vite build）を vite preview で配り、Chrome（Playwright）で開いて操作する。
// 結果は bench/out/latest.json と bench/out/latest.md（表）に出す。Google Chrome が必要。
//
// 測る値: 操作 1 回ぶんの「メインスレッドが働いた時間」（Chrome の Performance.getMetrics の TaskDuration の増分）。
// ポインタを 1 回動かすごとに描画が終わるまで（rAF 2 回）待ち、その間に増えた分を 1 回の時間とする。
// 何もしないで同じだけ待ったときの増分（計測そのものの手間）を差し引く。画面の更新を待つ時間（vsync）は含まない。
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { decodeKdr } from '../src/document/kdr.ts'
import { getContentBounds } from '../src/document/geometry.ts'
import { fitBounds, worldToScreen } from '../src/canvas/viewport.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const OUT = join(here, 'out')
mkdirSync(OUT, { recursive: true })

const PRESETS = {
  // HANDOVER の「2,000 行」「写し 1,000 個」に合わせた大きさ
  medium: { nodes: 2000, depth: 4, instances: 170, images: 10 },
  // 1 桁大きいもの
  large: { nodes: 10000, depth: 8, instances: 1000, images: 50 },
}

function parseArgs(argv) {
  const args = { presets: Object.keys(PRESETS), custom: null, build: true, runs: 30 }
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]
    if (name === '--no-build') args.build = false
    else if (name === '--preset') args.presets = [argv[++i]]
    else if (name === '--runs') args.runs = Number(argv[++i])
    else if (['--nodes', '--depth', '--instances', '--images'].includes(name)) {
      args.custom ??= { ...PRESETS.medium }
      args.custom[name.slice(2)] = Number(argv[++i])
    } else throw new Error(`知らない引数です: ${name}`)
  }
  for (const preset of args.presets) if (!PRESETS[preset]) throw new Error(`知らない大きさです: ${preset}`)
  return args
}

const args = parseArgs(process.argv.slice(2))
const cases = args.custom ? [['custom', args.custom]] : args.presets.map((name) => [name, PRESETS[name]])

const optionArgs = (options) => Object.entries(options).flatMap(([key, value]) => [`--${key}`, String(value)])

function node(script, extra) {
  const result = spawnSync('node', [join(root, script), ...extra], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${script} が失敗しました\n${result.stderr}`)
  return JSON.parse(result.stdout)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

const servers = []
function serve(outDir, port) {
  servers.push(spawn('npx', ['vite', 'preview', '--outDir', outDir, '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' }))
  return `http://localhost:${port}`
}

async function waitFor(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // まだ起動していない
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`サーバーが起動しません: ${url}`)
}

function stats(samples) {
  const sorted = samples.map((value) => Math.max(0, value)).sort((a, b) => a - b)
  const pick = (ratio) => Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))].toFixed(2))
  return { median: pick(0.5), p90: pick(0.9), max: pick(1), runs: sorted.length }
}

/** ページを開き、メインスレッドの働いた時間を読めるようにする */
async function openPage(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
  page.on('dialog', (dialog) => dialog.accept())
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  const busy = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics')
    return metrics.find((metric) => metric.name === 'TaskDuration').value * 1000
  }
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))))
  await page.goto(url)
  await page.waitForSelector('input[type=file]', { state: 'attached' })

  // 何もしないときの 1 回分（計測そのものの手間）
  const idle = []
  for (let i = 0; i < 10; i++) {
    const before = await busy()
    await frames()
    idle.push((await busy()) - before)
  }
  const overhead = stats(idle).median

  /** action を 1 回ずつ runs 回行い、1 回ごとのメインスレッドの時間を集める */
  async function measure(runs, action) {
    const samples = []
    for (let i = 0; i < runs; i++) {
      const before = await busy()
      await action(i)
      await frames()
      samples.push((await busy()) - before - overhead)
    }
    return stats(samples)
  }
  return { context, page, errors, busy, frames, measure, overhead }
}

/** ページ上の点を、開いた直後（全体表示）の画面の点にする */
function screenMapper(document, box) {
  const scene = document.pages[0]
  const viewport = fitBounds(getContentBounds(scene), { width: box.width, height: box.height })
  return (point) => {
    const screen = worldToScreen(viewport, point)
    return { x: box.x + screen.x, y: box.y + screen.y }
  }
}

const center = (bounds) => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })

/** kdr を開くまで: ファイルを渡してから、レイヤーの行が出て描画が 1 回終わるまで */
async function measureOpen(browser, url, kdrPath, rowSelector, rows) {
  const walls = []
  const tasks = []
  for (let i = 0; i < 3; i++) {
    const session = await openPage(browser, url)
    const input = session.page.locator(url.includes(editorPort) ? 'input[type=file][accept^=".kdr"]' : 'input[type=file]').first()
    const before = await session.busy()
    const start = Date.now()
    await input.setInputFiles(kdrPath)
    await session.page.waitForFunction(
      ([selector, count]) => document.querySelectorAll(selector).length >= count,
      [rowSelector, rows],
      { polling: 'raf', timeout: 120_000 },
    )
    await session.frames()
    walls.push(Date.now() - start)
    tasks.push((await session.busy()) - before)
    await session.context.close()
  }
  return { wall: stats(walls), main: stats(tasks) }
}

/** パン（ホイール）とズーム（Ctrl + ホイール）1 回ごと */
async function measurePanZoom(session, box) {
  const { page, measure } = session
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const pan = await measure(args.runs, (i) => page.mouse.wheel(0, i % 2 === 0 ? 40 : -40))
  await page.keyboard.down('Control')
  const zoom = await measure(args.runs, (i) => page.mouse.wheel(0, i % 2 === 0 ? -20 : 20))
  await page.keyboard.up('Control')
  return { pan, zoom }
}

let editorPort = ''

async function benchEditor(browser, url, caseName, kdrPath, document, meta) {
  const results = {}
  results.open = await measureOpen(browser, url, kdrPath, '.layer-row', meta.layerRows)

  const session = await openPage(browser, url)
  const { page, measure, frames } = session
  await page.locator('input[type=file][accept^=".kdr"]').setInputFiles(kdrPath)
  await page.waitForFunction((count) => document.querySelectorAll('.layer-row').length >= count, meta.layerRows, { timeout: 120_000 })
  await frames()
  const box = await page.locator('.canvas-view').boundingBox()
  const toScreen = screenMapper(document, box)
  const selectedNames = () => page.locator('.layer-row[data-selected="true"] .layer-name').allTextContents()
  /** 操作が狙いどおりに効いたか。外れていれば、その値は意味がないので結果に残して知らせる */
  const checks = []
  const check = (name, ok) => ok || checks.push(name)

  /** start から 1 回に step ずつポインタを動かすドラッグ。最初の数回（ドラッグの判定まで）は測らない */
  async function drag(start, step, shot, oneWay = false) {
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    let at = { ...start }
    const moveBy = async (i) => {
      // 図形のドラッグは行き来させる（遠くへ行かないように）。範囲選択は一方向に広げて、図形を囲みにいく
      const sign = oneWay || Math.floor(i / 10) % 2 === 0 ? 1 : -1
      at = { x: at.x + step.x * sign, y: at.y + step.y * sign }
      await page.mouse.move(at.x, at.y)
    }
    for (let i = 0; i < 5; i++) await moveBy(i)
    const result = await measure(args.runs, (i) => moveBy(i + 5))
    // 操作が狙いどおりだったかを後で見られるよう、離す前の画面を残す
    await page.screenshot({ path: join(OUT, `${shot}.png`) })
    await page.mouse.up()
    return result
  }

  // レイヤーパネルを開いた状態（フレームは開き、インスタンスは閉じた既定のまま）で図形をドラッグ
  const target = toScreen(center(meta.dragTarget))
  results.dragLayersOpen = await drag(target, { x: 3, y: 2 }, `${caseName}-editor-drag`)
  check('ドラッグで DragTarget を選んでいない', (await selectedNames()).join() === 'DragTarget')
  await page.keyboard.press('Meta+z')
  // 比べるために、ページ直下のフレームを閉じて行を減らした状態でも測る
  for (const name of ['Tree', 'Instances', 'Images']) {
    const caret = page.locator(`.layer-row:has(.layer-name:text-is("${name}")) .layer-caret[aria-label="閉じる"]`).first()
    if ((await caret.count()) > 0) await caret.click()
  }
  results.dragLayersClosed = await drag(target, { x: 3, y: 2 }, `${caseName}-editor-drag-closed`)
  results.dragLayersClosed.rows = await page.locator('.layer-row').count()
  results.dragLayersOpen.rows = meta.layerRows
  await page.keyboard.press('Meta+z')
  // 閉じたフレームを開き直す
  for (const name of ['Tree', 'Instances', 'Images']) {
    const caret = page.locator(`.layer-row:has(.layer-name:text-is("${name}")) .layer-caret[aria-label="開く"]`).first()
    if ((await caret.count()) > 0) await caret.click()
  }
  await page.waitForFunction((count) => document.querySelectorAll('.layer-row').length >= count, meta.layerRows)

  // 範囲選択の途中（何もない場所から、木のほうへ）
  await page.keyboard.press('Escape')
  results.marquee = await drag(toScreen(center(meta.empty)), { x: 12, y: -4 }, `${caseName}-editor-marquee`, true)
  check('範囲選択で何も選んでいない', (await selectedNames()).length > 0)
  await page.keyboard.press('Escape')

  // コンポーネントの元の色を変えたときの同期（色の欄に打ち込む = preview と確定）
  await page.locator('.layer-row:has(.layer-name:text-is("Background"))').first().click()
  const color = page.locator('[aria-label="塗りの色"]').first()
  check('Background を選べていない', (await selectedNames()).join() === 'Background')
  results.componentSync = await measure(Math.min(args.runs, 10), (i) => color.fill(i % 2 === 0 ? '#fde68a' : '#f8fafc'))
  check('元の色を変えられていない', (await color.inputValue()) === '#f8fafc')
  await page.keyboard.press('Escape')

  Object.assign(results, await measurePanZoom(session, box))
  results.errors = session.errors
  results.checks = checks
  await session.context.close()
  return results
}

async function benchViewer(browser, url, kdrPath, meta) {
  const results = {}
  results.open = await measureOpen(browser, url, kdrPath, '.inspect-layer', meta.layerRows)
  const session = await openPage(browser, url)
  const { page, frames } = session
  await page.locator('input[type=file]').setInputFiles(kdrPath)
  await page.waitForFunction((count) => document.querySelectorAll('.inspect-layer').length >= count, meta.layerRows, { timeout: 120_000 })
  await frames()
  const box = await page.locator('.canvas-view').boundingBox()

  // 一覧（色・文字・影）は何も選んでいないときに出る。選んでから Escape で外したときの描き直し
  const row = page.locator('.inspect-layer:has(.layer-name:text-is("DragTarget"))').first()
  // 選ぶ側の時間は含めず、外した側だけを数える
  const deselect = []
  for (let i = 0; i < Math.min(args.runs, 10); i++) {
    await row.click()
    await frames()
    const before = await session.busy()
    await page.keyboard.press('Escape')
    await frames()
    deselect.push((await session.busy()) - before - session.overhead)
  }
  results.summary = stats(deselect)
  await page.locator('button:text-is("全体表示")').click()
  Object.assign(results, await measurePanZoom(session, box))
  results.errors = session.errors
  await session.context.close()
  return results
}

// ── 表 ──

const LABELS = [
  ['pure', 'decodeKdr', 'kdr を読む（展開・解析・検証）', 'Node'],
  ['pure', 'syncComponentsNoop', 'syncComponents（変更なし）', 'Node'],
  ['pure', 'syncComponentsUnrelated', 'syncComponents（元に関係ない変更）', 'Node'],
  ['pure', 'syncComponentsMainChanged', 'syncComponents（元の色を変えた）', 'Node'],
  ['pure', 'storeApplyUnrelated', 'ストアの apply 1 回（settle を含む）', 'Node'],
  ['pure', 'storePreviewMove', 'ストアの preview 1 回（ドラッグ 1 歩）', 'Node'],
  ['pure', 'layerRows', 'レイヤーの行を並べる', 'Node'],
  ['pure', 'inspectPage', 'viewer の一覧（色・文字・影）を作る', 'Node'],
  ['editor', 'open.main', 'kdr を開く（メインスレッド）', 'editor'],
  ['editor', 'open.wall', 'kdr を開く（経過時間）', 'editor'],
  ['editor', 'dragLayersOpen', 'ドラッグ 1 歩（レイヤーを開いた状態）', 'editor'],
  ['editor', 'dragLayersClosed', 'ドラッグ 1 歩（ページ直下を閉じた状態）', 'editor'],
  ['editor', 'marquee', '範囲選択 1 歩', 'editor'],
  ['editor', 'componentSync', '元の色を変える（同期と描き直し）', 'editor'],
  ['editor', 'pan', 'パン 1 回', 'editor'],
  ['editor', 'zoom', 'ズーム 1 回', 'editor'],
  ['viewer', 'open.main', 'kdr を開く（メインスレッド）', 'viewer'],
  ['viewer', 'open.wall', 'kdr を開く（経過時間）', 'viewer'],
  ['viewer', 'summary', '選択を外して一覧を出す', 'viewer'],
  ['viewer', 'pan', 'パン 1 回', 'viewer'],
  ['viewer', 'zoom', 'ズーム 1 回', 'viewer'],
]

function lookup(result, group, key) {
  return key.split('.').reduce((value, part) => value?.[part], result[group])
}

function table(results) {
  const names = Object.keys(results)
  const lines = []
  lines.push(`| 操作 | どこで | ${names.map((name) => `${name} 中央値 / p90 (ms)`).join(' | ')} |`)
  lines.push(`| --- | --- | ${names.map(() => '---:').join(' | ')} |`)
  for (const [group, key, label, where] of LABELS) {
    const cells = names.map((name) => {
      const value = lookup(results[name], group, key)
      return value ? `${value.median} / ${value.p90}` : '-'
    })
    lines.push(`| ${label} | ${where} | ${cells.join(' | ')} |`)
  }
  const sizes = names.map((name) => {
    const { meta } = results[name]
    const o = meta.options
    return `- ${name}: ノード ${meta.totalNodes}（うち写し ${meta.copies}、レイヤーの行 ${meta.layerRows}）、深さ ${o.depth}、インスタンス ${o.instances}、画像 ${o.images}`
  })
  return [...sizes, '', ...lines].join('\n')
}

// ── 実行 ──

const started = new Date()
let chromeVersion = null
const results = {}
let browser
try {
  if (args.build) {
    console.log('ビルドしています…')
    for (const mode of ['viewer', 'editor']) {
      const build = spawnSync('npx', ['vite', 'build', ...(mode === 'editor' ? ['--mode', 'editor'] : []), '--outDir', `dist/${mode}`, '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' })
      if (build.status !== 0) throw new Error(`${mode} のビルドに失敗しました`)
    }
  }
  editorPort = String(await freePort())
  const editorUrl = serve('dist/editor', editorPort)
  const viewerUrl = serve('dist/viewer', await freePort())
  await Promise.all([waitFor(editorUrl), waitFor(viewerUrl)])
  browser = await chromium.launch({ channel: 'chrome' })
  chromeVersion = browser.version()

  for (const [name, options] of cases) {
    console.log(`\n=== ${name}: ${JSON.stringify(options)}`)
    const kdrPath = join(OUT, `${name}.kdr`)
    const meta = node('cli/bench/makeKdr.ts', [...optionArgs(options), '-o', kdrPath])
    // 書き出した kdr を本体の decodeKdr で読む（形式が変わってもここは変えずに済む）
    const document = await decodeKdr(new Blob([readFileSync(kdrPath)]))
    console.log(`ノード ${meta.totalNodes}（写し ${meta.copies}）、レイヤーの行 ${meta.layerRows}`)
    console.log('Node で純粋な関数を測っています…')
    const pure = node('cli/bench/pure.ts', optionArgs(options)).timings
    console.log('editor を測っています…')
    const editor = await benchEditor(browser, editorUrl, name, kdrPath, document, meta)
    console.log('viewer を測っています…')
    const viewer = await benchViewer(browser, viewerUrl, kdrPath, meta)
    results[name] = { meta, pure, editor, viewer }
    for (const side of [editor, viewer]) {
      if (side.errors.length > 0) console.log(`コンソールエラー: ${side.errors.join(' / ')}`)
      if (side.checks?.length > 0) console.log(`操作が狙いどおりに効いていません: ${side.checks.join(' / ')}`)
    }
  }
} finally {
  await browser?.close()
  for (const server of servers) server.kill()
}


const environment = {
  date: started.toISOString(),
  node: process.version,
  chrome: chromeVersion,
  platform: `${process.platform} ${process.arch}`,
  viewport: '1440×900、deviceScaleFactor 2',
}
const output = { environment, results }
writeFileSync(join(OUT, 'latest.json'), JSON.stringify(output, null, 2))
const markdown = `# 計測結果（${environment.date}）\n\n${table(results)}\n`
writeFileSync(join(OUT, 'latest.md'), markdown)
console.log(`\n${markdown}`)
console.log(`結果: ${join('bench/out', 'latest.json')} と ${join('bench/out', 'latest.md')}`)
