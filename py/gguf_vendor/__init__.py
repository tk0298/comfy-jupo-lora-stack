"""
ComfyUI-GGUF (https://github.com/city96/ComfyUI-GGUF, Apache-2.0, (c) City96) の
拡散モデル読み込み部分を同梱したもの (upstream rev 6ea2651)。
ComfyUI-GGUF を別途インストールしなくても .gguf を読めるようにするため。

改変点 ([jupo] コメント箇所):
- loader.py: UNet 読み込み部分のみ抜粋。既知リスト外のアーキテクチャ (Krea 2 等) を
  エラーにせず、ComfyUI 本体のモデル判定に任せる。変換ツール依存を削除。
- patcher.py: フルパス指定のロード関数を追加。DynamicVRAM を無効化してロードする。
ライセンス全文は同フォルダの LICENSE を参照。
"""
