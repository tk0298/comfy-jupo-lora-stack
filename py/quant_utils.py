"""
量子化モデル (INT8 ConvRot / FP8 Scaled / NVFP4 / INT4 等) の検出ユーティリティ。

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
    linear_dtypes = set()

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
        # ConvRot W4A4 の演算 dtype (既定 int4。int8 指定のモデルは INT8 GEMM で演算)
        if fmt == "convrot_w4a4":
            linear_dtypes.add(str(conf.get("linear_dtype", params_conf.get("linear_dtype", "int4"))))
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
        for raw in _iter_comfy_quant_bytes(filepath, header, base):
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

    # --- 4) NVIDIA ModelOpt 形式の NVFP4 (comfy_quant メタデータ無し)
    #        ComfyUI 本体は comfy_quant 形式の NVFP4 のみ読み込めるため、区別して報告する
    modelopt = False
    if not formats and _looks_like_modelopt_nvfp4(header):
        formats.add("nvfp4")
        modelopt = True

    # --- 5) ComfyUI 非対応の INT4 形式 (Nunchaku SVDQuant / GPTQ / AWQ)
    foreign_int4 = None
    if not formats:
        foreign_int4 = detect_foreign_int4(header)
        if foreign_int4:
            formats.add(foreign_int4)

    if not formats:
        return None

    return {
        "formats": formats,
        "convrot": convrot,
        "convrot_groupsize": convrot_groupsize,
        "num_layers": num_layers,
        "modelopt": modelopt,
        "foreign_int4": foreign_int4,
        # INT4 (W4A8) の Lloyd-Max コードブック付きか
        "codebook": any(k.endswith(".weight_codebook") for k in header),
        "linear_dtypes": linear_dtypes,
        "diffusion_only": is_diffusion_only_header(header),
        "arch": detect_arch_header(header),
    }


def _iter_comfy_quant_bytes(filepath: str, header: dict, base: int, limit: int | None = None):
    """
    *.comfy_quant テンソル (JSON) の生バイトを、ファイルを 1 回だけ開いて順に返す。
    limit を指定するとその個数で打ち切る (一覧表示用の軽量スキャン)。
    """
    keys = [k for k in header if k.endswith(".comfy_quant")]
    if limit is not None:
        keys = keys[:limit]
    if not keys:
        return
    with open(filepath, "rb") as file:
        for key in keys:
            offsets = header[key].get("data_offsets") if isinstance(header[key], dict) else None
            if not offsets or len(offsets) != 2:
                continue
            start, end = offsets
            size = end - start
            if size <= 0 or size > 65536:
                continue
            file.seek(base + start)
            yield file.read(size)


# ComfyUI 本体がネイティブに読める INT4 系の形式
INT4_FORMATS = {"convrot_w4a4", "asym_w4a8_int8"}
# 4〜6bit の低ビット形式 (NVFP4 / INT4 / INT6)。拡散モデル単体なら Checkpoint 一覧に表示する
LOWBIT_FORMATS = {"nvfp4", "convrot_w4a4", "asym_w4a8_int8", "w6a8_int8"}
# ComfyUI 非対応の INT4 形式 (検出してエラーで案内する)
FOREIGN_INT4_FORMATS = {"svdquant_int4", "gptq_awq_int4"}


def detect_foreign_int4(header: dict) -> str | None:
    """
    ComfyUI 本体では読めない INT4 形式を検出する。
      - Nunchaku (SVDQuant W4A4): *.qweight + *.wscales (+ smooth_factor / lora_down 等)
      - GPTQ / AWQ (LLM 由来の W4A16): *.qweight + *.qzeros + *.scales
    """
    has_qweight = has_wscales = has_qzeros = False
    for k in header:
        if k.endswith(".qweight"):
            has_qweight = True
        elif k.endswith(".wscales"):
            has_wscales = True
        elif k.endswith(".qzeros"):
            has_qzeros = True
        if has_qweight and (has_wscales or has_qzeros):
            break
    if not has_qweight:
        return None
    if has_wscales:
        return "svdquant_int4"
    if has_qzeros:
        return "gptq_awq_int4"
    return None


# ===============================================
# NVFP4 / 拡散モデル単体ファイルの判定 (ヘッダのキー名のみで高速判定)
# ===============================================

def _looks_like_modelopt_nvfp4(header: dict) -> bool:
    """
    comfy_quant を持たず、uint8 の weight と weight_scale_2 を持つ = ModelOpt 形式の NVFP4。
    """
    has_scale2 = False
    for k, v in header.items():
        if k == "__metadata__":
            continue
        if k.endswith(".comfy_quant"):
            return False
        if k.endswith(".weight_scale_2"):
            has_scale2 = True
    if not has_scale2:
        return False
    # 対応する weight が uint8 (FP4 x2 パック) であることを確認
    for k, v in header.items():
        if k.endswith(".weight_scale_2"):
            w = header.get(k[: -len("_scale_2")])
            if isinstance(w, dict) and w.get("dtype") == "U8":
                return True
    return False


def header_has_nvfp4(header: dict) -> bool:
    """
    ヘッダに NVFP4 レイヤーが含まれるか (comfy_quant 形式 / ModelOpt 形式の両方)。
    NVFP4 は weight_scale_2 (テンソル単位スケール) を持つ唯一の形式なので、
    comfy_quant の中身を読まずにキー名だけで判定できる。
    """
    meta = header.get("__metadata__") or {}
    quant_meta = meta.get("_quantization_metadata")
    if isinstance(quant_meta, str) and '"nvfp4"' in quant_meta:
        return True
    for k in header:
        if k.endswith(".weight_scale_2"):
            return True
    return False


# ComfyUI の model_detection.unet_prefix_from_state_dict と同じ候補
_CHECKPOINT_UNET_PREFIXES = ("model.diffusion_model.", "model.model.", "net.")


def is_diffusion_only_header(header: dict) -> bool:
    """
    拡散モデル (UNet / DiT) 単体のファイルか (= CheckpointLoaderSimple では読めない)。
    ComfyUI 本体のチェックポイント判定 (unet_prefix_from_state_dict) と同じ基準で、
    チェックポイント用プレフィックスのキーが 5 個以下なら拡散モデル単体とみなす。
    """
    keys = [k for k in header if k != "__metadata__"]
    # SAM3 / SenseNova はプレフィックス無しでもチェックポイント扱い (本体と同じ特例)
    if any(k.startswith("detector.") for k in keys) and any(k.startswith("tracker.") for k in keys):
        return False
    if "fm_modules.vision_model_mot_gen.embeddings.patch_embedding.weight" in header:
        return False
    counts = {p: 0 for p in _CHECKPOINT_UNET_PREFIXES}
    for k in keys:
        for p in _CHECKPOINT_UNET_PREFIXES:
            if k.startswith(p):
                counts[p] += 1
                break
    return max(counts.values()) <= 5


def detect_arch_header(header: dict) -> str | None:
    """
    拡散モデル単体ファイルのアーキテクチャをキー名だけで判定する (一覧表示用)。
    ComfyUI 本体の model_detection と同じ判定キーを使う。
      minimax_h3_image … MiniMax H3 Image / P-H3-Image (音声ストリーム無し)
      minimax_h3       … MiniMax H3 (動画 + 音声)
    """
    for prefix in ("", "model.diffusion_model."):
        if f"{prefix}video_patch_proj.weight" in header and f"{prefix}condition_proj.weight" in header:
            return "minimax_h3" if f"{prefix}audio_patch_proj.weight" in header else "minimax_h3_image"
    return None


ARCH_LABELS = {
    "minimax_h3_image": "MiniMax H3 Image",
    "minimax_h3": "MiniMax H3",
}


_header_cache: dict = {}


def scan_safetensors(filepath: str) -> dict | None:
    """
    一覧表示用の軽量スキャン (ヘッダのみ・mtime/サイズでキャッシュ)。
    戻り値: {"nvfp4": bool, "modelopt": bool, "diffusion_only": bool}
    """
    try:
        st = os.stat(filepath)
    except OSError:
        return None
    cache_key = (filepath, st.st_mtime_ns, st.st_size)
    cached = _header_cache.get(filepath)
    if cached and cached[0] == cache_key:
        return cached[1]
    try:
        header, base = read_safetensors_header(filepath)
    except Exception as e:
        logging.debug(f"[JupoQuant] ヘッダ読み込み失敗: {filepath}: {e}")
        result = None
    else:
        nvfp4 = header_has_nvfp4(header)
        formats = set()
        if nvfp4:
            formats.add("nvfp4")
        # INT4 / INT6 はキー名 (weight_scale のみ) では INT8 と区別できないため、
        # _quantization_metadata か、先頭のいくつかの comfy_quant を読んで判定する
        meta = header.get("__metadata__") or {}
        quant_meta = meta.get("_quantization_metadata")
        if isinstance(quant_meta, str):
            for fmt in LOWBIT_FORMATS:
                if f'"{fmt}"' in quant_meta:
                    formats.add(fmt)
        if not (formats & INT4_FORMATS) and any(k.endswith(".comfy_quant") for k in header):
            try:
                for raw in _iter_comfy_quant_bytes(filepath, header, base, limit=64):
                    try:
                        fmt = json.loads(raw).get("format")
                    except Exception:
                        continue
                    if fmt in LOWBIT_FORMATS:
                        formats.add(fmt)
            except OSError:
                pass
        result = {
            "nvfp4": nvfp4,
            "arch": detect_arch_header(header),
            "formats": formats,
            "lowbit": bool(formats & LOWBIT_FORMATS),
            "modelopt": nvfp4 and _looks_like_modelopt_nvfp4(header),
            "diffusion_only": is_diffusion_only_header(header),
        }
    _header_cache[filepath] = (cache_key, result)
    return result


def is_nvfp4(info: dict | None) -> bool:
    return bool(info) and "nvfp4" in info.get("formats", set())


def is_int4(info: dict | None) -> bool:
    """ComfyUI ネイティブの INT4 系 (INT4 ConvRot W4A4 / INT4 W4A8)。"""
    return bool(info) and bool(info.get("formats", set()) & INT4_FORMATS)


def is_lowbit_int(info: dict | None) -> bool:
    """ComfyUI ネイティブの INT4 / INT6 系。"""
    return bool(info) and bool(info.get("formats", set()) & (INT4_FORMATS | {"w6a8_int8"}))


# ===============================================
# NVFP4 の実行環境チェック
# ===============================================

def nvfp4_runtime_status(device=None) -> dict:
    """
    この ComfyUI で NVFP4 を高速 (FP4 Tensor Core) に演算できるかを調べる。
    戻り値: {"loadable": bool, "fast": bool, "reasons": [str, ...]}
      loadable=False … comfy-kitchen が無く NVFP4 テンソルを扱えない (読み込み不可)
      fast=False     … 読み込みは可能だが逆量子化して演算する (速度・VRAM の利点が小さい)
    """
    reasons = []
    loadable = True
    fast = True

    try:
        import comfy.quant_ops as quant_ops
    except Exception:
        return {"loadable": False, "fast": False, "reasons": ["ComfyUI が古く NVFP4 (comfy.quant_ops) に未対応です"]}

    if not getattr(quant_ops, "_CK_AVAILABLE", False):
        loadable = False
        fast = False
        reasons.append(
            "comfy-kitchen が読み込めません (ComfyUI の Python で "
            "`python -m pip install -r requirements.txt` を実行してください)"
        )
    if "nvfp4" not in getattr(quant_ops, "QUANT_ALGOS", {}):
        loadable = False
        fast = False
        reasons.append("この ComfyUI は NVFP4 に未対応です。ComfyUI を更新してください")

    try:
        import torch
        cuda = torch.version.cuda
        if cuda is None:
            fast = False
            reasons.append("CUDA 版 PyTorch ではありません")
        else:
            if tuple(int(x) for x in str(cuda).split(".")[:2]) < (13, 0):
                fast = False
                reasons.append(f"PyTorch の CUDA が {cuda} です (高速カーネルには cu130 以上が必要)")
    except Exception:
        pass

    try:
        import comfy.model_management as mm
        if hasattr(mm, "supports_nvfp4_compute"):
            if device is None:
                device = mm.get_torch_device()
            if not mm.supports_nvfp4_compute(device):
                fast = False
                reasons.append("GPU が FP4 演算に未対応です (Blackwell 世代 = RTX 50 系 / B200 等が必要)")
    except Exception as e:
        logging.debug(f"[JupoQuant] supports_nvfp4_compute の確認に失敗: {e}")

    return {"loadable": loadable, "fast": fast, "reasons": reasons}


def int4_runtime_status(formats: set, device=None) -> dict:
    """
    この ComfyUI で INT4 / INT6 (comfy_quant) を演算できるかを調べる。
    戻り値: {"loadable": bool, "fast": bool, "reasons": [str], "notes": [str]}
      loadable=False … comfy-kitchen が無い / ComfyUI がその形式に未対応で読み込めない
      fast=False     … 読み込みは可能だが逆量子化して演算する (速度の利点が小さい)
      notes          … 動作はするが知っておくとよい情報 (INT8 演算へのフォールバック等)
    """
    reasons, notes = [], []
    loadable, fast = True, True

    try:
        import comfy.quant_ops as quant_ops
    except Exception:
        return {"loadable": False, "fast": False, "notes": [],
                "reasons": ["ComfyUI が古く INT4 (comfy.quant_ops) に未対応です"]}

    if not getattr(quant_ops, "_CK_AVAILABLE", False):
        loadable = fast = False
        reasons.append(
            "comfy-kitchen が読み込めません (ComfyUI の Python で "
            "`python -m pip install -r requirements.txt` を実行してください)"
        )
    algos = getattr(quant_ops, "QUANT_ALGOS", {})
    missing = sorted(f for f in formats if f not in algos)
    if missing:
        loadable = fast = False
        reasons.append(f"この ComfyUI は {', '.join(missing)} 形式に未対応です。ComfyUI を更新してください")

    try:
        import torch
        cuda = torch.version.cuda
        if cuda is None:
            fast = False
            reasons.append("CUDA 版 PyTorch ではありません")
        elif tuple(int(x) for x in str(cuda).split(".")[:2]) < (13, 0):
            fast = False
            reasons.append(f"PyTorch の CUDA が {cuda} です (高速カーネルには cu130 以上が必要)")
    except Exception:
        pass

    try:
        import comfy.model_management as mm
        if device is None:
            device = mm.get_torch_device()
        if hasattr(mm, "supports_int8_compute") and not mm.supports_int8_compute(device):
            fast = False
            reasons.append("このデバイスは INT8/INT4 演算に未対応です")
        elif "convrot_w4a4" in formats and hasattr(mm, "is_nvidia") and mm.is_nvidia():
            import torch
            major, minor = torch.cuda.get_device_capability(device)
            if major >= 9:
                # comfy-kitchen の INT4 MMA カーネルは SM8x (RTX 30/40) / Turing 専用。
                # Hopper / Blackwell (RTX 50 等) は INT8 GEMM で演算する (VRAM は 4bit のまま)
                notes.append(
                    f"この GPU (sm_{major}{minor}) は INT4 Tensor Core 非対応のため、"
                    "INT4 ConvRot は INT8 演算で動作します (VRAM 使用量は 4bit のまま)"
                )
            elif (major, minor) < (7, 5):
                fast = False
                reasons.append(f"GPU (sm_{major}{minor}) が INT4/INT8 Tensor Core に未対応です (Turing 以降が必要)")
    except Exception as e:
        logging.debug(f"[JupoQuant] INT4 演算環境の確認に失敗: {e}")

    return {"loadable": loadable, "fast": fast, "reasons": reasons, "notes": notes}


def check_quant_loadable(info: dict | None, name: str = ""):
    """
    低ビット量子化モデル (NVFP4 / INT4 / INT6) を読み込めるか確認する。
    読み込めない場合は分かりやすいエラー、高速演算できない場合は警告ログを出す。
    """
    if not info:
        return
    label = f" ({name})" if name else ""

    foreign = info.get("foreign_int4")
    if foreign == "svdquant_int4":
        raise RuntimeError(
            f"Nunchaku (SVDQuant) 形式の INT4 モデル{label}は ComfyUI 本体では読み込めません。"
            "ComfyUI-nunchaku の専用ローダーを使うか、ComfyUI 形式 (comfy_quant) の INT4 モデルを使用してください"
        )
    if foreign == "gptq_awq_int4":
        raise RuntimeError(
            f"GPTQ / AWQ 形式の INT4 モデル{label}は ComfyUI 本体では読み込めません。"
            "ComfyUI 形式 (comfy_quant) の INT4 モデルを使用してください"
        )

    check_nvfp4_loadable(info, name)

    if is_lowbit_int(info):
        formats = info["formats"] & (INT4_FORMATS | {"w6a8_int8"})
        status = int4_runtime_status(formats)
        fmt_label = format_label({**info, "formats": formats})
        if not status["loadable"]:
            raise RuntimeError(f"{fmt_label} モデル{label}を読み込めません: " + " / ".join(status["reasons"]))
        if status["fast"]:
            logging.info(f"[JupoQuant] {fmt_label} モデル{label}: INT 演算カーネルで演算します")
        else:
            logging.warning(
                f"[JupoQuant] {fmt_label} モデル{label}は読み込めますが、逆量子化して演算するため"
                "速度の利点が小さくなります: " + " / ".join(status["reasons"])
            )
        for note in status["notes"]:
            logging.info(f"[JupoQuant] {note}")


def check_nvfp4_loadable(info: dict | None, name: str = ""):
    """
    NVFP4 モデルを読み込めるか確認し、読み込めない場合は分かりやすいエラーを出す。
    読み込めるが高速演算できない場合は警告ログを出す。
    """
    if not is_nvfp4(info):
        return
    label = f" ({name})" if name else ""

    if info.get("modelopt"):
        raise RuntimeError(
            f"NVIDIA ModelOpt 形式の NVFP4 モデル{label}は ComfyUI では読み込めません。"
            "ComfyUI 形式 (comfy_quant メタデータ付き) の NVFP4 モデルを使用してください"
        )

    status = nvfp4_runtime_status()
    if not status["loadable"]:
        raise RuntimeError(f"NVFP4 モデル{label}を読み込めません: " + " / ".join(status["reasons"]))
    if status["fast"]:
        logging.info(f"[JupoQuant] NVFP4 モデル{label}: FP4 Tensor Core で演算します")
    else:
        logging.warning(
            f"[JupoQuant] NVFP4 モデル{label}は読み込めますが、逆量子化して演算するため"
            "速度・VRAM の利点が小さくなります: " + " / ".join(status["reasons"])
        )


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
            labels.append("NVFP4 (ModelOpt 形式・ComfyUI 非対応)" if info.get("modelopt") else "NVFP4")
        elif fmt == "mxfp8":
            labels.append("MXFP8")
        elif fmt == "convrot_w4a4":
            dtypes = info.get("linear_dtypes") or set()
            suffix = " / INT8演算" if dtypes == {"int8"} else ""
            labels.append(f"INT4 ConvRot (W4A4{suffix})")
        elif fmt == "asym_w4a8_int8":
            labels.append("INT4 (W4A8・Lloyd-Max)" if info.get("codebook") else "INT4 (W4A8)")
        elif fmt == "w6a8_int8":
            labels.append("INT6 (W6A8)")
        elif fmt == "svdquant_int4":
            labels.append("INT4 SVDQuant (Nunchaku 形式・ComfyUI-nunchaku が必要)")
        elif fmt == "gptq_awq_int4":
            labels.append("INT4 GPTQ/AWQ (ComfyUI 非対応)")
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
