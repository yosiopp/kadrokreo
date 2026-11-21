// コマンドラインの解釈。
//   kadrokreo [-f 入力] [-o 出力 | -w] コマンド 引数… [+ コマンド 引数…]…
// 「+」だけの引数でコマンドを区切る。-f / -o / -w / -h はどの位置にあってもよい。

export class UsageError extends Error {
  override name = 'UsageError'
}

export type Global = {
  /** 入力の kdr。'-' は標準入力 */
  file: string | null
  /** 出力の kdr。'-' は標準出力 */
  out: string | null
  /** 入力のファイルへ書き戻す */
  write: boolean
  help: boolean
  version: boolean
}

/** 1 つのコマンド。options は --名前（値なしは true）、assignments は 名前=値 */
export type Step = {
  name: string
  positionals: string[]
  options: Map<string, string | true>
  assignments: [string, string][]
}

/**
 * コマンドごとの引数の読み方。flags は値を取らない --オプション、assignments は「名前=値」を受け付けるか。
 * 'any' なら名前に英字以外（バリアントのプロパティ名の日本語など）も使える
 */
export type Spec = { flags: ReadonlySet<string>; assignments: boolean | 'any' }

export function parseArgs(argv: readonly string[], spec: (command: string) => Spec): {
  global: Global
  steps: Step[]
} {
  const global: Global = { file: null, out: null, write: false, help: false, version: false }
  const segments: string[][] = [[]]
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new UsageError(`${arg} の値がありません`)
      return next
    }
    if (arg === '-f' || arg === '--file') global.file = value()
    else if (arg === '-o' || arg === '--out') global.out = value()
    else if (arg === '-w' || arg === '--write') global.write = true
    else if (arg === '-h' || arg === '--help') global.help = true
    else if (arg === '--version') global.version = true
    else if (arg === '+') segments.push([])
    else segments.at(-1)!.push(arg)
  }
  const steps = segments.filter((segment, i) => segment.length > 0 || i > 0).map((segment) => parseStep(segment, spec))
  return { global, steps }
}

function parseStep(tokens: readonly string[], spec: (command: string) => Spec): Step {
  const [name, ...rest] = tokens
  if (name === undefined) throw new UsageError('「+」の後にコマンドがありません')
  if (name.startsWith('-')) throw new UsageError(`コマンドの前に不明なオプションがあります: ${name}`)
  const { flags: booleans, assignments } = spec(name)
  const step: Step = { name, positionals: [], options: new Map(), assignments: [] }
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (token.startsWith('--') && token.length > 2) {
      const eq = token.indexOf('=')
      const key = eq === -1 ? token.slice(2) : token.slice(2, eq)
      if (eq !== -1) step.options.set(key, token.slice(eq + 1))
      else if (booleans.has(key)) step.options.set(key, true)
      else {
        const next = rest[++i]
        if (next === undefined) throw new UsageError(`${name}: --${key} の値がありません`)
        step.options.set(key, next)
      }
      continue
    }
    const eq = token.indexOf('=')
    // 「名前=値」。名前は英字で始まり、英数字と . だけ（'any' なら , を含まない何でも）。受け付けないコマンドでは、ただの引数
    const key = token.slice(0, eq)
    if (assignments && eq > 0 && (assignments === 'any' ? !key.includes(',') : /^[A-Za-z][A-Za-z0-9.]*$/.test(key))) {
      step.assignments.push([token.slice(0, eq), token.slice(eq + 1)])
      continue
    }
    step.positionals.push(token)
  }
  return step
}
