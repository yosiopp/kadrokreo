const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

// 実装の部品: editor の「実装の部品」で元に部品名・import の場所・props の読み替えを書き、kdr に入ること、
// viewer の React・Vue のコードでインスタンスが部品の呼び出しと import になり、インスペクトに部品が出ること
const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors, savedDocument, fieldFinder, rowFinder } = require('./harness.cjs')

const sourcePath = path.join(OUT, 'code-component-source.kdr')
const cli = (...args) => execFileSync('node', [path.join(__dirname, '..', 'cli', 'kadrokreo.ts'), ...args], { encoding: 'utf8' })
cli(
  ...('new Demo + add frame --name Button --id btn --width 120 --height 40 fill=#5b4cf5' +
    ' + add text --parent btn --name Label --id label --text OK + component btn + prop-add btn text label --name 文言' +
    ' + add frame --name Screen --id screen --x 200 --width 300 --height 200 fill=#ffffff' +
    ' + instance btn --parent screen --id b1 --x 20 --y 30 + prop b1').split(' '),
  '文言=予約する',
  '-o', sourcePath,
)

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  await page.locator('input[type=file][accept^=".kdr"]').setInputFiles(sourcePath)
  await page.waitForTimeout(500)
  const field = fieldFinder(page, { scope: '.properties-panel' })
  const set = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Enter') }
  // 元の行（レイヤー一覧は前面が上なので、後に置いた Screen の中のインスタンスより下にある）
  const mainRow = () => rowFinder(page, { originals: true })('Button').last()
  const mainOf = async () => {
    await page.waitForTimeout(700)
    return Object.values((await savedDocument(page)).pages[0].nodes).find((n) => n.name === 'Button' && n.component?.role === 'main')
  }

  // ── editor: 元に実装の部品を書く ──
  await mainRow().click()
  check('元を選ぶと「実装の部品」の欄が出る', (await page.locator('.properties-panel .code-component').count()) === 1)
  check('部品名を書く前は、import の場所の欄が出ない', (await field('import の場所').count()) === 0)
  await set('部品名', 'Button')
  await set('import の場所', '@/ui')
  check('props の名前を書かなければ、名前から作れない（日本語の）プロパティは空', (await field('文言 →').inputValue()) === '')
  await set('文言 →', 'children')
  let main = await mainOf()
  check('部品名・import の場所・読み替えが元に入る',
    JSON.stringify(main.component.code) === JSON.stringify({ name: 'Button', from: '@/ui', defaultExport: false, props: [{ property: '文言', prop: 'children', values: {} }] }),
    JSON.stringify(main.component.code))
  await set('部品名', '1x')
  main = await mainOf()
  check('部品名の形でない名前は入らない', main.component.code.name === 'Button', main.component.code.name)

  // ── viewer: コードで部品の呼び出しになる ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'code-component.kdr')
  await download.saveAs(kdrPath)
  const json = await require('./kdr.cjs').parseKdrBytes(fs.readFileSync(kdrPath))
  check('kdr に実装の部品が入る', JSON.stringify(json.raw).includes('"code":{"name":"Button","from":"@/ui","props":[{"property":"文言","prop":"children"}]}'))
  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  const panel = viewer.locator('.inspect-panel')
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Screen"))').click()
  await panel.locator('select[aria-label="コードの形式"]').selectOption('react')
  const jsx = await panel.locator('section[aria-label="JSX"] pre').textContent()
  check('React のコードで、インスタンスが部品の呼び出しと import になる',
    jsx.startsWith("import { Button } from '@/ui'") && jsx.includes('<Button>') && jsx.includes('予約する') && !jsx.includes('OK'), jsx)
  check('置き方は div で包む', /<div style=\{\{ position: 'absolute', left: 20, top: 30 \}\}>\s*<Button>/.test(jsx), jsx)
  await panel.locator('select[aria-label="コードの形式"]').selectOption('vue')
  const vue = await panel.locator('section[aria-label="Vue"] pre').textContent()
  check('Vue では <script setup> に import を書く', vue.startsWith("<script setup>\nimport { Button } from '@/ui'\n</script>") && vue.includes('<Button>'), vue)
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Button"))').last().click()
  const inspect = await panel.textContent()
  check('元を選ぶと、インスペクトに実装の部品が出る', inspect.includes('種類元') && inspect.includes('実装の部品Button（@/ui）'), inspect.slice(0, 400))

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
