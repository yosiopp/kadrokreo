import { KDR_VERSION, KdrError, decodeKdr } from '../src/document/kdr.ts'
import { encodeKdr } from '../src/editor/exportKdr.ts'
import { createDocument } from '../src/editor/operations.ts'
import { UsageError, parseArgs } from './args.ts'
import { COMMANDS, type Command } from './commands.ts'
import { Session } from './session.ts'

// コマンドラインの本体。入出力は IO に任せるので、テストではメモリ上で動かせる。
//
// 入力: 先頭が new なら新しいドキュメント。そうでなければ -f のファイル、なければ標準入力（端末でないとき）。
// 出力: -o のファイル（'-' は標準出力）か、-w なら入力のファイル。どちらもなければ、
//       ドキュメントを変えたときだけ標準出力へ（端末なら書き出さずにエラー）。
// コマンドの文字の出力（ls など）は標準出力へ。kdr と同時に標準出力へは出せない。

export type IO = {
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>
  writeFile: (path: string, data: Uint8Array) => Promise<void>
  readStdin: () => Promise<Uint8Array<ArrayBuffer>>
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
  stdout: (data: string | Uint8Array) => void
  stderr: (text: string) => void
}

export async function run(argv: readonly string[], io: IO): Promise<number> {
  try {
    await execute(argv, io)
    return 0
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`kdr: ${error.message}\n（使い方は kdr --help）\n`)
      return 2
    }
    if (error instanceof KdrError) {
      io.stderr(`kdr: ${error.message}\n`)
      return 1
    }
    const message = error instanceof Error ? error.message : String(error)
    io.stderr(`kdr: ${message}\n`)
    return 1
  }
}

async function execute(argv: readonly string[], io: IO): Promise<void> {
  const { global, steps } = parseArgs(argv, (name) => ({
    flags: new Set(COMMANDS.get(name)?.flags ?? []),
    assignments: COMMANDS.get(name)?.assignments === true,
  }))
  if (global.version) {
    io.stdout(`kdr（kadrokreo のコマンドライン、kdr ファイル v${KDR_VERSION}）\n`)
    return
  }
  // コマンドなしで -f と -o だけなら、読んで書き直す（古い版の kdr を今の版にする）
  const convert = steps.length === 0 && global.file !== null && global.out !== null
  if (global.help || (steps.length === 0 && !convert) || steps[0]?.name === 'help') {
    io.stdout(help(steps[0]?.name === 'help' ? steps[0].positionals[0] : undefined))
    return
  }

  const commands = steps.map((step) => {
    const command = COMMANDS.get(step.name)
    if (!command) throw new UsageError(`不明なコマンドです: ${step.name}`)
    return command
  })
  const plan = convert ? { source: false } : checkPlan(commands, global, io)

  // new は、ここで作った空のドキュメントを置き換える
  const session = new Session(
    plan.source ? createDocument() : await decodeKdr(new Blob([await readInput(global.file, io)])),
  )

  const output: string[] = []
  const ctx = { session, print: (text: string) => output.push(text), readFile: io.readFile }
  for (const [i, step] of steps.entries()) {
    try {
      await commands[i].run(ctx, step)
    } catch (error) {
      if (error instanceof UsageError || error instanceof KdrError) {
        error.message = `${step.name}: ${error.message.replace(new RegExp(`^${step.name}: `), '')}`
      }
      throw error
    }
  }
  if (output.length > 0) io.stdout(output.join('\n') + '\n')

  const destination = global.out ?? (global.write ? global.file : session.modified ? '-' : null)
  if (destination === null) return
  const bytes = new Uint8Array(await (await encodeKdr(session.document)).arrayBuffer())
  if (destination === '-') io.stdout(bytes)
  else await io.writeFile(destination, bytes)
}

/** 実行する前に、入出力の組み合わせがおかしくないかを確かめる */
function checkPlan(commands: readonly Command[], global: { file: string | null; out: string | null; write: boolean }, io: IO) {
  const source = commands[0].kind === 'source'
  if (commands.slice(1).some((command) => command.kind === 'source')) {
    throw new UsageError('new はコマンドの先頭にだけ置けます')
  }
  if (source && global.file !== null) throw new UsageError('new と -f は一緒に指定できません')
  if (global.write) {
    if (global.out !== null) throw new UsageError('-o と -w は一緒に指定できません')
    if (global.file === null || global.file === '-') throw new UsageError('-w には -f で入力のファイルを指定してください')
  }
  if (!source && global.file === null && io.stdinIsTTY) {
    throw new UsageError('入力の kdr がありません。-f で指定するか、標準入力へ渡してください')
  }
  const edits = source || commands.some((command) => command.kind === 'edit')
  const queries = commands.some((command) => command.kind === 'query')
  const toStdout = global.out === '-' || (global.out === null && !global.write && edits)
  if (toStdout && queries) {
    throw new UsageError('kdr と文字の出力が、どちらも標準出力になります。-o で kdr の出力先を指定してください')
  }
  if (toStdout && io.stdoutIsTTY) {
    throw new UsageError('kdr を端末には出力しません。-o で出力先を指定するか（-w で上書き）、パイプでつないでください')
  }
  return { source }
}

async function readInput(file: string | null, io: IO): Promise<Uint8Array<ArrayBuffer>> {
  return file === null || file === '-' ? io.readStdin() : io.readFile(file)
}

export function help(name?: string): string {
  if (name !== undefined) {
    const command = COMMANDS.get(name)
    if (!command) throw new UsageError(`不明なコマンドです: ${name}`)
    return `kdr ${command.usage}\n\n${command.summary}\n`
  }
  const groups: [string, Command['kind'][]][] = [
    ['作る', ['source']],
    ['調べる（標準出力へ）', ['query']],
    ['ページ', ['nav']],
    ['変える', ['edit']],
  ]
  const lines = [
    'kdr — kadrokreo の kdr ファイルをコマンドラインで調べ、編集する（kadrokreo という名前でも動く）',
    '',
    '使い方:',
    '  kdr [-f 入力.kdr] [-o 出力.kdr | -w] コマンド 引数… [+ コマンド 引数…]…',
    '',
    '  -f, --file   入力の kdr（- は標準入力。省略すると標準入力）',
    '  -o, --out    出力の kdr（- は標準出力）。指定すると変えていなくても書き出す（古い版の更新に使える）',
    '  -w, --write  入力のファイルへ上書きする',
    '  +            コマンドの区切り。左から順に実行する',
    '',
    '  ドキュメントを変えたのに -o も -w もなければ、kdr を標準出力へ出すので、パイプでつなげられる:',
    '    kdr new Demo | kdr add rect --name Box | kdr set Box fill=#ff0000 -o demo.kdr',
    '',
    'ノードの指定: id、レイヤー名、「親/子」の道筋、@（直前に作ったノード）',
    '',
  ]
  for (const [title, kinds] of groups) {
    lines.push(`${title}:`)
    for (const command of COMMANDS.values()) {
      if (!kinds.includes(command.kind)) continue
      lines.push(`  ${command.usage}`, `      ${command.summary}`)
    }
    lines.push('')
  }
  lines.push('kdr help コマンド で、1 つのコマンドの説明を出す')
  return lines.join('\n') + '\n'
}
