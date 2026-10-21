"""
量子化モデル (INT8 ConvRot / FP8 Scaled / NVFP4 等) の検出ユーティリティ。

ComfyUI v0.27.0 以降の comfy_quant 形式 (per-layer メタデータ) と
旧来の scaled_fp8 形式の両方を、safetensors ヘッダのみを読んで
高速に判定する。テンソル本体はロードしない。
"""

import json
import logging
import os


# ===============================================
# safetensors ヘッダ読み込み
# ===============================================

def read_safetensors_header(filepath: str) -> tuple:
    """
    safetensors のヘッダ JSON を読み込む。
    戻り値: (header_dict, data_offset_base)
    ヘッダが不正な場合は例外を送出する。
    """
    with open(filepath, "rb") as file:
        # https://github.com/huggingface/safetensors#format
        header_size = int.from_bytes(file.read(8), "little", signed=False)
        if header_size <= 0 or header_size > 512 * 1024 * 1024:
            raise BufferError("Invalid safetensors header size")

        header = json.loads(file.read(header_size))
        return header, 8 + header_size


def _read_tensor_bytes(filepath: str, entry: dict, base: int, max_size: int = 65536) -> bytes:
    """
    ヘッダの data_offsets を使って小さなテンソルの生バイトを読み出す。
    comfy_quant メタデータ (uint8 にエンコードされた JSON) の読み出し用。
    """
    offsets = entry.get("data_offsets")
    if not offsets or len(offsets) != 2:
        return b""
    start, end = offsets
    size = end - start
    if size <= 0 or size > max_size:
        return b""
    with open(filepath, "rb") as file:
        file.seek(base + start)
        return file.read(size)


# ===============================================
# 量子化形式の検出
# ===============================================

def detect_quantization(filepath: str) -> dict | None:
    """
    safetensors ファイルの量子化形式を検出する。

    戻り値の例:
        {"formats": {"int8_tensorwise"}, "convrot": True,
         "convrot_groupsize": 256, "num_layers": 480}
    量子化されていない場合は None を返す。
    """
    if not filepath or not os.path.isfile(filepath):
        return None
    if filepath.lower().endswith(".gguf"):
        from .gguf_utils import read_gguf_info
        gguf_info = read_gguf_info(filepath)
        if gguf_info is None:
            return None
        return {
            "formats": set(),
            "gguf": gguf_info,
            "convrot": False,
            "convrot_groupsize": None,
            "num_layers": 0,
        }
    if not filepath.lower().endswith((".safetensors", ".sft")):
        return None

    try:
        header, base = read_safetensors_header(filepath)
    except Exception as e:
        logging.debug(f"[JupoQuant] ヘッダ読み込み失敗: {filepath}: {e}")
        return None

    metadata = header.get("__metadata__") or {}

    formats = set()
    convrot = False
    convrot_groupsize = None
    num_layers = 0

    def _consume_layer_conf(conf: dict):
        nonlocal convrot, convrot_groupsize, num_layers
        if not isinstance(conf, dict):
            return
        fmt = conf.get("format")
        if fmt:
            formats.add(fmt)
            num_layers += 1
        params_conf = conf.get("params", {})
        if not isinstance(params_conf, dict):
            params_conf = {}
        if conf.get("convrot", params_conf.get("convrot", False)):
            convrot = True
            gs = conf.get("convrot_groupsize", params_conf.get("convrot_groupsize", 256))
            try:
                convrot_groupsize = int(gs)
            except (TypeError, ValueError):
                convrot_groupsize = 256

    # --- 1) __metadata__ の _quantization_metadata (保存時に付与される形式)
    quant_meta = metadata.get("_quantization_metadata")
    if quant_meta:
        try:
            layers = json.loads(quant_meta).get("layers", {})
            for conf in layers.values():
                _consume_layer_conf(conf)
        except Exception as e:
            logging.debug(f"[JupoQuant] _quantization_metadata の解析失敗: {e}")

    # --- 2) per-layer の *.comfy_quant キー (uint8 テンソルにJSONが格納されている)
    if not formats:
        quant_keys = [k for k in header if k.endswith(".comfy_quant")]
        for key in quant_keys:
            raw = _read_tensor_bytes(filepath, header[key], base)
            if not raw:
                continue
            try:
                _consume_layer_conf(json.loads(raw))
            except Exception:
                continue

    # --- 3) 旧来の scaled_fp8 形式
    if not formats:
        for k in header:
            if k == "scaled_fp8" or k.endswith(".scaled_fp8"):
                formats.add("float8_e4m3fn")
                break

    if not formats:
        return None

    return {
        "formats": formats,
        "convrot": convrot,
        "convrot_groupsize": convrot_groupsize,
        "num_layers": num_layers,
    }


def format_label(info: dict | None) -> str:
    """検出結果を表示用ラベルに変換する。"""
    if not info:
        return ""

    if info.get("gguf") is not None:
        from .gguf_utils import format_gguf_label
        return format_gguf_label(info["gguf"])

    formats = info.get("formats", set())
    labels = []
    for fmt in sorted(formats):
        if fmt == "int8_tensorwise":
            labels.append("INT8 ConvRot" if info.get("convrot") else "INT8 Tensorwise")
        elif fmt == "float8_e4m3fn":
            labels.append("FP8 (e4m3fn)")
        elif fmt == "float8_e5m2":
            labels.append("FP8 (e5m2)")
        elif fmt == "nvfp4":
            labels.append("NVFP4")
        elif fmt == "mxfp8":
            labels.append("MXFP8")
        else:
            labels.append(fmt)

    return " + ".join(labels)


def is_int8_convrot(info: dict | None) -> bool:
    """検出結果が INT8 ConvRot かどうか。"""
    if not info:
        return False
    return "int8_tensorwise" in info.get("formats", set()) and info.get("convrot", False)


# ===============================================
# ComfyUI 側のサポート判定
# ===============================================

def comfy_supports_layer_quant() -> bool:
    """
    実行中の ComfyUI が per-layer 量子化 (comfy_quant / INT8 ConvRot) に
    対応しているかどうか (v0.27.0 以降)。
    """
    try:
        import comfy.utils
        return hasattr(comfy.utils, "detect_layer_quantization")
    except Exception:
        return False


def model_is_quantized(model_patcher) -> bool:
    """
    ModelPatcher が量子化ウェイト (QuantizedTensor) を含むかどうかを判定する。
    LoRA 適用時のログ・互換性チェック用。
    """
    if model_patcher is None:
        return False

    try:
        from comfy.quant_ops import QuantizedTensor
    except Exception:
        try:
            from comfy.ops import QuantizedTensor  # 旧配置のフォールバック
        except Exception:
            return False

    try:
        model = getattr(model_patcher, "model", None)
        if model is None:
            return False
        for param in model.parameters():
            if isinstance(param, QuantizedTensor):
                return True
            data = getattr(param, "data", None)
            if isinstance(data, QuantizedTensor):
                return True
    except Exception:
        return False

    return False
