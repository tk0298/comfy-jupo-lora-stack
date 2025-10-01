from comfy_api.latest import io
from .utils import mk_name, category
from .lora_block_weight import LBWLoRALoader
from nodes import LoraLoader

import folder_paths
from comfy.model_patcher import ModelPatcher
from comfy.sd import CLIP
import comfy.hooks
import os
from pathlib import Path
import json


def get_available_loras(stack: list[dict]) -> list[dict]:
    available_loras = []
    exist_loras = folder_paths.get_filename_list("loras")

    for value in stack:
        file = value.get("lora")
        
        if file in exist_loras:
            available_loras.append(value)
        else:
            if not file == "None":
                print(f"{file} is not Found. skipped.")
    
    return available_loras


def get_stack(lora_list_str="") -> tuple[list[dict], dict]:

    lora_list = json.loads(lora_list_str)
    for lora in lora_list:
        lora["lora"] = str(Path(lora.get("lora"))) # パス形式を統一
    
    stack = []
    trigger = ""
    if lora_list:
        stack = lora_list
        
        for lora in lora_list:
            enabled = lora.get("enabled", False)
            enable_trigger = lora.get("enabled_trigger", False)
            trigger_value = lora.get("trigger", "")
            if enabled and enable_trigger and trigger_value.strip():
                trigger += trigger_value
    
    return (stack, trigger)


def apply_stack(stack, model: ModelPatcher=None, clip: CLIP=None):
    available_loras = get_available_loras(stack)
    prev_hooks = None
    
    model = model.clone() if model else None
    clip = clip.clone() if clip else None
        
    for value in available_loras:
        enabled = value.get("enabled", False)
        file = value.get("lora", "")
        strength_model = value.get("strength_model", 1)
        strength_clip = value.get("strength_clip", 1)
        clip_mode = value.get("clip_mode", False)
        
        enabled_lbw = value.get("enabled_block", False)
        lbw = value.get("block", {})
        
        start = max(0, value.get("start", 0))
        end = min(value.get("end", 1), 1)
        
        if not enabled: continue
        if not file or file == "None": continue
        
        if not clip_mode:
            strength_clip = strength_model
        
        if clip is None:
            strength_clip = 0
        
        if not enabled_lbw:
            lbw = {}
        
        
        if start > 0 or end < 1:
            prev_hooks = LBWLoRALoader().load_lora_with_hook(
                model, 
                clip, 
                file, 
                strength_model, 
                strength_clip, 
                lbw, 
                start, 
                end, 
                prev_hooks
            )
        elif enabled_lbw:
            model, clip = LBWLoRALoader().load_lora(
                model, 
                clip, 
                file, 
                strength_model, 
                strength_clip, 
                lbw, 
            )
        else:
            model, clip = LoraLoader().load_lora(
                model, 
                clip, 
                file, 
                strength_model, 
                strength_clip
            )
    
    # Hookを適用
    hooks = prev_hooks
    if hooks is not None:
        if clip is not None:
            clip.apply_hooks_to_conds = hooks
            clip.patcher.forced_hooks = hooks.clone()
            clip.use_clip_schedule = True
            clip.patcher.register_all_hook_patches(hooks, comfy.hooks.create_target_dict(comfy.hooks.EnumWeightTarget.Clip))

    return (model, clip)


STACK = io.Custom("LORASTACK")

# ===============================================
# LoRA Stack
# ===============================================
class JupoLoRAStack(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id=mk_name("LoRA_Stack_(jupo)"), 
            display_name="LoRA Stack (jupo)", 
            category=category, 
            inputs=[
                STACK.Input("prev_stack", optional=True), 
                io.String.Input("prev_trigger", optional=True, force_input=True), 
                io.String.Input("lora_list", multiline=True, optional=True)
            ], 
            outputs=[
                STACK.Output(display_name="stack"), 
                io.String.Output(display_name="trigger")
            ]
        )
    
    @classmethod
    def execute(cls, prev_stack=[], prev_trigger="", lora_list=""):
        stack, trigger = get_stack(lora_list)

        stack = prev_stack + stack
        trigger = prev_trigger + trigger
        
        return io.NodeOutput(stack, trigger)


# ===============================================
# LoRA Loader
# ===============================================
class JupoLoRALoader(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id=mk_name("LoRA_Loader_(jupo)"), 
            display_name="LoRA Loader (jupo)", 
            category=category, 
            inputs=[
                io.Model.Input("model"), 
                io.Clip.Input("clip", optional=True), 
                STACK.Input("prev_stack", optional=True), 
                io.String.Input("prev_trigger", optional=True), 
                io.String.Input("lora_list", multiline=True, optional=True)
            ], 
            outputs=[
                io.Model.Output(), 
                io.Clip.Output(), 
                io.String.Output(display_name="trigger")
            ]
        )
    
    @classmethod
    def execute(cls, model, clip=None, prev_stack=[], prev_trigger="", lora_list=""):
        stack, trigger = get_stack(lora_list)
        stack = prev_stack + stack
        trigger = prev_trigger + trigger
        
        model, clip = apply_stack(stack, model, clip)

        return io.NodeOutput(model, clip, trigger)
        


# ===============================================
# Apply LoRA Stack
# ===============================================
class ApplyLoRAStack(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id=mk_name("Apply_LoRA_Stack"), 
            display_name="Apply LoRA Stack", 
            category=category, 
            inputs=[
                io.Model.Input("model"), 
                io.Clip.Input("clip", optional=True), 
                STACK.Input("stack", optional=True)
            ], 
            outputs=[
                io.Model.Output(), 
                io.Clip.Output()
            ]
        )
    
    @classmethod
    def execute(cls, model, clip=None, stack=[]):
        model, clip = apply_stack(stack, model, clip)

        return io.NodeOutput(model, clip)



# ===============================================
# Stack to WanVideo Wrapper
# ===============================================
WANLORA = io.Custom("WANVIDEOLORA")

class StackToWanWrapper(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id=mk_name("Stack_to_WanWrapper"), 
            display_name="Stack to WanWrapper", 
            category=category, 
            inputs=[
                STACK.Input("stack"), 
                io.Boolean.Input("low_mem_load", default=False), 
                io.Boolean.Input("merge_loras", default=True)
            ], 
            outputs=[
                WANLORA.Output()
            ]
        )
    
    @classmethod
    def execute(cls, stack: list, low_mem_load=False, merge_loras=True):
        loras_list = []
        available_loras = get_available_loras(stack)

        for value in available_loras:
            enabled = value.get("enabled", False)
            file = value.get("lora", "")
            strength_model = value.get("strength_model", 1)
            enabled_block = value.get("enabled_block", False)
            model_type = value.get("model_type", None)
            block_info = value.get("block", {}).get("model", {})

            if not enabled: continue
            if not file or file == "None": continue
            if strength_model == 0: continue
            
            if enabled:
                wrapper_lora = {
                    "path": folder_paths.get_full_path("loras", file), 
                    "strength": strength_model, 
                    "name": os.path.splitext(file)[0], 
                    "blocks": {}, 
                    "layer_filter": "", 
                    "low_mem_load": low_mem_load, 
                    "merge_loras": merge_loras
                }
                if enabled_block and model_type == "WAN" and block_info:
                    wrapper_lora["blocks"] = block_info

                loras_list.append(wrapper_lora)
        
        return io.NodeOutput(loras_list)



