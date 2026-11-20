# kadrokreo

既存のオンラインデザインツールに近いデザインツール。

## コンセプト

- **viewer モード**（既定）: kdr ファイルを読み込んで閲覧する。編集や変更はできない
- **editor モード**: Docker でオプションを付けて起動した場合のみ。kdr ファイルに書き出しができる
- コメント機能は存在しない
- kdr ファイルの実体は gzip 圧縮された 1 つの JSON ファイル

## 起動

```sh
docker build -t kadrokreo .

docker run --rm -p 8080:80 kadrokreo            # viewer モード
docker run --rm -p 8080:80 kadrokreo --editor   # editor モード
```

http://localhost:8080 を開く。

イメージには viewer と editor の 2 つのビルドが入っていて、`--editor` の有無でどちらを配信するかが決まる。
viewer として起動したコンテナからは、編集機能のコードそのものが配信されない。

## 使い方

### editor

| 操作 | 内容 |
| --- | --- |
| `V` / `F` / `R` / `O` / `T` | 選択 / フレーム / 長方形 / 楕円 / テキスト |
| ドラッグ | 図形を描く、選択したものを動かす、何もない所からは範囲選択 |
| `Shift` + ドラッグ | 正方形・正円で描く、縦横比を保ってリサイズ、水平・垂直に動かす |
| ダブルクリック / `Enter` | テキストを編集（`Esc` で確定） |
| `Space` + ドラッグ、ホイール | 画面の移動 |
| `⌘`/`Ctrl` + ホイール、ピンチ | ズーム |
| `Shift` + `1` / `Shift` + `0` | 全体を表示 / 100% |
| `⌘`/`Ctrl` + `Z` / `Shift` + `Z` | 元に戻す / やり直す |
| `⌘`/`Ctrl` + `C` / `X` / `V` / `D` | コピー / 切り取り / 貼り付け / 複製 |
| `]` / `[` | 最前面 / 最背面へ（`⌘`/`Ctrl` 併用で 1 つずつ） |
| 矢印キー | 1px 移動（`Shift` で 10px） |
| `Delete` | 削除 |

- 図形をフレームの上へドラッグするとフレームの子になり、外へ出すとページ直下に戻る
- ページ直下のフレームは、左上の名前ラベルをつかんで動かせる
- レイヤーパネルではドラッグで重なり順と親子関係を変えられる。名前はダブルクリックで変更
- 編集中のドキュメントはブラウザ（localStorage）に自動保存される
- 「kdr に書き出し」でファイルに保存し、「開く」またはウィンドウへのドロップで読み込む

### viewer

「kdr を開く」またはウィンドウへのドロップで kdr ファイルを読み込む。ドラッグで画面を移動、`⌘`/`Ctrl` + ホイールでズーム。

## kdr ファイル

次の JSON を gzip 圧縮したもの。

```json
{
  "format": "kadrokreo",
  "version": 1,
  "document": {
    "name": "Untitled",
    "rootIds": ["..."],
    "nodes": { "<id>": { "type": "frame", "...": "..." } }
  }
}
```

ノードの定義は `src/document/types.ts`。読み込み時には `src/document/kdr.ts` で型・木構造・展開後のサイズを検証し、知らないフィールドは捨てる。

## 構成

| パス | 内容 | viewer | editor |
| --- | --- | --- | --- |
| `src/document/` | ドキュメントの型、kdr の読み込みと検証 | ○ | ○ |
| `src/canvas/` | Canvas 2D での描画、ズーム・パン | ○ | ○ |
| `src/ui/` | 共通の UI 部品 | ○ | ○ |
| `src/viewer/` | viewer の画面 | ○ | |
| `src/editor/` | 編集操作、Undo/Redo、ツール、パネル、kdr の書き出し | | ○ |
| `docker/` | 配信用の nginx 設定と起動スクリプト | | |

viewer 側のディレクトリ（`document` / `canvas` / `ui` / `viewer`）から `src/editor/` を import すると lint エラーになる。
これにより viewer ビルドに編集機能が紛れ込まない。

## 開発

```sh
npm install
npm run dev          # viewer モード
npm run dev:editor   # editor モード（開発用。配布物では Docker の --editor のみ）
npm test
npm run lint
npm run build        # dist/viewer と dist/editor を出力
```

## 未対応

- 回転、画像、パス（ペンツール）、グラデーション、影
- テキストの折り返し（改行のみ。大きさは文字数とフォントサイズで決まる）
- オートレイアウト、コンポーネント、複数ページ
- 半透明のフレームを 1 枚の絵として合成すること（子ごとに透過する）
