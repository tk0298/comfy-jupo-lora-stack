# (c) City96 || Apache-2.0 (apache.org/licenses/LICENSE-2.0)
# GGUFModelPatcher は ComfyUI-GGUF nodes.py より (改変なし)。
# load_gguf_diffusion_model は UnetLoaderGGUF.load_unet をベースに、
# フルパス指定と ComfyUI の DynamicVRAM 無効化に対応させたもの。
import collections
import inspect
import logging

import torch
import comfy.sd
import comfy.lora
import comfy.float
import comfy.utils
import comfy.model_patcher
import comfy.model_management

from .ops import GGMLOps, move_patch_to_device
from .loader import gguf_sd_loader
from .dequant import is_quantized, is_torch_compatible


class GGUFModelPatcher(comfy.model_patcher.ModelPatcher):
    patch_on_device = False

    def patch_weight_to_device(self, key, device_to=None, inplace_update=False):
        if key not in self.patches:
            return
        weight = comfy.utils.get_attr(self.model, key)

        patches = self.patches[key]
        if is_quantized(weight):
            out_weight = weight.to(device_to)
            patches = move_patch_to_device(patches, self.load_device if self.patch_on_device else self.offload_device)
            # TODO: do we ever have legitimate duplicate patches? (i.e. patch on top of patched weight)
            out_weight.patches = [(patches, key)]
        else:
            inplace_update = self.weight_inplace_update or inplace_update
            if key not in self.backup:
                self.backup[key] = collections.namedtuple('Dimension', ['weight', 'inplace_update'])(
                    weight.to(device=self.offload_device, copy=inplace_update), inplace_update
                )

            if device_to is not None:
                temp_weight = comfy.model_management.cast_to_device(weight, device_to, torch.float32, copy=True)
            else:
                temp_weight = weight.to(torch.float32, copy=True)

            out_weight = comfy.lora.calculate_weight(patches, temp_weight, key)
            out_weight = comfy.float.stochastic_rounding(out_weight, weight.dtype)

        if inplace_update:
            comfy.utils.copy_to_param(self.model, key, out_weight)
        else:
            comfy.utils.set_attr_param(self.model, key, out_weight)

    def unpatch_model(self, device_to=None, unpatch_weights=True):
        if unpatch_weights:
            for p in self.model.parameters():
                if is_torch_compatible(p):
                    continue
                patches = getattr(p, "patches", [])
                if len(patches) > 0:
                    p.patches = []
        # TODO: Find another way to not unload after patches
        return super().unpatch_model(device_to=device_to, unpatch_weights=unpatch_weights)


    def pin_weight_to_device(self, key):
        op_key = key.rsplit('.', 1)[0]
        if not self.mmap_released and op_key in self.named_modules_to_munmap:
            # TODO: possible to OOM, find better way to detach
            self.named_modules_to_munmap[op_key].to(self.load_device).to(self.offload_device)
            del self.named_modules_to_munmap[op_key]
        super().pin_weight_to_device(key)

    mmap_released = False
    named_modules_to_munmap = {}

    def load(self, *args, force_patch_weights=False, **kwargs):
        if not self.mmap_released:
            self.named_modules_to_munmap = dict(self.model.named_modules())

        # always call `patch_weight_to_device` even for lowvram
        super().load(*args, force_patch_weights=True, **kwargs)

        # make sure nothing stays linked to mmap after first load
        if not self.mmap_released:
            linked = []
            if kwargs.get("lowvram_model_memory", 0) > 0:
                for n, m in self.named_modules_to_munmap.items():
                    if hasattr(m, "weight"):
                        device = getattr(m.weight, "device", None)
                        if device == self.offload_device:
                            linked.append((n, m))
                            continue
                    if hasattr(m, "bias"):
                        device = getattr(m.bias, "device", None)
                        if device == self.offload_device:
                            linked.append((n, m))
                            continue
            if linked and self.load_device != self.offload_device:
                logging.info(f"Attempting to release mmap ({len(linked)})")
                for n, m in linked:
                    # TODO: possible to OOM, find better way to detach
                    m.to(self.load_device).to(self.offload_device)
            self.mmap_released = True
            self.named_modules_to_munmap = {}

    def clone(self, *args, **kwargs):
        src_cls = self.__class__
        self.__class__ = GGUFModelPatcher
        n = super().clone(*args, **kwargs)
        n.__class__ = GGUFModelPatcher
        self.__class__ = src_cls
        # GGUF specific clone values below
        n.patch_on_device = getattr(self, "patch_on_device", False)
        n.mmap_released = getattr(self, "mmap_released", False)
        if src_cls != GGUFModelPatcher:
            n.size = 0 # force recalc
        return n



def load_gguf_diffusion_model(path, dequant_dtype=None, patch_dtype=None, patch_on_device=False):
    """フルパスの .gguf 拡散モデルをロードして GGUFModelPatcher を返す。"""
    ops = GGMLOps()

    if dequant_dtype in ("default", None):
        ops.Linear.dequant_dtype = None
    elif dequant_dtype in ["target"]:
        ops.Linear.dequant_dtype = dequant_dtype
    else:
        ops.Linear.dequant_dtype = getattr(torch, dequant_dtype)

    if patch_dtype in ("default", None):
        ops.Linear.patch_dtype = None
    elif patch_dtype in ["target"]:
        ops.Linear.patch_dtype = patch_dtype
    else:
        ops.Linear.patch_dtype = getattr(torch, patch_dtype)

    sd, extra = gguf_sd_loader(path)

    kwargs = {}
    valid_params = inspect.signature(comfy.sd.load_diffusion_model_state_dict).parameters
    if "metadata" in valid_params:
        kwargs["metadata"] = extra.get("metadata", {})
    # [jupo] 新しい ComfyUI は既定で DynamicVRAM 用の ModelPatcher を使うが、
    # GGUF のパッチ処理は従来の ModelPatcher 前提なので無効化する
    if "disable_dynamic" in valid_params:
        kwargs["disable_dynamic"] = True

    model = comfy.sd.load_diffusion_model_state_dict(
        sd, model_options={"custom_operations": ops}, **kwargs,
    )
    if model is None:
        logging.error("ERROR UNSUPPORTED UNET {}".format(path))
        raise RuntimeError("ERROR: Could not detect model type of: {}".format(path))
    model = GGUFModelPatcher.clone(model)
    model.patch_on_device = patch_on_device
    _pad_memory_estimate(model)
    return model


# [jupo] 従来の ModelPatcher のメモリ見積もりは余裕が少なく、GGUF では
# 推論時に各レイヤーを逆量子化する一時バッファ (非同期オフロードのストリーム数ぶん) が
# 必要になるため、16GB 級の GPU で VRAM を重みで埋め切って OOM になりやすい。
# ComfyUI 本体が DynamicVRAM 側で行っている補正 (×1.3 + 1GB) に倣い、
# さらに最大レイヤーの逆量子化サイズ × 3 を上乗せする。
_MEMORY_PAD_RATIO = 1.3
_MEMORY_PAD_BYTES = 1024 ** 3
_DEQUANT_BUFFERS = 3


def _largest_dequant_bytes(model_patcher) -> int:
    largest = 0
    try:
        for p in model_patcher.model.diffusion_model.parameters():
            if not is_quantized(p):
                continue
            shape = getattr(p, "tensor_shape", p.shape)
            n = 1
            for d in shape:
                n *= int(d)
            largest = max(largest, n)
    except Exception:
        return 0
    return largest * 2  # fp16 に逆量子化


def _pad_memory_estimate(model_patcher):
    base_model = model_patcher.model
    if getattr(base_model, "_jupo_gguf_mem_padded", False):
        return
    original = base_model.memory_required
    extra = _MEMORY_PAD_BYTES + _largest_dequant_bytes(model_patcher) * _DEQUANT_BUFFERS

    def memory_required(*args, **kwargs):
        return original(*args, **kwargs) * _MEMORY_PAD_RATIO + extra

    base_model.memory_required = memory_required
    base_model._jupo_gguf_mem_padded = True
    logging.info(f"[JupoGGUF] VRAM 見積もりに余裕を追加: ×{_MEMORY_PAD_RATIO} + {extra / 1024**2:.0f}MB")
