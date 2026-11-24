// 単体テスト（Node で動く）が使う node:zlib の Brotli の圧縮の型。アプリの型の設定には Node の型を入れていないので、テストが使う分だけ書く。
// アプリのコードからは使わない（viewer・editor のバンドルには入らない）。

declare module 'node:zlib' {
  export const constants: {
    BROTLI_PARAM_QUALITY: number
    BROTLI_PARAM_LGWIN: number
    BROTLI_PARAM_MODE: number
    BROTLI_MODE_GENERIC: number
    BROTLI_MODE_TEXT: number
    BROTLI_MODE_FONT: number
  }
  export function brotliCompressSync(data: Uint8Array, options?: { params?: Record<number, number> }): Uint8Array
}
