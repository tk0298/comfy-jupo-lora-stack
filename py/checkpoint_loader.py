from .utils import Field, IO
from .quant_utils import (
    detect_quantization,
    format_label,
    is_int8_convrot,
    comfy_supports_layer_quant,
)
from .gguf_utils import (
    is_gguf,
    load_gguf_unet,
    list_checkpoints_with_gguf,
    resolve_checkpoint_path,
)
from nodes import CheckpointLoaderSimple
import folder_paths
import json
import logging
import contextlib


# ===============================================
# Anima チェックポイント判定
# ===============================================

# Cosmos-Predict2 DiT (Anima) のチェックポイントに含まれるが
# ComfyUI の UNet マッパーが認識しない "unexpected" キー。
# 位置エンコーダ用ウェイトで LoRA/推論動作には影響しない。
_ANIMA_UNEXPECTED_KEYS = {
    "pos_embedder.dim_spatial_range",
    "pos_embedder.dim_temporal_range",
    "pos_embedder.seq",
}

_ANIMA_PATH_MARKERS = ("_anima", "/anima/", "anima_", "anima-", "anima3")


def _is_anima_checkpoint(path: str) -> bool:
    lower = path.replace("\\", "/").lower()
    return any(m in lower for m in _ANIMA_PATH_MARKERS)


# ===============================================
# logging フィルタ: pos_embedder 警告を抑制
# ===============================================

class _AnimaPosEmbedFilter(logging.Filter):
    """
    "unet unexpected: [...]" ログのうち pos_embedder キーのみで構成される
    ものを INFO レベルに降格して実質的に抑制するフィルタ。
    他の genuine な unexpected キーは通常通り WARNING として残す。
    """
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if "unet unexpected:" not in msg:
            return True  # 関係ないログはそのまま通す

        # "unet unexpected: ['key1', 'key2', ...]" をパース
        try:
            bracket_start = msg.index("[")
            bracket_end = msg.rindex("]")
            keys_str = msg[bracket_start + 1: bracket_end]
            # 簡易パース: シングルクォートで囲まれたキー名を抽出
            import re
            keys = set(re.findall(r"'([^']+)'", keys_str))
            if keys and keys.issubset(_ANIMA_UNEXPECTED_KEYS):
                # 全て known な Anima pos_embedder キーなら INFO に降格
                record.levelno = logging.INFO
                record.levelname = "INFO"
        except (ValueError, Exception):
            pass  # パース失敗時は通常通り WARNING を通す

        return True


@contextlib.contextmanager
def _suppress_anima_posembed_warnings():
    """
    コンテキスト内の logging.WARNING のうち Anima pos_embedder 警告だけを
    INFO に降格するコンテキストマネージャ。
    """
    root_logger = logging.getLogger()
    f = _AnimaPosEmbedFilter()
    root_logger.addFilter(f)
    try:
        yield
    finally:
        root_logger.removeFilter(f)


# ===============================================
# ロード処理
# ===============================================

# ===============================================
# INT8 ConvRot 等の量子化チェックポイント判定
# ===============================================

def _check_quantized_checkpoint(ckpt_name: str):
    """
    チェックポイントの量子化形式 (INT8 ConvRot / FP8 Scaled 等) を
    safetensors ヘッダから検出し、ログ出力する。
    per-layer 量子化 (comfy_quant) に非対応の古い ComfyUI では
    明確なエラーを出す。
    """
    try:
        full_path = resolve_checkpoint_path(ckpt_name)
    except Exception:
        full_path = None

    if not full_path:
        return None

    info = detect_quantization(full_path)
    if not info:
        return None

    label = format_label(info)
    logging.info(f"[JupoCheckpoint] 量子化モデルを検出: {label} ({ckpt_name})")

    # comfy_quant (per-layer) 形式は ComfyUI v0.27.0 以降が必要
    needs_layer_quant = bool(info.get("num_layers", 0))
    if needs_layer_quant and not comfy_supports_layer_quant():
        raise RuntimeError(
            f"{label} 形式のモデル ({ckpt_name}) を読み込むには "
            "ComfyUI v0.27.0 以降が必要です。ComfyUI を更新してください。"
        )

    if is_int8_convrot(info):
        logging.info(
            "[JupoCheckpoint] INT8 ConvRot: LoRA はサンプリング時に "
            "逆量子化を介してネイティブに適用されます"
        )

    return info


def _load_checkpoint_auto(path: str):
    """
    Anima チェックポイントかどうかを判定し、適切にロードする。
    Anima の場合は pos_embedder 警告を INFO に降格してから
    CheckpointLoaderSimple でロードする。
    INT8 ConvRot 等の量子化モデルは検出してログ出力し、
    非対応の ComfyUI では明確なエラーを出す。
    .gguf は ComfyUI-GGUF 経由で拡散モデルのみをロードし、CLIP / VAE は None を返す。
    """
    _check_quantized_checkpoint(path)

    if is_gguf(path):
        return _load_gguf_checkpoint(path)

    if _is_anima_checkpoint(path):
        logging.info(f"[JupoCheckpoint] Anima チェックポイントを検出: {path}")
        with _suppress_anima_posembed_warnings():
            loader = CheckpointLoaderSimple()
            out = loader.load_checkpoint(path)
        logging.info(f"[JupoCheckpoint] ロード完了 (pos_embedder キーは無視): {path}")
        return out

    loader = CheckpointLoaderSimple()
    return loader.load_checkpoint(path)


def _load_gguf_checkpoint(path: str):
    """
    .gguf 拡散モデルをロードする。GGUF には通常 CLIP / VAE が含まれないため
    (MODEL, None, None) を返す。CLIP / VAE は別途ローダーで読み込むこと。
    """
    logging.info(f"[JupoCheckpoint] GGUF モデルを検出: {path}")
    with _suppress_anima_posembed_warnings() if _is_anima_checkpoint(path) else contextlib.nullcontext():
        model = load_gguf_unet(path)
    logging.info(
        "[JupoCheckpoint] GGUF は拡散モデルのみを含むため CLIP / VAE は出力されません。"
        "CLIP / VAE は別のローダーで読み込んでください"
    )
    return (model, None, None)


# ===============================================
# Checkpoint Loader
# ===============================================

class JupoCheckpointLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ckpt_name": Field.combo(list_checkpoints_with_gguf()),
            },
        }

    RETURN_TYPES = (IO.MODEL, IO.CLIP, IO.VAE)
    FUNCTION = "execute"

    def execute(self, ckpt_name: str):
        out = _load_checkpoint_auto(ckpt_name)
        return out


# ===============================================
# Checkpoint Selector
# ===============================================

class JupoCheckpointSelector:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "prev_trigger": Field.string(forceInput=True),
                "checkpoint": Field.string(multiline=True),  # js側で非表示
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = (IO.MODEL, IO.CLIP, IO.VAE, IO.STRING)
    RETURN_NAMES = ("MODEL", "CLIP", "VAE", "trigger")
    FUNCTION = "execute"

    def _resolve_value(self, unique_id, extra_pnginfo, checkpoint) -> dict:
        """
        有効なcheckpoint情報を解決する。

        一部バージョンのComfyUIフロントエンドでは、非表示ウィジェットの値が
        プロンプト入力へ正しくシリアライズされない不具合があるため、
        まず extra_pnginfo (キュー投入時点のワークフロー全体) 内の
        このノード自身の widgetValues (serialize() で埋め込まれる生データ) から
        enabled な項目を探す。見つからない場合のみ、ウィジェット経由で渡された
        checkpoint 文字列にフォールバックする。
        """
        try:
            nodes = extra_pnginfo.get("workflow").get("nodes")
            for node in nodes:
                if str(node.get("id")) == str(unique_id):
                    for entry in node.get("widgetValues") or []:
                        if isinstance(entry, dict) and entry.get("enabled"):
                            return entry
        except Exception as e:
            logging.debug(f"[JupoCheckpoint] extra_pnginfoからの復元に失敗: {e}")

        try:
            value = json.loads(checkpoint)
        except Exception as e:
            raise ValueError(f"checkpoint widget: 不正なJSON値です ({e})")

        if not isinstance(value, dict):
            raise ValueError("checkpoint widget: 不正なJSON値です")

        return value

    def execute(self, prev_trigger="", checkpoint="", unique_id=None, extra_pnginfo=None):
        value = self._resolve_value(unique_id, extra_pnginfo, checkpoint)

        enabled = value.get("enabled")
        if not enabled:
            raise ValueError("checkpoint widget: 有効なcheckpointがありません")

        path = value.get("path")
        model, clip, vae = _load_checkpoint_auto(path)

        trigger = prev_trigger
        enabled_trigger = value.get("enabled_trigger")
        trigger_value = value.get("trigger")
        if enabled_trigger and trigger_value and trigger_value.strip():
            trigger += trigger_value

        return (model, clip, vae, trigger)
