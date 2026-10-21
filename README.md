# comfy-jupo-lora-stack

LoRA をスタック形式でまとめて管理・適用する ComfyUI カスタムノードです。
LoRA / Checkpoint 選択用のエクスプローラ、Civitai 情報表示、トリガーワード、LoRA Block Weight、
量子化モデル (INT8 ConvRot / FP8 / NVFP4) と GGUF モデルへの対応を備えています。

> [jupo-ai/comfy-jupo-lora-stack](https://github.com/jupo-ai/comfy-jupo-lora-stack) をベースに、
> 最新 ComfyUI への追従と機能追加を行ったフォークです。

<img src="https://files.catbox.moe/6g9nt4.png" height=400>

## 目次
- [インストール](#インストール)
- [ノード一覧](#ノード一覧)
- [主な機能](#主な機能)
  - [LoRA Stack](#lora-stack)
  - [Checkpoint Loader / Selector](#checkpoint-loader--selector)
  - [GGUF (.gguf) 対応](#gguf-gguf-対応)
  - [量子化モデル対応 (INT8 ConvRot / FP8 / NVFP4)](#量子化モデル対応-int8-convrot--fp8--nvfp4)
  - [LoRA Block Weight / スケジュール](#lora-block-weight--スケジュール)
  - [Wrapper 連携](#wrapper-連携)
  - [その他](#その他)
- [設定](#設定)
- [動作環境](#動作環境)
- [クレジット / ライセンス](#クレジット--ライセンス)

## インストール

1. `ComfyUI/custom_nodes` にクローンします
   ```
   cd ComfyUI/custom_nodes
   git clone https://github.com/tk0298/comfy-jupo-lora-stack
   ```
2. 依存パッケージを ComfyUI の Python にインストールします
   ```
   python -m pip install -r comfy-jupo-lora-stack/requirements.txt
   ```
   - Windows の venv 環境の例: `C:\ComfyUI\venv\Scripts\python.exe -m pip install -r comfy-jupo-lora-stack\requirements.txt`
   - `blake3` (Civitai 用ハッシュ計算の高速化) と `gguf` (GGUF モデル読み込み) がインストールされます
3. ComfyUI を再起動します

## ノード一覧

カテゴリ `jupo/LoRAStack` に追加されます。

| ノード | 入力 | 出力 | 概要 |
| --- | --- | --- | --- |
| **LoRA Stack (jupo)** | prev_stack, prev_trigger | stack, trigger | LoRA をリスト化した stack を作成。複数ノードを数珠つなぎにできます |
| **LoRA Loader (jupo)** | model, clip, prev_stack, prev_trigger | MODEL, CLIP, trigger | LoRA を選んでそのままモデルに適用 |
| **Apply LoRA Stack** | model, clip, stack | MODEL, CLIP | stack をモデルに適用 |
| **Stack to WanWrapper** | stack | WANVIDLORA | stack を Kijai 氏の WanVideoWrapper 用 LoRA 形式に変換 |
| **Stack to AnimaWrapper** | stack | ANIMALORE | stack を Anima Wrapper 用 LoRA 形式に変換 |
| **Checkpoint Loader (jupo)** | — | MODEL, CLIP, VAE | カスタムエクスプローラ付き Checkpoint Loader (GGUF 対応) |
| **Checkpoint Selector (jupo)** | prev_trigger | MODEL, CLIP, VAE, trigger | 複数の Checkpoint を登録し、1 つを選んで切り替え (GGUF 対応) |
| **Empty Latent Image (jupo)** | — | latent | 縦横入替トグル付きの Empty Latent Image |
| **Image Scale (jupo)** | image | image | 縦横入替トグル付きの画像リサイズ (0 指定で縦横比維持) |

## 主な機能

### LoRA Stack

- **カスタムエクスプローラ**: フォルダ構造・プレビュー付きで LoRA を選択できます (設定で OFF 可)
  ![sample](https://files.catbox.moe/nfp8n5.png)
- **右クリックメニュー**: 情報を開く / LBW を開く / 有効化・無効化 / 表示名を設定 / 表示切替 (ファイル名・フルパス) / CLIP 個別設定 / 並べ替え / 削除
- **CLIP 強度の個別設定**: `Clipを個別設定` で MODEL と CLIP の強度を別々に指定できます。`CLIPを共通設定` で元に戻ります
  ![sample](https://files.catbox.moe/fuvl05.png)
- **表示名**: 任意の表示名 (日本語可) を付けられます
- **Civitai 情報**: `情報を開く` でファイルハッシュから Civitai の情報を取得して表示します (取得結果は `*.civitai.json` としてキャッシュ)
  ![sample](https://files.catbox.moe/9mobnn.png)
- **トリガーワード**: Civitai 情報画面で LoRA ごとに設定できます (既定は OFF)。有効な LoRA のトリガーワードが `trigger` 出力に連結されます
  ![sample](https://files.catbox.moe/kr0wxm.png)
- **プレビュー**: Civitai 情報画面から画像・動画のプレビューを設定できます (モデルと同じフォルダに保存)
- **LoRA キー互換**: ComfyUI 本体のキー変換テーブルで一致するキーが少ない LoRA (MiniMax H3 など、モデルの生の state_dict キー名で書き出された LoRA) は、モデルの state_dict から作った互換マッピングで自動的に解決します

### Checkpoint Loader / Selector

- 通常の Checkpoint Loader と同等の動作に、カスタムエクスプローラと情報ダイアログを追加しています
- **Checkpoint Selector** は複数の Checkpoint を登録しておき、トグルで 1 つを選んで切り替えられます。Checkpoint ごとにトリガーワードも設定できます
- Anima (Cosmos-Predict2 DiT) のチェックポイントでは、推論に影響しない `pos_embedder` の警告を抑制します

### GGUF (.gguf) 対応

- Checkpoint Loader / Selector で `.gguf` の拡散モデル (Flux / WAN / Qwen-Image / Krea 2 など) を選択できます
- `models/checkpoints` と `models/diffusion_models` (`models/unet`) の両方の `.gguf` が一覧に表示されます
- [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) の読み込み処理を同梱しているため、**ComfyUI-GGUF のインストールは不要**です (`gguf` パッケージのみ必要)
- ComfyUI-GGUF の既知リストにないアーキテクチャ (Krea 2 など) も、ComfyUI 本体のモデル判定で読み込めます
- 16GB 級の GPU でも OOM になりにくいよう、GGUF モデルの VRAM 見積もりに余裕を持たせています
- GGUF には通常 CLIP / VAE が含まれないため **MODEL のみ出力**されます (CLIP / VAE は None)。CLIP / VAE は別のローダーで読み込んでください
- GGUF モデルにも LoRA Stack / LBW を適用できます。start / end スケジュール (Hook) は GGUF では動作保証外です
- 情報ダイアログに量子化タイプ (Q8_0, Q4_K など) とアーキテクチャが表示されます

### 量子化モデル対応 (INT8 ConvRot / FP8 / NVFP4)

- INT8 ConvRot / FP8 Scaled / NVFP4 などの量子化チェックポイントを safetensors ヘッダから検出します
- 量子化モデルへの LoRA 適用は ComfyUI 標準の逆量子化パッチ経由で行われます (**ComfyUI v0.27.0 以降が必要**。非対応バージョンでは明確なエラーを表示)
- 情報ダイアログに量子化形式が表示されます

### LoRA Block Weight / スケジュール

- LoRA の右クリック → `LBWを開く` でブロック単位の強度を設定できます
- モデルタイプ: `SD`, `FLUX`, `WAN`, `ANIMA`
- ブロックはフルブロック相当で記載しています (LyCORIS などと UI を統一するため)。FLUX / WAN は U-Net ではありませんが、UI の都合上ブロックを左右に分けて表示しています
- BIMO 構文に対応しています
- 同じ画面から **スケジュール (start / end)** を 0〜1 の範囲で設定できます
  ![sample](https://files.catbox.moe/3ou2ha.png)

### Wrapper 連携

- **Stack to WanWrapper**: stack を WanVideoWrapper の LoRA 形式に変換します。LBW (モデルタイプ `WAN`) のブロック指定も反映されます
  ![sample](https://files.catbox.moe/er4jai.png)
- **Stack to AnimaWrapper**: stack を Anima Wrapper の LoRA 形式に変換します。LBW (モデルタイプ `ANIMA`) のブロック指定と `pos_embedder` キーの除外に対応しています

### その他

- **Empty Latent Image (jupo)** / **Image Scale (jupo)**: 縦横を入れ替えるトグル付き。Image Scale は幅または高さを 0 にすると縦横比を維持して計算します

## 設定

ComfyUI の設定画面から変更できます。

| 項目 | 内容 |
| --- | --- |
| カスタムエクスプローラを使う | OFF にすると標準のリスト選択になります |
| カスタムエクスプローラのビューモード | リスト / グリッド表示の切り替え |
| カスタムエクスプローラのグリッド横幅 / 高さ | グリッド表示時のサムネイルサイズ |

## 動作環境

- ComfyUI v0.27.0 以降を推奨 (量子化モデルへの LoRA 適用に必要)。v0.42 で動作確認しています
- 新しいフロントエンド (Nodes 2.0) にも対応しています

## クレジット / ライセンス

- オリジナル: [jupo-ai/comfy-jupo-lora-stack](https://github.com/jupo-ai/comfy-jupo-lora-stack) — MIT License (`LICENSE`)
- GGUF 読み込み処理: [city96/ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) の一部を `py/gguf_vendor/` に同梱 — Apache License 2.0 (`py/gguf_vendor/LICENSE`)
