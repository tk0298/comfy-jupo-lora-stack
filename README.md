# comfy-jupo-lora-stack

<img src="https://files.catbox.moe/6g9nt4.png" height=400>

## Install
1. custom_nodesフォルダにリポジトリクローン  
   `git clone https://github.com/jupo-ai/comfy-jupo-lora-stack`
2. requirements.txtをインストール  
   `pip install -r comfy-jupo-lora-stack/requirements.txt`


## 機能
LoRAをスタック形式で読み込みます  
以下の機能があります

### INT8 ConvRot 対応
- INT8 ConvRot / FP8 Scaled / NVFP4 等の量子化チェックポイントに対応しています
- 量子化モデルへのLoRA適用はComfyUI標準の逆量子化パッチ経由で行われます (ComfyUI v0.27.0以降が必要)
- 非対応バージョンのComfyUIでは明確なエラーメッセージを表示します
- モデル情報ダイアログに量子化形式 (INT8 ConvRot等) が表示されます

### GGUF (.gguf) 対応
- Checkpoint Loader / Checkpoint Selector で `.gguf` の拡散モデル (Flux / WAN / Qwen-Image 等) を選択できます
- `models/checkpoints` と `models/diffusion_models` (`models/unet`) の両方の `.gguf` が一覧に表示されます
- ロードには [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) が必要です (未インストール時は明確なエラーを表示します)
- GGUF には通常 CLIP / VAE が含まれないため、MODEL のみ出力されます (CLIP / VAE 出力は None)。CLIP / VAE は別のローダーで読み込んでください
- GGUF モデルにも LoRA Stack / LBW を適用できます (ComfyUI-GGUF の逆量子化パッチ経由)
- start / end スケジュール (Hook) は GGUF では動作保証外です
- モデル情報ダイアログに量子化タイプ (Q8_0, Q4_K 等) とアーキテクチャが表示されます

### カスタムエクスプローラ
- オリジナルのLoRA選択GUIを提供します
- 設定からOFFにできます
- ![sample](https://files.catbox.moe/nfp8n5.png)

### Civitai情報
- LoRA右クリック -> `情報を開く`を選択するとCivitaiから情報を取得します
- ![sample](https://files.catbox.moe/9mobnn.png)

### トリガーワード設定
- 上のCivitai情報画面でトリガーワードを設定できます
- デフォルトではOFFなので必要なLoRAにて設定してください
- trigger出力にて連結して出力されます
- ![sample](https://files.catbox.moe/kr0wxm.png)

### プレビュー
- 上のCivitai情報画面でプレビューを設定できます
- 画像、動画を設定できます

### CLIP強度の個別設定
- LoRAを右クリック -> `Clipを個別設定`
- MODELとCLIPの強度を別々に設定できます
- 再び`CLIPを共通設定`にするとMODELとCLIPを共に設定します
- ![sample](https://files.catbox.moe/fuvl05.png)

### 表示名を設定
- LoRAを右クリック -> `表示名を設定`
- 自由に表示名を設定できます
- 日本語も使えます

### Stack to WanWrapper
- stackをKijai氏のWanVideo Wrapperのlora形式に変換するノードです
- ~~blockなどは全部にまとめて設定することになります~~ LBWで設定できるようになりました
- ![sample](https://files.catbox.moe/er4jai.png)

### LoRA Block Weight
- LoRA右クリック -> `LBWを開く`を選択するとLBW設定用のGUIが表示されます
- モデルタイプは`SD`, `FLUX`, `WAN`をとりあえず用意してあります
- ブロックはフルブロック相当で記載してあります(Lycoris等とUIを統合するため)
- BIMO構文が使えます
- FLUX, WANはU-netではないのでinput, ouputがあるわけではないですが、UIの都合上、ブロックをU-netのように左右に分けています
- ![sample](https://files.catbox.moe/3ou2ha.png)

### スケジュール(start, end)
- 上記LBW画面からスケジュールを設定できます
- start, endをそれぞれ 0 ~ 1 の範囲で設定します

### Checkpoint Loader
- 通常のCheckpoint Loaderと同等です。
- ファイル選択用のカスタムエクスプローラを使用できます