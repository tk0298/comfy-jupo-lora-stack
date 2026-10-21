"""
GGUF (.gguf) モデル対応ユーティリティ。

- Checkpoint Loader / Selector から .gguf の拡散モデル (UNet / DiT) を選択できるよう、
  checkpoints フォルダと diffusion_models (unet) フォルダの .gguf を一覧化する。
- 実際のロードは同梱した ComfyUI-GGUF (city96) のコア (py/gguf_vendor) で行う。
  ComfyUI 本体は GGUF のテンソル (GGMLTensor) と逆量子化オペレータを持たないため。
- モデル情報ダイアログ用に、GGUF ヘッダ (KV + テンソル情報) だけを読んで
  アーキテクチャと量子化タイプを高速に取得する (テンソル本体は読まない)。
"""

import logging
import os
import struct
from collections import Counter

import folder_paths


GGUF_EXT = ".gguf"
GGUF_FOLDER_KEY = "jupo_gguf_models"

# .gguf を探索する ComfyUI フォルダ種別 (先頭ほど優先)
_GGUF_SOURCE_FOLDERS = ("checkpoints", "diffusion_models")


def is_gguf(name: str) -> bool:
    return bool(name) and str(name).lower().endswith(GGUF_EXT)


# ===============================================
# ファイル一覧 / パス解決
# ===============================================

def _source_dirs() -> list:
    dirs = []
    for key in _GGUF_SOURCE_FOLDERS:
        try:
            for d in folder_paths.get_folder_paths(key):
                if d not in dirs:
                    dirs.append(d)
        except Exception:
            continue
    return dirs


def _ensure_registered():
    """
    checkpoints + diffusion_models の .gguf を束ねた仮想フォルダを登録する。
    extra_model_paths 等で後からパスが増えても追従できるよう毎回再構築する
    (folder_paths 側のキャッシュはフォルダ構成で検証されるので問題ない)。
    """
    folder_paths.folder_names_and_paths[GGUF_FOLDER_KEY] = (_source_dirs(), {GGUF_EXT})


def list_gguf_models() -> list:
    """Checkpoint 用に選択可能な .gguf モデルの相対パス一覧。"""
    try:
        _ensure_registered()
        return list(folder_paths.get_filename_list(GGUF_FOLDER_KEY))
    except Exception as e:
        logging.debug(f"[JupoGGUF] .gguf 一覧の取得に失敗: {e}")
        return []


def list_checkpoints_with_gguf() -> list:
    """通常の checkpoints 一覧の後ろに .gguf モデルを追加した一覧。"""
    base = list(folder_paths.get_filename_list("checkpoints"))
    seen = set(base)
    for name in list_gguf_models():
        if name not in seen:
            base.append(name)
            seen.add(name)
    return base


def resolve_gguf_path(name: str):
    """.gguf モデルのフルパスを解決する。見つからなければ None。"""
    if not is_gguf(name):
        return None
    _ensure_registered()
    return folder_paths.get_full_path(GGUF_FOLDER_KEY, name)


def resolve_checkpoint_path(name: str):
    """checkpoints を優先し、無ければ .gguf 用の仮想フォルダからフルパスを解決する。"""
    path = None
    try:
        path = folder_paths.get_full_path("checkpoints", name)
    except Exception:
        path = None
    if not path and is_gguf(name):
        path = resolve_gguf_path(name)
    return path


# ===============================================
# ロード (同梱の ComfyUI-GGUF コア: py/gguf_vendor)
# ===============================================

def load_gguf_unet(name: str):
    """
    .gguf 拡散モデルをロードして MODEL (GGUFModelPatcher) を返す。
    GGUF ファイルには通常 CLIP / VAE が含まれないため MODEL のみ。
    ComfyUI-GGUF のロード処理を同梱しているので、別途インストールは不要
    (pip の gguf パッケージのみ必要)。
    """
    full_path = resolve_gguf_path(name)
    if not full_path:
        raise FileNotFoundError(f"GGUF モデルが見つかりません: {name}")

    try:
        import gguf  # noqa: F401
    except ImportError:
        raise RuntimeError(
            f"GGUF モデル ({name}) を読み込むには Python パッケージ gguf が必要です。"
            "ComfyUI の Python で `python -m pip install gguf` を実行してから ComfyUI を再起動してください。"
        )

    from .gguf_vendor.patcher import load_gguf_diffusion_model
    return load_gguf_diffusion_model(full_path)


def model_is_gguf(model_patcher) -> bool:
    """MODEL が ComfyUI-GGUF でロードされたもの (GGUFModelPatcher) かどうか。"""
    if model_patcher is None:
        return False
    try:
        return any(c.__name__ == "GGUFModelPatcher" for c in type(model_patcher).__mro__)
    except Exception:
        return False


# ===============================================
# ヘッダ解析 (情報表示用)
# ===============================================

# ggml_type -> 表示名
GGML_TYPE_NAMES = {
    0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 6: "Q5_0", 7: "Q5_1",
    8: "Q8_0", 9: "Q8_1", 10: "Q2_K", 11: "Q3_K", 12: "Q4_K", 13: "Q5_K",
    14: "Q6_K", 15: "Q8_K", 16: "IQ2_XXS", 17: "IQ2_XS", 18: "IQ3_XXS",
    19: "IQ1_S", 20: "IQ4_NL", 21: "IQ3_S", 22: "IQ2_S", 23: "IQ4_XS",
    24: "I8", 25: "I16", 26: "I32", 27: "I64", 28: "F64", 29: "IQ1_M",
    30: "BF16", 34: "TQ1_0", 35: "TQ2_0", 39: "MXFP4",
}
_UNQUANTIZED = {"F32", "F16", "BF16", "F64", "I8", "I16", "I32", "I64"}

# GGUF KV の値型
_SCALAR_FMT = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}
_T_STRING = 8
_T_ARRAY = 9


class _Reader:
    def __init__(self, f):
        self.f = f

    def read(self, n: int) -> bytes:
        b = self.f.read(n)
        if len(b) != n:
            raise EOFError("unexpected end of GGUF header")
        return b

    def u32(self):
        return struct.unpack("<I", self.read(4))[0]

    def u64(self):
        return struct.unpack("<Q", self.read(8))[0]

    def string(self, max_len: int = 1 << 20) -> str:
        n = self.u64()
        if n > max_len:
            raise ValueError("GGUF string too long")
        return self.read(n).decode("utf-8", errors="replace")

    def skip_string(self):
        self.f.seek(self.u64(), os.SEEK_CUR)

    def value(self, vtype: int, keep: bool):
        if vtype in _SCALAR_FMT:
            fmt = _SCALAR_FMT[vtype]
            return struct.unpack(fmt, self.read(struct.calcsize(fmt)))[0]
        if vtype == _T_STRING:
            if keep:
                return self.string()
            self.skip_string()
            return None
        if vtype == _T_ARRAY:
            item_type = self.u32()
            count = self.u64()
            if item_type in _SCALAR_FMT:
                # スカラー配列は読み飛ばす (トークナイザ等で巨大になり得る)
                self.f.seek(struct.calcsize(_SCALAR_FMT[item_type]) * count, os.SEEK_CUR)
            else:
                for _ in range(count):
                    self.value(item_type, keep=False)
            return None
        raise ValueError(f"unknown GGUF value type: {vtype}")


# 表示用に保持する KV (それ以外は読み飛ばす)
_KEEP_KEYS = {"general.architecture", "general.name", "general.file_type", "general.quantization_version"}


def read_gguf_info(filepath: str):
    """
    GGUF ヘッダから情報を取得する。
    戻り値例: {"version": 3, "architecture": "flux", "name": "...",
               "tensor_types": {"Q8_0": 123456789, "F32": 1234}, "tensor_count": 780}
    tensor_types は型ごとの要素数合計。失敗時は None。
    """
    if not filepath or not os.path.isfile(filepath):
        return None
    try:
        with open(filepath, "rb") as f:
            r = _Reader(f)
            if r.read(4) != b"GGUF":
                return None
            version = r.u32()
            if version < 2:
                # v1 は件数が u32 で実質使われていないため非対応
                return {"version": version, "tensor_types": {}, "tensor_count": 0}
            tensor_count = r.u64()
            kv_count = r.u64()

            kv = {}
            for _ in range(kv_count):
                key = r.string()
                vtype = r.u32()
                keep = key in _KEEP_KEYS
                val = r.value(vtype, keep)
                if keep:
                    kv[key] = val

            types = Counter()
            for _ in range(tensor_count):
                r.skip_string()
                n_dims = r.u32()
                if n_dims > 8:
                    raise ValueError("invalid tensor dims")
                numel = 1
                for _ in range(n_dims):
                    numel *= r.u64()
                ttype = r.u32()
                r.u64()  # offset
                types[GGML_TYPE_NAMES.get(ttype, f"type{ttype}")] += numel

        return {
            "version": version,
            "architecture": kv.get("general.architecture"),
            "name": kv.get("general.name"),
            "tensor_types": dict(types),
            "tensor_count": tensor_count,
        }
    except Exception as e:
        logging.debug(f"[JupoGGUF] ヘッダ解析失敗: {filepath}: {e}")
        return None


def format_gguf_label(info: dict | None) -> str:
    """
    量子化形式の表示ラベル。要素数の多い順に量子化タイプを並べる。
    例: "GGUF Q4_K + Q6_K", 量子化なしなら "GGUF F16"
    """
    if not info:
        return "GGUF"
    types = info.get("tensor_types") or {}
    if not types:
        return "GGUF"
    ordered = sorted(types.items(), key=lambda kv: kv[1], reverse=True)
    quant = [t for t, _ in ordered if t not in _UNQUANTIZED]
    shown = quant[:3] if quant else [ordered[0][0]]
    return "GGUF " + " + ".join(shown)
