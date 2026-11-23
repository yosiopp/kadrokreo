// 書体名を CSS の font-family の値にする。書体名は kdr（信頼できない入力）から来るので、
// 総称名でないものは引用符で囲み、英数字・空白・一部の記号以外の文字は CSS のエスケープ（\hex ）にする

/** CSS の総称名。引用符で囲むと書体名の意味になってしまうので、そのまま書く */
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
])

/** 引用符の中にそのまま書いてよい文字（ASCII の英数字・空白・- _ . と、ASCII の外の文字。制御文字と U+2028/2029 は除く） */
const PLAIN = /^[A-Za-z0-9 ._\-\u00a0-\u2027\u202a-\uffff]$/u

function quoted(name: string): string {
  let out = ''
  for (const char of name) out += PLAIN.test(char) ? char : `\\${char.codePointAt(0)!.toString(16)} `
  return `"${out}"`
}

/** 前後の引用符（"…" か '…'）を外す */
function unquote(name: string): string {
  const first = name[0]
  return name.length >= 2 && (first === '"' || first === "'") && name.at(-1) === first ? name.slice(1, -1) : name
}

/**
 * 書体名（カンマで並べた候補でもよい）を font-family の値にする。
 * 例: `Noto Sans JP, sans-serif` → `"Noto Sans JP", sans-serif`
 */
export function cssFontFamily(value: string): string {
  const names = value
    .split(',')
    .map((name) => unquote(name.trim()))
    .filter((name) => name !== '')
  if (names.length === 0) return '""'
  return names.map((name) => (GENERIC_FAMILIES.has(name.toLowerCase()) ? name.toLowerCase() : quoted(name))).join(', ')
}
