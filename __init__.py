from typing_extensions import override
from comfy_api.latest import ComfyExtension

from .py import endpoints # noqa: F401
from .py import lora_stack
from .py import checkpoint_loader


class Extension(ComfyExtension):
    @override
    async def get_node_list(self):
        return [
            lora_stack.JupoLoRAStack, 
            lora_stack.JupoLoRALoader, 
            lora_stack.ApplyLoRAStack, 
            lora_stack.StackToWanWrapper, 
            
            checkpoint_loader.JupoCheckpointLoader, 
            checkpoint_loader.JupoCheckpointSelector
        ]


async def comfy_entrypoint():
    return Extension()


WEB_DIRECTORY = "./web"

