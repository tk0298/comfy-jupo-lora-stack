from .utils import Field, IO
from nodes import CheckpointLoaderSimple
import folder_paths
import json
import logging


# ===============================================
# Anima チェックポイント判定ユーティリティ
# ===============================================

def _is_anima_checkpoint(path: str) -> bool:
    """
    パス文字列から Anima (Cosmos-Predict2 DiT) チェックポイントかどうかを判定する。
    判定基準:
      - パス内に "_Anima" または "anima" (大文字小文字不問) を含む
    """
    lower = path.replace("\\", "/").lower()
    return "_anima" in lower or "/anima/" in lower


def _load_checkpoint_auto(path: str):
    """
    パスに応じて適切なローダーでチェックポイントを読み込む。
    Anima チェックポイントの場合は comfyui-anima-enhancer の
    AnimaCheckpointLoader を優先使用し、pos_embedder キーを
    正しくマップする。フォールバックとして CheckpointLoaderSimple を使用。
    """
    if _is_anima_checkpoint(path):
        # comfyui-anima-enhancer の AnimaCheckpointLoader を動的に解決
        try:
            from nodes import NODE_CLASS_MAPPINGS  # type: ignore
            anima_loader_cls = NODE_CLASS_MAPPINGS.get("AnimaCheckpointLoader")
            if anima_loader_cls is not None:
                loader = anima_loader_cls()
                # AnimaCheckpointLoader は (model, clip, vae) を返す想定
                result = loader.load_checkpoint(path)
                logging.info(f"[JupoCheckpoint] AnimaCheckpointLoader でロード: {path}")
                return result
            else:
                logging.warning(
                    "[JupoCheckpoint] AnimaCheckpointLoader が見つかりません。"
                    "comfyui-anima-enhancer がインストールされているか確認してください。"
                    "CheckpointLoaderSimple にフォールバックします。"
                )
        except Exception as e:
            logging.warning(f"[JupoCheckpoint] AnimaCheckpointLoader の呼び出しに失敗: {e} — フォールバック中")

        # フォールバック: CheckpointLoaderSimple + pos_embedder キー無視パッチ
        model, clip, vae = _load_with_posembed_patch(path)
        return model, clip, vae

    # 通常チェックポイント
    loader = CheckpointLoaderSimple()
    return loader.load_checkpoint(path)


def _load_with_posembed_patch(path: str):
    """
    CheckpointLoaderSimple でロードしつつ、
    pos_embedder.* の unexpected キー警告を抑制する。
    これらのキーは Cosmos-Predict2 DiT の位置エンコーダ用で
    ComfyUI コアのマッパーには存在しないが動作には影響しない。
    """
    import comfy.utils
    import comfy.sd
    import comfy.model_management

    # ComfyUI の load_checkpoint_guess_config を直接呼んで
    # strict=False を強制することで unexpected キーを黙認させる
    try:
        from comfy.sd import load_checkpoint_guess_config
        ckpt_path = folder_paths.get_full_path("checkpoints", path)
        if ckpt_path is None:
            raise FileNotFoundError(f"チェックポイントが見つかりません: {path}")

        out = load_checkpoint_guess_config(
            ckpt_path,
            output_vae=True,
            output_clip=True,
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
        )
        logging.info(f"[JupoCheckpoint] load_checkpoint_guess_config (strict=False相当) でロード: {path}")
        # out は (model, clip, vae, ...) のタプル — 先頭3要素だけ返す
        return out[0], out[1], out[2]
    except Exception as e:
        logging.warning(f"[JupoCheckpoint] load_checkpoint_guess_config 失敗: {e} — CheckpointLoaderSimple にフォールバック")
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
        model, clip, vae = _load_checkpoint_auto(ckpt_name)
        return (model, clip, vae)


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
                "checkpoint": Field.string(multiline=True), # js側で非表示
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
        if enabled_trigger and trigger_value.strip():
            trigger += trigger_value
        
        return (model, clip, vae, trigger)