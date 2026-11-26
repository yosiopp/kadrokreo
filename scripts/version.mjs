// 版の表記を確かめる・書き換える。
//   node scripts/version.mjs check            版を書いている場所が全部同じか（npm run check:version、npm run check の中でも流れる）
//   node scripts/version.mjs check v1.2.3     それに加えて、タグ（先頭の v を除いたもの）とも同じか（CI がタグの push のときに流す）
//   node scripts/version.mjs set 1.2.3        版を書いている場所を全部書き換える（タグを打つ前に。CONTRIBUTING.md「リリースの手順」）
// 版は 1 つで、リリースのタグ vX.Y.Z と同じ。書いている場所は下の PLACES。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 版を書いている場所。get は JSON から版を取り出し、set は書き換える
 * @type {{ file: string, label: string, get: (json: any) => unknown, set: (json: any, version: string) => void }[]}
 */
const PLACES = [
  {
    file: 'package.json',
    label: 'version',
    get: (json) => json.version,
    set: (json, version) => {
      json.version = version
    },
  },
  {
    file: 'package-lock.json',
    label: 'version',
    get: (json) => json.version,
    set: (json, version) => {
      json.version = version
    },
  },
  {
    file: 'package-lock.json',
    label: 'packages[""].version',
    get: (json) => json.packages?.['']?.version,
    set: (json, version) => {
      json.packages[''].version = version
    },
  },
  {
    file: '.claude-plugin/marketplace.json',
    label: 'plugins の kdr の version',
    get: (json) => json.plugins?.find((plugin) => plugin.name === 'kdr')?.version,
    set: (json, version) => {
      json.plugins.find((plugin) => plugin.name === 'kdr').version = version
    },
  },
]

// 1.2.3 か、プレリリースの 1.2.3-rc.1
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** @param {string} file */
const read = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'))

function usage() {
  console.error('使い方: node scripts/version.mjs check [vX.Y.Z] | set X.Y.Z')
  process.exit(2)
}

const [command, arg] = process.argv.slice(2)

if (command === 'check') {
  if (arg !== undefined && !(arg.startsWith('v') && VERSION.test(arg.slice(1)))) {
    console.error(`タグは vX.Y.Z の形にしてください: ${arg}`)
    process.exit(1)
  }
  const found = PLACES.map((place) => ({ ...place, version: place.get(read(place.file)) }))
  const expected = arg === undefined ? found[0].version : arg.slice(1)
  const wrong = found.filter((place) => place.version !== expected || !VERSION.test(String(place.version)))
  if (wrong.length > 0) {
    console.error(arg === undefined ? '版の表記が揃っていません:' : `版の表記がタグ ${arg} と揃っていません:`)
    for (const place of found) console.error(`  ${place.file} の ${place.label}: ${place.version}`)
    console.error(`揃えるには: node scripts/version.mjs set ${arg === undefined ? 'X.Y.Z' : expected}`)
    process.exit(1)
  }
  console.log(`版の表記は ${expected} で揃っています${arg === undefined ? '' : `（タグ ${arg} とも同じ）`}`)
} else if (command === 'set') {
  if (arg === undefined || !VERSION.test(arg)) usage()
  for (const file of new Set(PLACES.map((place) => place.file))) {
    const json = read(file)
    for (const place of PLACES) if (place.file === file) place.set(json, arg)
    writeFileSync(join(root, file), `${JSON.stringify(json, null, 2)}\n`)
  }
  console.log(`版を ${arg} にしました（${[...new Set(PLACES.map((place) => place.file))].join('・')}）`)
} else {
  usage()
}
