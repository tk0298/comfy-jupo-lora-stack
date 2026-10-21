import { mk_name } from "./utils.js";
import { Utils } from "./ui.js";
import { ViewModeManager } from "./dialogs/explorer/view_mode_manager.js";
import { FileRenderManager } from "./dialogs/explorer/file_render_manager.js";

// ==============================================
// 設定オブジェクト
// ==============================================
const useCustomExplorerSetting = {
    name: "カスタムエクスプローラを使う", 
    id: mk_name("useExplorer"), 
    type: "boolean", 
    defaultValue: true, 
    onChange: (value) => {
        Utils.useExplorer = value;
    }, 
};

const explorerViewModeSetting = {
    name: "カスタムエクスプローラのビューモード", 
    id: mk_name("explorerViewMode"), 
    type: "combo", 
    defaultValue: "grid", 
    options: ["grid", "list"], 
    onChange: (value) => {
        ViewModeManager.viewMode = value;
    }, 
};

const explorerGridWidthSetting = {
    name: "カスタムエクスプローラのグリッド横幅", 
    id: mk_name("explorerGridWidth"), 
    // "slider" は旧API。最新ComfyUIでは "range" を使用 (後方互換のため両方対応)
    type: "range", 
    defaultValue: 150, 
    attrs: { min: 100, max: 300, step: 10 }, 
    onChange: (value) => {
        FileRenderManager.gridWidth = Number(value);
    }, 
};

const explorerGridHeightSetting = {
    name: "カスタムエクスプローラのグリッド高さ", 
    id: mk_name("explorerGridHeight"), 
    // "slider" は旧API。最新ComfyUIでは "range" を使用 (後方互換のため両方対応)
    type: "range", 
    defaultValue: 200, 
    attrs: { min: 100, max: 300, step: 10 }, 
    onChange: (value) => {
        FileRenderManager.gridHeight = Number(value);
    }, 
};


export const settings = [
    useCustomExplorerSetting, 
    explorerViewModeSetting, 
    explorerGridWidthSetting, 
    explorerGridHeightSetting
];
