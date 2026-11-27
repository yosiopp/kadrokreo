# kdr ファイル

[ユーザーズガイド](README.md) の一部。

kadrokreo のデザインを保存するファイル（拡張子 `.kdr`）。中身はドキュメントの JSON（`document.json`）と画像・書体の元のファイル（`assets/`）を
tar にまとめて gzip で圧縮したもの（version 17）で、`tar -xzf design.kdr` でそのまま取り出せる。

- 読めるのは今の version（17）と、読み替えて開ける 1 つ前の version（16）のファイル。それより古いファイルは「古いバージョン」として開かない（新しい version のファイルは、古い kadrokreo では「新しいバージョン」として開かない）
- 取り出したものを固め直すときは、`tar --format ustar` で `document.json` と `assets/` の中だけを入れる（macOS の tar が足す拡張の見出しや `._` のファイルがあると読めない）
- 埋め込んだ書体（[editor](editor.md#書体) の「書体ファイルを追加」や `kdr font-add`）は `assets/` に元のファイル（`.ttf` / `.otf` / `.woff` / `.woff2`）のまま入る。
  書体を埋め込んだファイルは、書体に対応する前の kadrokreo では「知らないファイル」として開けない
- 変数（[editor](editor.md#変数) や `kdr var-add`）は `document.json` の `collections` に入る。変数につないだ色には、変数の名前を指す印（`variable`）と、その時点の値（`color`）の両方が入る（数値・文字・真偽の変数は、ノードの `bindings` に項目ごとの印が入る）ので、変数を読まなくても見た目どおりに描ける
- `document.json` の中身は `kdr -f design.kdr json --pretty` でも見られる（[コマンドライン](cli.md)）
