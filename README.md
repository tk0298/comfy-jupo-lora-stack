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

### Nodes 2.0 (Vue ノード) 対応
- 従来キャンバス / Nodes 2.0 のどちらでも動作します (ComfyUI フロントエンド v1.61 系で確認)
- Nodes 2.0 でも LoRA / Checkpoint の行を右クリックすると独自メニュー (情報・LBW・移動・削除など) が開きます
- ノードの右クリックメニューにも `➕ LoRAを追加` と各 LoRA のサブメニューが追加されます (どちらのモードでも使えます)
- Checkpoint Loader は Nodes 2.0 では標準のドロップダウン表示になるため、ノードメニューの `📂 エクスプローラでCheckpointを選択` / `ℹ️ Checkpoint情報を開く` から操作してください
- ズームアウト時に行が消えたまま戻らない問題、行の高さが切れる問題を修正しました

### INT8 ConvRot 対応
- INT8 ConvRot / FP8 Scaled / NVFP4 等の量子化チェックポイントに対応しています
- 量子化モデルへのLoRA適用はComfyUI標準の逆量子化パッチ経由で行われます (ComfyUI v0.27.0以降が必要)
- 非対応バージョンのComfyUIでは明確なエラーメッセージを表示します
- モデル情報ダイアログに量子化形式 (INT8 ConvRot等) が表示されます

### NVFP4 対応
- ComfyUI 形式 (comfy_quant) の NVFP4 モデルを Checkpoint Loader / Selector から読み込めます
- `models/diffusion_models` にある NVFP4 モデルも一覧に表示されます (拡散モデル単体なので CLIP / VAE は別のローダーで読み込んでください)
- 拡散モデル単体の safetensors を `models/checkpoints` に置いた場合も読み込めます
- LoRA / LBW / start・end スケジュールは ComfyUI 本体の逆量子化パッチ経由でそのまま使えます
- FP4 演算 (高速) には Blackwell 世代の GPU (RTX 50 系など)、PyTorch cu130 以上、comfy-kitchen が必要です。条件を満たさない場合は警告を出し、逆量子化して動作します
- NVIDIA ModelOpt 形式の NVFP4 は ComfyUI 本体が非対応のため、分かりやすいエラーを出します
- モデル情報ダイアログに `NVFP4` と、この環境で高速演算できるかを表示します

### MOSS-Image 対応
- MOSS-Image (Base / SFT および派生モデル) のLoRAをスタックに適用できます (ComfyUI本体のMOSS-Image対応が必要)
- 融合 `proj.qkv` 形式の公式Comfy版 (BF16 / INT8 ConvRot) でも、別々の q/k/v を持つLoRAを本体のキー変換経由で適用します
- LBWのモデルタイプ `MOSS` を追加しました (`layers.0`〜`layers.41` の42層 + IN / OUT)
  - 融合qkvのスライス (q / k / v) にもブロック強度が正しく反映されます
  - LoRAファイル名/パスに `moss-image` / `moss_image` / 単独の `moss` が含まれる場合は自動で `MOSS` が選ばれます。それ以外の名前 (例: `8-steps-dmd-lora`) はダイアログのモデルタイプから手動で選択してください
- CLIP (Qwen3.5-9B) 側へのLoRAブロック指定はありません (MOSS-ImageのLoRAはDiTのみが対象)

### GGUF (.gguf) 対応
- Checkpoint Loader / Checkpoint Selector で `.gguf` の拡散モデル (Flux / WAN / Qwen-Image 等) を選択できます
- `models/checkpoints` と `models/diffusion_models` (`models/unet`) の両方の `.gguf` が一覧に表示されます
- [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) (Apache-2.0) の読み込み処理を同梱しているため、ComfyUI-GGUF のインストールは不要です (`pip install gguf` のみ必要)
- 同梱版は ComfyUI-GGUF の既知リストにないアーキテクチャ (Krea 2 等) も ComfyUI 本体のモデル判定で読み込めます
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
- モデルタイプは`SD`, `FLUX`, `WAN`, `ANIMA`, `MOSS`(MOSS-Image)を用意してあります
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