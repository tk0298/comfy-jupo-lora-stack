import torch
import comfy.model_management
import comfy.utils
from .utils import Field

MAX_RESOLUTION = 16384


class JupoEmptyLatentImage:
    """空の潜在画像を生成するノード（縦横入替トグル付き）"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width":            Field.int(default=1024, min=16, max=MAX_RESOLUTION, step=8, tooltip="潜在画像の幅（ピクセル）"),
                "height":           Field.int(default=1024, min=16, max=MAX_RESOLUTION, step=8, tooltip="潜在画像の高さ（ピクセル）"),
                "swap_dimensions":  Field.boolean(default=False, label_on="縦横入替 ON", label_off="縦横入替 OFF", tooltip="幅と高さを入れ替えます"),
                "batch_size":       Field.int(default=1, min=1, max=4096, tooltip="バッチサイズ"),
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    OUTPUT_TOOLTIPS = ("空の潜在画像バッチ",)
    FUNCTION = "generate"
    DESCRIPTION = "空の潜在画像を生成します（縦横入替トグル付き）"

    def generate(self, width, height, swap_dimensions=False, batch_size=1):
        if swap_dimensions:
            width, height = height, width
        latent = torch.zeros(
            [batch_size, 4, height // 8, width // 8],
            device=comfy.model_management.intermediate_device(),
            dtype=comfy.model_management.intermediate_dtype(),
        )
        return ({"samples": latent, "downscale_ratio_spacial": 8},)


class JupoImageScale:
    """画像をリサイズするノード（縦横入替トグル付き）"""

    upscale_methods = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]
    crop_methods    = ["disabled", "center"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image":            Field.image(),
                "upscale_method":   Field.combo(cls.upscale_methods, default="lanczos"),
                "width":            Field.int(default=1024, min=0, max=MAX_RESOLUTION, step=1, tooltip="幅（0 で縦横比を維持して自動計算）"),
                "height":           Field.int(default=1024, min=0, max=MAX_RESOLUTION, step=1, tooltip="高さ（0 で縦横比を維持して自動計算）"),
                "swap_dimensions":  Field.boolean(default=False, label_on="縦横入替 ON", label_off="縦横入替 OFF", tooltip="幅と高さを入れ替えます"),
                "crop":             Field.combo(cls.crop_methods, default="disabled"),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "upscale"
    DESCRIPTION = "画像をリサイズします（縦横入替トグル付き）"

    def upscale(self, image, upscale_method, width, height, crop, swap_dimensions=False):
        if swap_dimensions:
            width, height = height, width

        if width == 0 and height == 0:
            return (image,)

        samples = image.movedim(-1, 1)

        if width == 0:
            width = max(1, round(samples.shape[3] * height / samples.shape[2]))
        elif height == 0:
            height = max(1, round(samples.shape[2] * width / samples.shape[3]))

        s = comfy.utils.common_upscale(samples, width, height, upscale_method, crop)
        return (s.movedim(1, -1),)
