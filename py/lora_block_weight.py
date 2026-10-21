import folder_paths
import comfy.utils
import comfy.lora
import comfy.lora_convert
import comfy.hooks
import logging

from .lora_compat import build_state_dict_fallback_map, diffusion_model_arch_name

# 型用
from comfy.model_patcher import ModelPatcher
from comfy.sd import CLIP

# 本体のキー変換テーブルで一致するキーの割合がこの値未満の場合、
# state_dict ベースのフォールバックマッピングを試みる (MiniMax H3 等対策)
_FALLBACK_MATCH_THRESHOLD = 0.5


# -----------------------------------------------
# Anima LoRA ユーティリティ
# -----------------------------------------------

# Anima LoRA に含まれるが推論に不要な pos_embedder キーのプレフィックス
_ANIMA_LORA_FILTER_PREFIXES = (
    "pos_embedder.",
)

def _is_anima_lora(lora_name: str) -> bool:
    """LoRAファイル名・パスから Anima LoRA かどうかを判定する"""
    lower = lora_name.replace("\\", "/").lower()
    return "anima" in lower

def _filter_anima_lora_keys(lora: dict) -> dict:
    """
    Anima LoRA の pos_embedder キーをフィルタして除去する。
    これらのキーは Anima チェックポイント固有の位置エンコーダ用ウェイトで
    LoRA の推論には影響しない。
    """
    filtered = {}
    skipped = []
    for key in lora:
        if any(key.startswith(prefix) for prefix in _ANIMA_LORA_FILTER_PREFIXES):
            skipped.append(key)
        else:
            filtered[key] = lora[key]
    if skipped:
        import logging
        logging.info(f"[LBWLoRALoader] Anima LoRA: pos_embedder キーをスキップ ({len(skipped)}個): {skipped[:3]}{'...' if len(skipped) > 3 else ''}")
    return filtered


# -----------------------------------------------
# LBW 用 Hookクラス
# -----------------------------------------------
class LBWWeightHook(comfy.hooks.WeightHook):
    def __init__(self, strength_model=1, strength_clip=1, loaded: dict={}, lbw_map: dict={}):
        super().__init__(strength_model, strength_clip)
        self.loaded = loaded
        self.lbw_map = lbw_map
    
        
    def add_hook_patches(self, model, model_options, target_dict, registered):
        if not self.should_register(model, model_options, target_dict, registered):
            return False
        
        target = target_dict.get("target", None)
        if target == comfy.hooks.EnumWeightTarget.Clip:
            strength = self._strength_clip
        else:
            strength = self._strength_model
        
        for key, value in self.loaded.items():
            patch = {key: value}
            strength_patch = strength * self.lbw_map.get(key, 1)
            model.add_hook_patches(self, patch, strength_patch)
        
        registered.add(self)
        return True
    
    def clone(self):
        c: LBWWeightHook = super().clone()
        c.loaded = self.loaded
        c.lbw_map = self.lbw_map
        return c
    



class LBWLoRALoader:
    def __init__(self):
        self.loaded_lora = None
        
    # -------------------------------------------
    # メインメソッド 通常版
    # -------------------------------------------
    def load_lora(self, model: ModelPatcher, clip: CLIP, lora_name: str, strength_model: float, strength_clip: float, lbw: dict[str, dict]):
        if strength_model == 0 and strength_clip == 0:
            return (model, clip)
        
        lora = self.prepare_lora(lora_name)
        loaded, model_mapped, clip_mapped = self.create_lbw_info(model, clip, lora, lbw)

        for key, value in loaded.items():
            patch = {key: value}
            strength_patch_model = strength_model * model_mapped.get(key, 1)
            strength_patch_clip = strength_clip * clip_mapped.get(key, 1)
            
            if model:
                model.add_patches(patch, strength_patch_model)
            if clip:
                clip.patcher.add_patches(patch, strength_patch_clip)
        
        return (model, clip)
    
    
    # -------------------------------------------
    # メインメソッド Hook版
    # -------------------------------------------    
    def load_lora_with_hook(self, model: ModelPatcher, clip: CLIP, lora_name: str, strength_model: float, strength_clip: float, lbw: dict[str, dict], start: float, end: float, prev_hooks: comfy.hooks.HookGroup):
        if prev_hooks is None:
            prev_hooks = comfy.hooks.HookGroup()
        prev_hooks = prev_hooks.clone()
        
        if strength_model == 0 and strength_clip == 0:
            return prev_hooks
        
        lora = self.prepare_lora(lora_name)
        
        # LBW
        hooks_lbw = self.create_lbw_hook(model, clip, lora, strength_model, strength_clip, lbw)
        
        # Schedule
        hook_kf = self.create_schedule_hook(start, end)
        hooks_lbw = hooks_lbw.clone()
        hooks_lbw.set_keyframes_on_hooks(hook_kf=hook_kf)
        
        hooks = prev_hooks.clone_and_combine((hooks_lbw), )
        return hooks
    
    
    # -------------------------------------------
    # LBW
    # -------------------------------------------
    def create_lbw_hook(self, model: ModelPatcher, clip: CLIP, lora: dict, strength_model: float, strength_clip: float, lbw: dict[str, dict]):
        loaded, model_mapped, clip_mapped = self.create_lbw_info(model, clip, lora, lbw)
        lbw_map = model_mapped | clip_mapped
        
        hook_group = comfy.hooks.HookGroup()
        if len(lbw_map) > 0:
            hook = LBWWeightHook(strength_model, strength_clip, loaded, lbw_map)
        else:
            hook = comfy.hooks.WeightHook(strength_model, strength_clip)
            hook.weights = lora
        
        hook_group.add(hook)
        return hook_group
    
    
    def create_lbw_info(self, model: ModelPatcher, clip: CLIP, lora: dict, lbw: dict[str, dict]):
        model_key_map = {}
        clip_key_map = {}

        model_mapped = {}
        clip_mapped = {}

        if model is not None:
            model_key_map = comfy.lora.model_lora_keys_unet(model.model)
        
        if clip is not None:
            clip_key_map = comfy.lora.model_lora_keys_clip(clip.cond_stage_model)
        
        key_map = model_key_map | clip_key_map
        lora = comfy.lora_convert.convert_lora(lora)
        loaded = comfy.lora.load_lora(lora, key_map)

        # 本体のキー変換テーブルで一致するキーが極端に少ない場合
        # (MiniMax H3 等、本体が未対応のアーキテクチャで生の state_dict
        # キー名を使う LoRA など)、モデルの state_dict から生成した
        # フォールバック対応表を model 側に限定して併用する。
        total_entries = len(lora)
        if model is not None and total_entries > 0 and len(loaded) / total_entries < _FALLBACK_MATCH_THRESHOLD:
            fallback_map = build_state_dict_fallback_map(model)
            if fallback_map:
                merged_model_map = {**fallback_map, **model_key_map}
                merged_key_map = merged_model_map | clip_key_map
                loaded_fb = comfy.lora.load_lora(lora, merged_key_map)
                if len(loaded_fb) > len(loaded):
                    arch = diffusion_model_arch_name(model)
                    arch_label = f" [{arch}]" if arch else ""
                    logging.info(
                        "[LBWLoRALoader] 本体のキー変換テーブルで一致するキーが少ないため、"
                        f"state_dict ベースの互換マッピングを適用しました{arch_label} "
                        f"({len(loaded)} -> {len(loaded_fb)} / {total_entries} キー一致)"
                    )
                    loaded = loaded_fb
                    model_key_map = merged_model_map

        model_block_info = lbw.get("model", {})
        model_mapped = self.mapping_block_info(model_block_info, model_key_map)

        clip_block_info = lbw.get("clip", {})
        clip_mapped = self.mapping_block_info(clip_block_info, clip_key_map)

        return (loaded, model_mapped, clip_mapped)
    
    
    def mapping_block_info(self, block_info: dict, lora_key_map: dict):
        normalized = {}

        internal_keys = list(lora_key_map.values())

        for search_key, weight in block_info.items():
            for internal_key in internal_keys:
                if search_key in internal_key:
                    normalized[internal_key] = weight
        
        return normalized


    
    # -------------------------------------------
    # Schedule
    # -------------------------------------------
    def create_schedule_hook(self, start: float, end: float):
        
        keyframe_group = comfy.hooks.HookKeyframeGroup()
        keyframe_group = keyframe_group.clone()
        
        # startよりも前は強度0
        if start > 0:
            keyframe = comfy.hooks.HookKeyframe(strength=0, start_percent=0)
            keyframe_group.add(keyframe)
        
        # startから強度1
        keyframe = comfy.hooks.HookKeyframe(strength=1, start_percent=start)
        keyframe_group.add(keyframe)

        # endから強度0
        keyframe = comfy.hooks.HookKeyframe(strength=0, start_percent=end)
        keyframe_group.add(keyframe)


        return keyframe_group
        

    
    # -------------------------------------------
    # ユーティリティ
    # -------------------------------------------
    def prepare_lora(self, lora_name: str):
        lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
        lora = None
        if self.loaded_lora is not None:
            if self.loaded_lora[0] == lora_path:
                lora = self.loaded_lora[1]
            else:
                temp = self.loaded_lora
                self.loaded_lora = None
                del temp
        
        if lora is None:
            lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
            # Anima LoRA の場合は pos_embedder キーをフィルタする
            if _is_anima_lora(lora_name):
                lora = _filter_anima_lora_keys(lora)
            self.loaded_lora = (lora_path, lora)
        
        return lora
    
    