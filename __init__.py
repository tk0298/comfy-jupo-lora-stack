from .py.utils import mk_name, un_name, set_default_category
from .py import endpoints # noqa: F401
from .py import lora_stack
from .py import checkpoint_loader
from .py import image_utils

NODE_CLASS_MAPPINGS = {
    mk_name("LoRA_Stack_(jupo)"): lora_stack.JupoLoRAStack, 
    mk_name("LoRA_Loader_(jupo)"): lora_stack.JupoLoRALoader, 
    mk_name("Apply_LoRA_Stack"): lora_stack.ApplyLoRAStack, 
    mk_name("Stack_to_WanWrapper"): lora_stack.StackToWanWrapper, 
    mk_name("Stack_to_AnimaWrapper"): lora_stack.StackToAnimaWrapper, 
    
    mk_name("Checkpoint_Loader_(jupo)"): checkpoint_loader.JupoCheckpointLoader, 
    mk_name("Checkpoint_Selector_(jupo)"): checkpoint_loader.JupoCheckpointSelector, 

    mk_name("Empty_Latent_Image_(jupo)"): image_utils.JupoEmptyLatentImage,
    mk_name("Image_Scale_(jupo)"): image_utils.JupoImageScale,
}

set_default_category(NODE_CLASS_MAPPINGS)

NODE_DISPLAY_NAME_MAPPINGS = {k: un_name(k) for k in NODE_CLASS_MAPPINGS}
WEB_DIRECTORY = "./web"

