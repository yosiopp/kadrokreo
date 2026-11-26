# 開発する人へ

kadrokreo の開発環境と、変更を入れる前の確認の流し方。使い方はユーザーズガイド [`docs/guide/`](docs/guide/README.md) にある。
リポジトリは https://github.com/yosiopp/kadrokreo 、不具合の報告や提案は [Issues](https://github.com/yosiopp/kadrokreo/issues) へ。

## 用意するもの

- Node.js 24（Dockerfile と CI に合わせている）
- Google Chrome（e2e・キャプチャ・性能の計測が、インストール済みの Chrome を Playwright で操作する）
- Docker（イメージを試すときだけ）

## コマンド

```sh
npm install
npm run dev          # viewer（http://localhost:5173）
npm run dev:editor   # editor（開発用。配布するイメージでは --editor を付けたときだけ）
npm test             # 単体テスト（vitest）
npm run lint         # oxlint
npm run build        # tsc -b のあと dist/viewer と dist/editor を出力
npm run e2e          # ブラウザでの動作確認（開発サーバーを自動で立てる。Google Chrome が必要）
npm run e2e -- 05-style   # 1 本だけ
npm run check        # 下の「確認」をまとめて流す
npm run capture      # サンプルのデザインを組み立てて画面のキャプチャを e2e/out/captures/ に撮る
npm run bench        # 大きなデザインでの性能を測る（結果は bench/out/）
npm run kdr -- --help   # コマンドライン（npm link すれば kdr --help）
```

## 確認

変更したら `npm run check` を通す。中身は次の順で、落ちたらそこで止まる（e2e を含むので数分かかる）。

1. `npm test` — 単体テスト
2. `npm run lint` — oxlint（依存の向きの決まりもここで確かめる。警告も失敗にする。意図して残すものは、その行だけ理由を添えて無効にする）
3. `npm run build` — 型検査と viewer・editor のビルド
4. `npm run check:viewer` — `dist/viewer` に editor にしかない文言・API が入っていないか（`scripts/check-viewer.mjs`）
5. `npm run e2e` — ブラウザでの動作確認（`e2e/` のスクリプトを番号順に。`01` が書き出した kdr を `02` が使う）。スクリーンショットは `e2e/out/`

`npm run capture` と `npm run bench` は `check` に入れていない。性能の計測の結果の控えは [`docs/bench/`](docs/bench/) にある。

単体テストには、種を固定した乱数で壊れた入力を作るファズテストが入っている（kdr 全体は `src/editor/kdrFuzz.test.ts`、圧縮・tar・画像の見出しは `src/document/decoderFuzz.test.ts`、書体は `src/document/fontFuzz.test.ts`）。
後ろの 2 つは、落ちるとメッセージに種の番号が出る。`fuzz` の `only` にその番号を渡すと、その 1 件だけを流せる（道具は `src/document/testFuzz.ts`）。

viewer で開くサンプル `docs/examples/sample.kdr` が元の `docs/examples/sample.xml` とずれると（マークアップを書き換えた、kdr の形式を変えた）、単体テストが知らせる。
`./cli/kadrokreo.ts build docs/examples/sample.xml -o docs/examples/sample.kdr` で作り直して一緒に入れる。

## ソースからイメージをビルドする

公開しているイメージ（`ghcr.io/yosiopp/kadrokreo`）の代わりに、手元のソースからビルドしたイメージも同じように使える。

```sh
git clone https://github.com/yosiopp/kadrokreo.git
cd kadrokreo
docker build -t kadrokreo .

docker run --rm -p 8080:80 kadrokreo            # viewer モード
docker run --rm -p 8080:80 kadrokreo --editor   # editor モード
docker run --rm -i -v "$PWD:/work" --user "$(id -u):$(id -g)" kadrokreo kdr --help
```

ユーザーズガイドや `kdr docs` の例の `ghcr.io/yosiopp/kadrokreo` を `kadrokreo` に読み替える。

ビルドしたイメージで e2e を流すとき:

```sh
docker build -t kadrokreo .
docker run -d --name kdr-viewer -p 8091:80 kadrokreo
docker run -d --name kdr-editor -p 8092:80 kadrokreo --editor
EDITOR_URL=http://localhost:8092 VIEWER_URL=http://localhost:8091 npm run e2e
docker rm -f kdr-viewer kdr-editor
```

## ディレクトリ構成

```
src/document/   型、kdr の読み込みと検証、座標計算、SVG の書き出しなど（共通）
src/canvas/     Canvas 2D の描画、ズーム・パン、当たり判定、PNG・SVG の書き出しの入口（共通）
src/ui/         共通の UI 部品
src/viewer/     viewer の画面（インスペクト、CSS / HTML の出力、間隔の計測）
src/editor/     編集操作、履歴、ツール、パネル、kdr の書き出し、自動保存、SVG の取り込み
cli/            コマンドライン kdr（Node で TypeScript のまま動かす）。kdr help / kdr docs は help.ts と examples.ts から作る。マークアップ（kdr build / place）は markup.ts
docker/         nginx の設定と起動スクリプト
e2e/            ブラウザでの動作確認とキャプチャ
bench/          性能の計測（大きな kdr の生成と Node での計測は cli/bench/）
scripts/        check:viewer、リリースの本文（release-notes.sh）など
docs/guide/     ユーザーズガイド
docs/examples/  kdr コマンドの例と、viewer で開くサンプル（sample.kdr は sample.xml から作る）
plugins/kdr/    配布する skill（kdr を Docker 越しに使う）。.claude-plugin/marketplace.json でマーケットプレイスにしている
```

### 依存の向き

- **`src/editor/` を import してよいのは `src/editor/` の中と `src/App.tsx` と `cli/` だけ。** viewer のビルドに編集のコードを入れないための決まりで、
  oxlint（`.oxlintrc.json`）がエラーにし、`npm run check:viewer` がビルドの結果でも確かめる。緩めないこと。
- viewer で editor のものが要るときは、editor を import せず、純粋な部分を共通側（`src/document/` など）へ移す。
- `src/` から `cli/` を import しない（これも lint で禁じている）。
- `src/App.tsx` は `import.meta.env.MODE === 'editor'` で画面を切り替える。ビルド時に定数になるので、viewer のビルドでは editor の import ごと消える。
- viewer は外部へ通信しない（CSP で止めている）。外部の URL を読む機能を足さない。

## CI

GitHub Actions（`.github/`）:

- `workflows/ci.yml`（main への push と PR）: `npm ci` → `npm test` → `npm run lint` → `npm run build` → `npm run check:viewer` → `npm run e2e`。
  ランナーの Google Chrome を使い、日本語の描画のために `fonts-noto-cjk` を入れる。失敗したら `e2e/out/` を artifact `e2e-out` に上げる。
- `workflows/docker.yml`: イメージを作って viewer・editor・`kdr` コマンドが動くかを確かめ（`verify`）、push のときだけ GHCR に上げる（`publish`。main → `edge`、`v*` タグ → semver と `latest`）。
  `v*` タグのときは、イメージを上げた後に GitHub Releases も作る（`release`。本文は前のタグからのコミットの一覧と、イメージの pull・起動コマンド）。
- `dependabot.yml`: npm と GitHub Actions の更新を週 1 回。

### リリースの手順

タグを push すると、Docker イメージ（`ghcr.io/yosiopp/kadrokreo:X.Y.Z`・`X.Y`・`latest`）と GitHub Releases ができる。

```sh
git tag -a vX.Y.Z -m "（変更の一行サマリ）"
git push origin vX.Y.Z
```

GitHub の画面（Releases → Draft a new release）でタグを作ってもよい（そのときも本文は自動のものに置き換わる）。`v0.2.0-rc.1` のように `-` を含むタグはプレリリースになる。
リリースの本文は `scripts/release-notes.sh vX.Y.Z` で手元でも確かめられる（前の `v*` タグからのコミットの件名と本文の箇条書き）。

## ライセンス

送ってもらった変更は、このリポジトリと同じ MIT ライセンス（[LICENSE](LICENSE)）で取り込む。
