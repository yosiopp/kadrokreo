// コードの出力形式（HTML + CSS、React の style、React の CSS Modules、Tailwind のクラス、Vue の単一ファイルコンポーネント）。
// どの形式も、もとは nodeCss が出す CSS の宣言で、それを各形式の書き方に直す。値は変えない。

export type CodeFormat = 'html' | 'react' | 'css-modules' | 'tailwind' | 'vue'

export const CODE_FORMAT_LABELS: Record<CodeFormat, string> = {
  html: 'HTML + CSS',
  react: 'React（style）',
  'css-modules': 'React（CSS Modules）',
  tailwind: 'React（Tailwind）',
  vue: 'Vue（SFC）',
}

export type Declaration = [property: string, value: string]

/** nodeCss の出力（1 行に 1 つの「プロパティ: 値;」）を宣言の並びにする */
export function parseDeclarations(css: string): Declaration[] {
  return css
    .split('\n')
    .map((line) => line.trim().replace(/;$/, ''))
    .filter((line) => line !== '')
    .map((line) => {
      const colon = line.indexOf(':')
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]
    })
}

/** CSS のプロパティ名を、React の style のキーにする（-webkit-x は WebkitX） */
export function camelProperty(property: string): string {
  return property.replace(/^-(\w)/, (_, first: string) => first.toUpperCase()).replace(/-(\w)/g, (_, c: string) => c.toUpperCase())
}

/** React の style の値。px の長さと単位のない数は数値（React が px を補う）、ほかは文字列 */
function styleValue(value: string): string {
  const match = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(value)
  if (match) return match[1]
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** React の style に渡すオブジェクト。multiline なら 1 行に 1 つ（パネルで読む用） */
export function jsxStyle(declarations: readonly Declaration[], multiline = false): string {
  const entries = declarations.map(([property, value]) => `${camelProperty(property)}: ${styleValue(value)}`)
  if (entries.length === 0) return '{}'
  return multiline ? `{\n${entries.map((entry) => `  ${entry},`).join('\n')}\n}` : `{ ${entries.join(', ')} }`
}

/** Tailwind の任意の値 [..] の中身。空白は _、もとの _ は \_ にする */
function arbitrary(value: string): string {
  return value.replace(/_/g, '\\_').replace(/\s+/g, '_')
}

const FLEX_ALIGN: Record<string, string> = { 'flex-start': 'start', center: 'center', 'flex-end': 'end', 'space-between': 'between' }

/** 1 つの色だけの値か（グラデーションや重ねた塗りでない） */
function isSingleColor(value: string): boolean {
  return /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([^()]*\)|transparent)$/i.test(value)
}

/** 宣言 1 つを Tailwind のクラスにする。決まったクラスがなければ任意のプロパティ [prop:value] で書く */
function tailwindClass([property, value]: Declaration): string[] {
  const sized = (prefix: string) => [`${prefix}-[${arbitrary(value)}]`]
  switch (property) {
    case 'position':
      if (value === 'absolute' || value === 'relative') return [value]
      break
    case 'display':
      if (value === 'flex') return ['flex']
      break
    case 'flex-direction':
      if (value === 'row') return ['flex-row']
      if (value === 'column') return ['flex-col']
      break
    case 'flex-wrap':
      if (value === 'wrap') return ['flex-wrap']
      break
    case 'align-items':
      if (value in FLEX_ALIGN && value !== 'space-between') return [`items-${FLEX_ALIGN[value]}`]
      break
    case 'align-content':
      if (value in FLEX_ALIGN) return [`content-${FLEX_ALIGN[value]}`]
      break
    case 'justify-content':
      if (value in FLEX_ALIGN) return [`justify-${FLEX_ALIGN[value]}`]
      break
    case 'align-self':
      if (value === 'stretch') return ['self-stretch']
      break
    case 'flex':
      return sized('flex')
    case 'gap': {
      const parts = value.split(/\s+/)
      return parts.length === 2 ? [`gap-y-[${parts[0]}]`, `gap-x-[${parts[1]}]`] : sized('gap')
    }
    case 'padding': {
      const parts = value.split(/\s+/)
      if (parts.length === 1) return sized('p')
      if (parts.length === 2) return [`py-[${parts[0]}]`, `px-[${parts[1]}]`]
      if (parts.length === 4) return ['pt', 'pr', 'pb', 'pl'].map((prefix, i) => `${prefix}-[${parts[i]}]`)
      break
    }
    case 'left':
    case 'top':
    case 'right':
    case 'bottom':
      return sized(property)
    case 'width':
      return value === 'max-content' ? ['w-max'] : sized('w')
    case 'height':
      return sized('h')
    case 'min-width':
      return sized('min-w')
    case 'max-width':
      return sized('max-w')
    case 'min-height':
      return sized('min-h')
    case 'max-height':
      return sized('max-h')
    case 'transform': {
      const match = /^rotate\(([^()]+)\)$/.exec(value)
      if (match) return [`rotate-[${match[1]}]`]
      break
    }
    case 'opacity':
      return sized('opacity')
    case 'background':
      if (isSingleColor(value)) return sized('bg')
      break
    case 'background-clip':
      if (value === 'text') return ['bg-clip-text']
      break
    case 'color':
      return value === 'transparent' ? ['text-transparent'] : sized('text')
    case 'font-size':
      return sized('text')
    case 'font-weight':
      return sized('font')
    case 'line-height':
      return sized('leading')
    case 'text-align':
      return [`text-${value}`]
    case 'white-space':
      if (value === 'nowrap') return ['whitespace-nowrap']
      break
    case 'object-fit':
      return [`object-${value}`]
    case 'border-radius':
      return value === '50%' ? ['rounded-full'] : sized('rounded')
    case 'box-shadow':
      return sized('shadow')
    case 'mix-blend-mode':
      return [`mix-blend-${value}`]
    case 'background-blend-mode':
      if (!value.includes(',')) return [`bg-blend-${value}`]
      break
    case 'overflow':
      if (value === 'hidden' || value === 'visible') return [`overflow-${value}`]
      break
  }
  return [`[${property}:${arbitrary(value)}]`]
}

/** 宣言の並びを Tailwind のクラスの並びにする */
export function tailwindClasses(declarations: readonly Declaration[]): string[] {
  return declarations.flatMap(tailwindClass)
}

/** クラス名（kebab-case）を CSS Modules で styles.名前 と書ける名前にする */
export function camelClass(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

/** クラス名（kebab-case）から React のコンポーネント名を作る。使えなければ Component */
export function componentName(kebab: string): string {
  const name = kebab
    .split('-')
    .filter((word) => word !== '')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join('')
  return /^[A-Z]/.test(name) ? name : 'Component'
}
