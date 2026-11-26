// テスト用: 壊れた入力を乱数で作って、デコーダに大量に与える道具（ファズテスト）。
// 乱数は種を固定した自前のもの（mulberry32）で、ケースごとに種を 1 ずつ変える。落ちたケースは種の番号だけで同じ入力を作り直せる
// （fuzz の only にその番号を渡すと、その 1 件だけを流す）。
// 同期の処理が終わらなくなると、テストは時間切れにもならず止まったままになる。そのときは only で種を 1 つずつ試して探す。

/** 種を固定した乱数。0 以上 1 未満を返す */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Random = {
  next(): number
  /** min 以上 max 以下の整数 */
  int(min: number, max: number): number
  pick<T>(list: readonly T[]): T
  chance(p: number): boolean
  bytes(length: number): Uint8Array<ArrayBuffer>
}

export function makeRandom(seed: number): Random {
  const next = mulberry32(seed)
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1))
  return {
    next,
    int,
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
    bytes: (length) => Uint8Array.from({ length }, () => int(0, 255)),
  }
}

/** 長さ・個数・位置の欄に入ると壊れやすい値 */
export const EDGE_8: readonly number[] = [0, 1, 0x7f, 0x80, 0xfe, 0xff]
export const EDGE_16: readonly number[] = [0, 1, 2, 0xff, 0x100, 0x7fff, 0x8000, 0xfffe, 0xffff]
export const EDGE_32: readonly number[] = [0, 1, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff]

function put(bytes: Uint8Array, at: number, value: number, size: number, littleEndian: boolean): void {
  for (let i = 0; i < size; i++) {
    const shift = 8 * (littleEndian ? i : size - 1 - i)
    if (at + i < bytes.length) bytes[at + i] = Math.floor(value / 2 ** shift) & 0xff
  }
}

/** 長さを変えずに、from 以上 to 未満のどこか 1 か所を壊す（ビットの反転・バイトの書き換え・欄の書き換え・範囲の塗りつぶしや写し） */
export function corrupt(random: Random, bytes: Uint8Array, from = 0, to = bytes.length): void {
  if (to <= from) return
  const at = random.int(from, to - 1)
  const kind = random.int(0, 9)
  if (kind === 0) bytes[at] ^= 1 << random.int(0, 7)
  else if (kind === 1) bytes[at] = random.int(0, 255)
  else if (kind === 2) bytes[at] = (bytes[at] + random.pick([1, 255])) & 0xff
  else if (kind === 3) bytes[at] = random.pick(EDGE_8)
  else if (kind <= 5) put(bytes, at, random.pick(EDGE_16), 2, random.chance(0.2))
  else if (kind === 6) put(bytes, at, random.pick(EDGE_32), 4, random.chance(0.2))
  else if (kind === 7) put(bytes, at, random.int(0, 0xffff), 2, false)
  else if (kind === 8) {
    const fill = random.pick([0, 0xff, -1])
    const end = Math.min(to, at + random.int(1, 8))
    for (let i = at; i < end; i++) bytes[i] = fill < 0 ? random.int(0, 255) : fill
  } else {
    // ほかの場所の中身を写す
    const length = Math.min(random.int(1, 16), to - at)
    const source = random.int(from, to - 1)
    bytes.copyWithin(at, source, Math.min(to, source + length))
  }
}

/** 写しを作って何か所か壊す。長さも変えることがある（切り詰め・削除・挿入・繰り返し） */
export function mutate(random: Random, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  let out = Uint8Array.from(bytes)
  for (let round = random.pick([1, 1, 1, 2, 3, 8]); round > 0; round--) {
    const kind = random.next()
    if (kind < 0.7 || out.length === 0) {
      corrupt(random, out)
      continue
    }
    const at = random.int(0, out.length - 1)
    const end = Math.min(out.length, at + random.int(1, 32))
    if (kind < 0.8) out = out.slice(0, at)
    else if (kind < 0.87) out = Uint8Array.from([...out.subarray(0, at), ...out.subarray(end)])
    else if (kind < 0.94) {
      const inserted = random.chance(0.5) ? random.bytes(random.int(1, 16)) : new Uint8Array(random.int(1, 16)).fill(random.pick(EDGE_8))
      out = Uint8Array.from([...out.subarray(0, at), ...inserted, ...out.subarray(at)])
    } else out = Uint8Array.from([...out.subarray(0, end), ...out.subarray(at, end), ...out.subarray(end)])
  }
  return out
}

export type FuzzOptions = {
  /** 最初のケースの種。ケースごとに 1 ずつ増える */
  seed: number
  cases: number
  /** この種の 1 件だけを流す（落ちたケースを調べるとき） */
  only?: number
  /** 1 件にかかってよい時間（ミリ秒）。処理量が入力の大きさに見合わないものを見つける */
  slowMs?: number
}

function seedsOf({ seed, cases, only }: FuzzOptions): number[] {
  return only === undefined ? Array.from({ length: cases }, (_, i) => seed + i) : [only]
}

function failure(seed: number, error: unknown): Error {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return new Error(`種 ${seed} のケースで失敗しました（fuzz の only に ${seed} を渡すと、この 1 件だけを流せます）: ${message}`, { cause: error })
}

function checkTime(seed: number, started: number, slowMs = 2000): void {
  const elapsed = performance.now() - started
  if (elapsed > slowMs) throw failure(seed, new Error(`時間がかかりすぎです（${Math.round(elapsed)}ms）`))
}

/** 種を変えながら run を cases 回流す。例外か時間のかかりすぎがあれば、種の番号を付けて失敗にする */
export function fuzz(options: FuzzOptions, run: (random: Random, seed: number) => void): void {
  for (const seed of seedsOf(options)) {
    const started = performance.now()
    try {
      run(makeRandom(seed), seed)
    } catch (error) {
      throw failure(seed, error)
    }
    checkTime(seed, started, options.slowMs)
  }
}

export async function fuzzAsync(options: FuzzOptions, run: (random: Random, seed: number) => Promise<void>): Promise<void> {
  for (const seed of seedsOf(options)) {
    const started = performance.now()
    try {
      await run(makeRandom(seed), seed)
    } catch (error) {
      throw failure(seed, error)
    }
    checkTime(seed, started, options.slowMs)
  }
}

/**
 * run が投げてよいのは、expected が認めた例外だけ。認めた例外なら undefined を返し、ほかの例外（TypeError・RangeError など、
 * 想定していない終わり方）はそのまま投げる
 */
export function allowThrow<T>(run: () => T, expected: (error: unknown) => boolean): T | undefined {
  try {
    return run()
  } catch (error) {
    if (expected(error)) return undefined
    throw error
  }
}

/** Error そのもの（TypeError などの派生でない）で、メッセージが prefix で始まる例外か */
export function plainError(prefix: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && error.constructor === Error && error.message.startsWith(prefix)
}

/** 下位のビットから詰めるビット列（deflate・Brotli の並び）を書く */
export class BitWriter {
  private readonly out: number[] = []
  private current = 0
  private count = 0
  write(value: number, bits: number): this {
    for (let i = 0; i < bits; i++) {
      this.current |= ((value >>> i) & 1) << this.count
      if (++this.count === 8) this.flush()
    }
    return this
  }
  /** バイトの境目まで 0 で埋める */
  flush(): this {
    if (this.count > 0) this.out.push(this.current)
    this.current = 0
    this.count = 0
    return this
  }
  bytes(): Uint8Array<ArrayBuffer> {
    this.flush()
    return Uint8Array.from(this.out)
  }
}
