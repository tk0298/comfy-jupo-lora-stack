"""
LoRA キー名解決の互換レイヤー。

ComfyUI 本体の `comfy.lora.model_lora_keys_unet` / `model_lora_keys_clip` は
既知のモデルアーキテクチャ用のキー変換テーブルを構築するが、MiniMax H3 の
ような比較的新しい / まだ本体のテーブルに完全対応していないアーキテクチャで、
かつ外部トレーナー (musubi-tuner 系など) がモデルの生の state_dict キー名を
そのまま LoRA キーとして書き出している場合、本体のテーブルには一致するエント
リが存在せず "lora key not loaded" が全キーに対して発生することがある。

このモジュールは、モデルの実際の state_dict から生成した
"生キー名 -> 内部キー名" のフォールバック対応表を用意し、
本体のテーブルでの一致率が著しく低い場合にのみ追加適用する。
特定のアーキテクチャ名をハードコードしないため、将来的に別の
未対応アーキテクチャが登場した場合にも同様に機能する。
"""

import logging

import comfy.lora
import comfy.lora_convert


# 一致率がこの値未満の場合にフォールバックを試みる
_FALLBACK_MATCH_THRESHOLD = 0.5


def build_native_key_map(model=None, clip=None) -> dict:
    """ComfyUI 本体のキー変換テーブルを構築する。"""
    key_map = {}
    if model is not None:
        key_map = comfy.lora.model_lora_keys_unet(model.model, key_map)
    if clip is not None:
        key_map = comfy.lora.model_lora_keys_clip(clip.cond_stage_model, key_map)
    return key_map


def diffusion_model_arch_name(model) -> str:
    """ログ表示用にUNet(DiT)のクラス名を取得する。取得できなければ空文字。"""
    try:
        return model.model.diffusion_model.__class__.__name__
    except Exception:
        return ""


def build_state_dict_fallback_map(model) -> dict:
    """
    diffusion_model の state_dict をそのまま走査し、
    "生パラメータ名(拡張子無し) -> 内部キー名" のフォールバック表を作る。

    例: state_dict に "blocks.0.attn.qkv_proj.weight" があれば
        fallback["blocks.0.attn.qkv_proj"] = "diffusion_model.blocks.0.attn.qkv_proj.weight"
    """
    fallback = {}
    if model is None:
        return fallback

    diffusion_model = getattr(getattr(model, "model", None), "diffusion_model", None)
    if diffusion_model is None:
        return fallback

    try:
        state_dict = diffusion_model.state_dict()
    except Exception as e:
        logging.debug(f"[LoRAStack] フォールバック用 state_dict 取得失敗: {e}")
        return fallback

    for key in state_dict.keys():
        if not key.endswith(".weight"):
            continue
        base = key[: -len(".weight")]
        # 本体テーブルと衝突しないよう、未登録のキーのみ追加
        fallback.setdefault(base, f"diffusion_model.{key}")

    return fallback


def resolve_loaded_patches(lora_sd: dict, model=None, clip=None, context_label: str = ""):
    """
    LoRA の state_dict と model/clip から、実際に適用するパッチ辞書を解決する。

    1. まず ComfyUI 本体のキー変換テーブルで解決を試みる。
    2. LoRA 側のエントリ数に対して一致したキーの割合が低い場合、
       モデルの生 state_dict から作ったフォールバック表を model 側に限定して
       追加し、再解決する。一致数が改善した場合のみ採用する。

    戻り値: (loaded_patches: dict, used_fallback: bool, model_key_map: dict)
    model_key_map は LBW (Layered Block Weight) 側でブロック指定のマッチングに
    再利用するために返す。
    """
    lora_converted = comfy.lora_convert.convert_lora(lora_sd)

    model_key_map = {}
    if model is not None:
        model_key_map = comfy.lora.model_lora_keys_unet(model.model)
    clip_key_map = {}
    if clip is not None:
        clip_key_map = comfy.lora.model_lora_keys_clip(clip.cond_stage_model)

    native_map = model_key_map | clip_key_map
    loaded = comfy.lora.load_lora(lora_converted, native_map)

    total_entries = len(lora_converted)
    match_ratio = (len(loaded) / total_entries) if total_entries else 1.0

    used_fallback = False
    if model is not None and total_entries > 0 and match_ratio < _FALLBACK_MATCH_THRESHOLD:
        fallback_map = build_state_dict_fallback_map(model)
        if fallback_map:
            merged_model_map = {**fallback_map, **model_key_map}
            merged_map = merged_model_map | clip_key_map
            loaded_fb = comfy.lora.load_lora(lora_converted, merged_map)
            if len(loaded_fb) > len(loaded):
                arch = diffusion_model_arch_name(model)
                arch_label = f" [{arch}]" if arch else ""
                label = f" ({context_label})" if context_label else ""
                logging.info(
                    "[LoRAStack] 本体のキー変換テーブルで一致するキーが少ないため、"
                    f"state_dict ベースの互換マッピングを適用しました{arch_label}{label} "
                    f"({len(loaded)} -> {len(loaded_fb)} / {total_entries} キー一致)"
                )
                loaded = loaded_fb
                model_key_map = merged_model_map
                used_fallback = True

    return loaded, used_fallback, model_key_map
