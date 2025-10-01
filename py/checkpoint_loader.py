from comfy_api.latest import io
from .utils import mk_name, category

import folder_paths
import json
import comfy.sd


def load_checkpoint(ckpt_name: str):
    ckpt_path = folder_paths.get_full_path_or_raise("checkpoints", ckpt_name)
    out = comfy.sd.load_checkpoint_guess_config(ckpt_path, output_vae=True, output_clip=True, embedding_directory=folder_paths.get_folder_paths("embeddings"))
    model, clip, vae = out[:3]

    return model, clip, vae


# ===============================================
# Checkpoint Loader
# ===============================================

class JupoCheckpointLoader(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id=mk_name("Checkpoint_Loader_(jupo)"),  
            display_name="Checkpoint Loader (jupo)", 
            category=category, 
            inputs=[
                io.Combo.Input("ckpt_name", folder_paths.get_filename_list("checkpoints"))
            ], 
            outputs=[
                io.Model.Output(), 
                io.Clip.Output(), 
                io.Vae.Output()
            ]
        )
    
    @classmethod
    def execute(cls, ckpt_name: str):
        model, clip, vae = load_checkpoint(ckpt_name)

        return io.NodeOutput(model, clip, vae)


# ===============================================
# Checkpoint Selector
# ===============================================
class JupoCheckpointSelector(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id=mk_name("Checkpoint_Selector_(jupo)"), 
            display_name="Checkpoint Selector (jupo)", 
            category=category, 
            inputs=[
                io.String.Input("prev_trigger", force_input=True, optional=True), 
                io.String.Input("checkpoint", multiline=True, optional=True)
            ], 
            outputs=[
                io.Model.Output(), 
                io.Clip.Output(), 
                io.Vae.Output(), 
                io.String.Output(display_name="trigger")
            ]
        )
    
    @classmethod
    def execute(cls, prev_trigger="", checkpoint=""):
        value = json.loads(checkpoint)
        if not isinstance(value, dict):
            raise ValueError("checkpoint widget: 不正なJSON値です")
        
        enabled = value.get("enabled")
        if not enabled:
            raise ValueError("checkpoint widget: 有効なcheckpointがありません")
        
        path = value.get("path")
        model, clip, vae = load_checkpoint(path)

        trigger = prev_trigger
        enabled_trigger = value.get("enabled_trigger")
        trigger_value = value.get("trigger")
        if enabled_trigger and trigger_value.strip():
            trigger += trigger_value
        
        return io.NodeOutput(model, clip, vae, trigger)