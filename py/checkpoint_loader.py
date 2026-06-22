from .utils import Field, IO
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

_ANIMA_PATH_MARKERS = ("_anima", "/anima/")


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

def _load_checkpoint_auto(path: str):
    """
    Anima チェックポイントかどうかを判定し、適切にロードする。
    Anima の場合は pos_embedder 警告を INFO に降格してから
    CheckpointLoaderSimple でロードする。
    """
    if _is_anima_checkpoint(path):
        logging.info(f"[JupoCheckpoint] Anima チェックポイントを検出: {path}")
        with _suppress_anima_posembed_warnings():
            loader = CheckpointLoaderSimple()
            out = loader.load_checkpoint(path)
        logging.info(f"[JupoCheckpoint] ロード完了 (pos_embedder キーは無視): {path}")
        return out

    loader = CheckpointLoaderSimple()
    return loader.load_checkpoint(path)


# ===============================================
# Checkpoint Loader
# ===============================================

class JupoCheckpointLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ckpt_name": Field.combo(folder_paths.get_filename_list("checkpoints")),
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
            }
        }

    RETURN_TYPES = (IO.MODEL, IO.CLIP, IO.VAE, IO.STRING)
    RETURN_NAMES = ("MODEL", "CLIP", "VAE", "trigger")
    FUNCTION = "execute"

    def execute(self, prev_trigger="", checkpoint=""):
        value = json.loads(checkpoint)
        if not isinstance(value, dict):
            raise ValueError("checkpoint widget: 不正なJSON値です")

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
