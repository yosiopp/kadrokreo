import { describe, expect, it } from 'vitest'
import { COMMANDS } from './commands.ts'
import { EXAMPLES, EXAMPLE_DOCUMENT, splitExample } from './examples.ts'
import { type IO, run } from './run.ts'
import { testFontBytes } from '../src/document/testFont.ts'

// kdr help / kdr コマンド --help / kdr docs。どれもコマンドの定義から作るので、食い違いがないことと、例がそのまま動くことを確かめる

// 1×1 の PNG（add image --src photo.png の例に使う）
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#5b4cf5"/></svg>',
)

function harness(files: Map<string, Uint8Array> = new Map()) {
  const fs = new Map(files)
  let stdout = ''
  let stderr = ''
  const io: IO = {
    readFile: async (path) => {
      const data = fs.get(path)
      if (!data) throw new Error(`ENOENT: ${path}`)
      return new Uint8Array(data)
    },
    writeFile: async (path, data) => {
      fs.set(path, data)
    },
    readStdin: async () => new Uint8Array(),
    stdinIsTTY: true,
    stdoutIsTTY: false,
    stdout: (data) => {
      if (typeof data === 'string') stdout += data
    },
    stderr: (text) => {
      stderr += text
    },
  }
  return {
    fs,
    run: (argv: string[]) => run(argv, io),
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
  }
}

async function exampleFiles(): Promise<Map<string, Uint8Array>> {
  const h = harness()
  const code = await h.run(splitExample('kdr ' + EXAMPLE_DOCUMENT.join(' ')))
  expect(h.stderr).toBe('')
  expect(code).toBe(0)
  return new Map([
    ['demo.kdr', h.fs.get('demo.kdr')!],
    ['photo.png', PNG],
    ['icon.svg', SVG],
    ['font.ttf', testFontBytes()],
  ])
}

/** usage に出てくる --オプション */
const usageOptions = (usage: string) => new Set(usage.match(/--[a-z][a-z-]*/g) ?? [])

describe('kdr help / docs', () => {
  it('すべてのコマンドに例があり、例のないコマンド名はない', () => {
    for (const name of COMMANDS.keys()) expect(EXAMPLES[name]?.length ?? 0, name).toBeGreaterThan(0)
    for (const name of Object.keys(EXAMPLES)) expect(COMMANDS.has(name), name).toBe(true)
  })

  it('kdr help コマンド と kdr コマンド --help が同じで、usage・summary・例を出す', async () => {
    for (const [name, command] of COMMANDS) {
      const a = harness()
      expect(await a.run(['help', name])).toBe(0)
      const b = harness()
      expect(await b.run([name, '--help'])).toBe(0)
      expect(b.stdout).toBe(a.stdout)
      expect(a.stdout.startsWith(`kdr ${command.usage}\n`), name).toBe(true)
      expect(a.stdout).toContain(command.summary)
      for (const example of EXAMPLES[name]) expect(a.stdout).toContain(example)
    }
  })

  it('全体のヘルプと docs に、すべてのコマンドの usage と summary が載る', async () => {
    const overview = harness()
    expect(await overview.run(['--help'])).toBe(0)
    const docs = harness()
    expect(await docs.run(['docs'])).toBe(0)
    expect(docs.stdout).toMatch(/^# kdr リファレンス/)
    for (const command of COMMANDS.values()) {
      expect(overview.stdout).toContain(command.usage)
      expect(overview.stdout).toContain(command.summary)
      expect(docs.stdout).toContain(`#### ${command.name}\n\n\`\`\`\nkdr ${command.usage}\n\`\`\``)
      expect(docs.stdout).toContain(command.summary)
    }
    expect(overview.stdout).toContain('kdr docs')
  })

  it('docs は Docker 越しの呼び方・終了コード・JSON の出力を説明する', async () => {
    const h = harness()
    await h.run(['docs'])
    for (const text of ['-v "$PWD:/work"', '--user "$(id -u):$(id -g)"', '`-t` は付けない', 'ghcr.io/yosiopp/kadrokreo kdr', 'ls --json', '`2` 使い方の誤り', 'png']) {
      expect(h.stdout).toContain(text)
    }
  })

  it('docs と help docs は入力を読まずに出し、引数は取らない', async () => {
    const h = harness()
    expect(await h.run(['help', 'docs'])).toBe(0)
    expect(h.stdout).toMatch(/^kdr docs\n/)
    const bad = harness()
    expect(await bad.run(['docs', 'extra'])).toBe(2)
    expect(await bad.run(['docs', '+', 'info'])).toBe(2)
    const unknown = harness()
    expect(await unknown.run(['help', 'nope'])).toBe(2)
  })

  it('例の --オプションは、そのコマンドの usage に載っている', () => {
    for (const examples of Object.values(EXAMPLES)) {
      for (const example of examples) {
        // + で区切った各コマンドについて調べる（-f / -o / -w は全体のオプション）
        const argv = splitExample(example).filter((arg, i, all) => !['-f', '-o'].includes(all[i - 1]) && !['-f', '-o', '-w'].includes(arg))
        let current: string | null = null
        for (const arg of argv) {
          if (current === null) current = arg
          else if (arg === '+') current = null
          else if (arg.startsWith('--')) {
            const key = arg.split('=')[0]
            expect(usageOptions(COMMANDS.get(current)!.usage).has(key), `${example}: ${current} ${key}`).toBe(true)
          }
        }
      }
    }
  })

  it('すべての例が、例のドキュメントに対してそのまま動く', async () => {
    const files = await exampleFiles()
    const failures: string[] = []
    for (const examples of Object.values(EXAMPLES)) {
      for (const example of examples) {
        const h = harness(files)
        const code = await h.run(splitExample(example))
        if (code !== 0) failures.push(`${example}\n${h.stderr}`)
      }
    }
    expect(failures.join('\n')).toBe('')
  }, 60_000)

  it('例の書き方を分ける', () => {
    expect(splitExample('kdr -f a.kdr set Box fill=#ff0000 text="こんにちは 世界"   # 説明')).toEqual([
      '-f',
      'a.kdr',
      'set',
      'Box',
      'fill=#ff0000',
      'text=こんにちは 世界',
    ])
    expect(() => splitExample('kdr new | kdr ls')).toThrow()
  })
})
