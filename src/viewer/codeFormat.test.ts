import { describe, expect, it } from 'vitest'
import { camelClass, camelProperty, componentName, jsxStyle, parseDeclarations, tailwindClasses } from './codeFormat.ts'

describe('parseDeclarations', () => {
  it('1 行 1 つの宣言を分ける。値の中の : はそのまま', () => {
    expect(parseDeclarations('position: absolute;\nbackground: url(a:b);')).toEqual([
      ['position', 'absolute'],
      ['background', 'url(a:b)'],
    ])
  })
})

describe('jsxStyle', () => {
  it('キーを camelCase にし、px と単位のない数は数値、ほかは文字列', () => {
    expect(camelProperty('-webkit-background-clip')).toBe('WebkitBackgroundClip')
    expect(
      jsxStyle([
        ['left', '-4.5px'],
        ['line-height', '1.2'],
        ['width', '2rem'],
        ['font-family', "Rock 'n' Roll"],
      ]),
    ).toBe("{ left: -4.5, lineHeight: 1.2, width: '2rem', fontFamily: 'Rock \\'n\\' Roll' }")
    expect(jsxStyle([])).toBe('{}')
  })
})

describe('tailwindClasses', () => {
  it('決まったクラスがあればそれを使い、値は任意の値 [..] で書く', () => {
    expect(
      tailwindClasses(
        parseDeclarations(
          [
            'display: flex;',
            'flex-direction: column;',
            'align-items: center;',
            'justify-content: space-between;',
            'gap: 8px 4px;',
            'padding: 1px 2px 3px 4px;',
            'transform: rotate(30deg);',
            'border-radius: 50%;',
            'color: rgb(1, 2, 3);',
            'text-align: center;',
          ].join('\n'),
        ),
      ),
    ).toEqual([
      'flex',
      'flex-col',
      'items-center',
      'justify-between',
      'gap-y-[8px]',
      'gap-x-[4px]',
      'pt-[1px]',
      'pr-[2px]',
      'pb-[3px]',
      'pl-[4px]',
      'rotate-[30deg]',
      'rounded-full',
      'text-[rgb(1,_2,_3)]',
      'text-center',
    ])
  })

  it('親の辺への固定は right / bottom と calc、テキストの上限つきの幅は w-max', () => {
    expect(
      tailwindClasses(parseDeclarations(['right: 20px;', 'bottom: 0;', 'left: calc(50% - 20px);', 'width: max-content;'].join('\n'))),
    ).toEqual(['right-[20px]', 'bottom-[0]', 'left-[calc(50%_-_20px)]', 'w-max'])
  })

  it('書体名の引用符は、className の中で閉じないよう \' にする', () => {
    expect(tailwindClasses([['font-family', '"My Font", sans-serif']])).toEqual(["[font-family:'My_Font',_sans-serif]"])
    expect(tailwindClasses([['font-family', '"a\\22 b"']])).toEqual(["[font-family:'a\\22_b']"])
  })

  it('グラデーションや決まったクラスのないものは、任意のプロパティで書く。_ は \\_ にする', () => {
    expect(
      tailwindClasses([
        ['background', 'linear-gradient(90deg, #000000 0%, #ffffff 100%)'],
        ['font-family', 'My_Font'],
        ['box-shadow', '0 2px 4px rgba(0, 0, 0, 0.25)'],
      ]),
    ).toEqual([
      '[background:linear-gradient(90deg,_#000000_0%,_#ffffff_100%)]',
      '[font-family:My\\_Font]',
      'shadow-[0_2px_4px_rgba(0,_0,_0,_0.25)]',
    ])
  })
})

describe('名前', () => {
  it('クラス名を CSS Modules とコンポーネントの名前にする', () => {
    expect(camelClass('icon-2')).toBe('icon2')
    expect(camelClass('primary-button')).toBe('primaryButton')
    expect(componentName('primary-button')).toBe('PrimaryButton')
    expect(componentName('n-1')).toBe('N1')
    expect(componentName('')).toBe('Component')
  })
})
