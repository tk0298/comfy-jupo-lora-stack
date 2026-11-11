

function create_slider_info(key_prefix, name_prefix, start, end, type) {
    let result = [];

    if (start <= end) {
        for (let i = start; i <= end; i++) {
            let key = `${key_prefix}.${i}.`;
            let name = `${name_prefix}.${String(i).padStart(2, "0")}`;
            result.push([key, name, type]);
        }
    } else {
        for (let i = start; i >= end; i--) {
            let key = `${key_prefix}.${i}.`;
            let name = `${name_prefix}.${String(i).padStart(2, "0")}`;
            result.push([key, name, type]);
        }
    }

    return result;
}


export const BlockConfigs = {
    SD: {
        upper: [
            ["transformer.text_model.encoder.", "BASE", "clip"]
        ], 
        bottom: [
            ["middle_block.", "MIDDLE", "model"]
        ], 
        left: create_slider_info("input_blocks", "INPUT", 0, 11, "model"), 
        right: create_slider_info("output_blocks", "OUTPUT", 0, 11, "model"), 
    }, 

    FLUX: {
        upper: [
            ["clip_", "CLIP", "clip"], 
            ["t5xxl", "T5", "clip"], 
        ], 
        left: [
            ["_in", "IN", "model"], 
            ...create_slider_info("double_blocks", "DOUBLE", 0, 18, "model")
        ], 
        right: [
            ...create_slider_info("single_blocks", "SINGLE", 0, 37, "model"), 
            ["final_layer", "OUT", "model"], 
        ], 
    }, 

    WAN: {
        left: create_slider_info("blocks", "BLOCK", 0, 19, "model"), 
        right: create_slider_info("blocks", "BLOCK", 20, 39, "model"), 
    }, 

    ANIMA: {
        upper: [
            ["lora_te", "TE", "clip"], 
        ], 
        left: create_slider_info("blocks", "BLOCK", 0, 13, "model"), 
        right: create_slider_info("blocks", "BLOCK", 14, 27, "model"), 
    }, 

    // MOSS-Image: 単一ストリームDiT (layers.0 ~ layers.41 の42層)
    // LoRAは各層の proj.{q,k,v,o,ffn_up_gate,ffn_down} を対象とする
    MOSS: {
        left: [
            ["video_embedder", "IN", "model"], 
            ...create_slider_info("layers", "LAYER", 0, 20, "model"), 
        ], 
        right: [
            ...create_slider_info("layers", "LAYER", 21, 41, "model"), 
            ["final_", "OUT", "model"], 
        ], 
    }, 

    // MiniMax H3 / H3 Image (P-H3-Image 含む): 単一ストリームDiT (blocks.0 ~ blocks.49 の50層)
    // キーに "diffusion_model." を含めて完全一致させる
    // ("blocks.1." だけだと token_refiner.blocks.1. にも一致してしまうため)
    MINIMAX_H3: {
        left: [
            ["diffusion_model.token_refiner.", "REFINER", "model"], 
            ...create_slider_info("diffusion_model.blocks", "BLOCK", 0, 24, "model"), 
        ], 
        right: [
            ...create_slider_info("diffusion_model.blocks", "BLOCK", 25, 49, "model"), 
            ["diffusion_model.final_layer.", "OUT", "model"], 
        ], 
    }, 
}