import { app } from "../../scripts/app.js";
import { mk_name } from "./utils.js";
import { applyContextMenuPatch } from "./context_menu_patch.js";
import { customize } from "./widgets/ckpt_widget.js";
import { Utils } from "./ui.js";
import { installVueContextMenuBridge } from "./widgets/base_widget.js";
import { CheckpointInfoDialog } from "./dialogs/checkpoint_info_dialog.js";


const classNames = [mk_name("Checkpoint_Loader_(jupo)")];

// ==============================================
// ノード拡張
// ==============================================
const extension = {
    name: mk_name("CheckpointLoader"), 
    init: async function(app) {
        applyContextMenuPatch(classNames);
        installVueContextMenuBridge();
    }, 

    // ノードの右クリックメニュー (従来キャンバス / Nodes 2.0 共通の公式API)
    // Nodes 2.0 では ckpt_name は Vue のドロップダウンになり、
    // カスタムエクスプローラ / 右クリックメニューが使えないため、ここから操作できるようにする
    getNodeMenuItems(node) {
        const nodeClass = node?.comfyClass ?? node?.type;
        if (!classNames.includes(nodeClass)) return [];
        const ckptWidget = node.widgets?.find(w => w.name === "ckpt_name");
        if (!ckptWidget) return [];

        return [null, {
            content: "📂 エクスプローラでCheckpointを選択",
            callback: (value, options, event) => {
                // 一時的にエクスプローラを強制 (設定でOFFでもここからは使えるように)
                const prev = Utils.useExplorer;
                Utils.useExplorer = true;
                Utils.showCheckpointChooser(event, ckptWidget.value, (selected) => {
                    const file = Utils.matchPathOption(selected, ckptWidget.options?.values);
                    if (typeof ckptWidget.setValue === "function") {
                        ckptWidget.setValue(file, { node, canvas: app.canvas });
                    } else {
                        ckptWidget.value = file;
                        ckptWidget.callback?.(file);
                    }
                    node.setDirtyCanvas?.(true, true);
                }).finally(() => { Utils.useExplorer = prev; });
            }
        }, {
            content: "ℹ️ Checkpoint情報を開く",
            callback: async () => {
                const dialog = new CheckpointInfoDialog(ckptWidget, true);
                await dialog.show();
            }
        }];
    },

    beforeRegisterNodeDef: async function (nodeType, nodeData, app) {
        const nodeClass = nodeType.comfyClass ?? nodeData?.name;
        if (!classNames.includes(nodeClass)) return;

        // --- on Node Created -----------------------
        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            const result = origOnNodeCreated?.apply(this, arguments);
            
            const ckptWidget = this.widgets.find(w => w.name === "ckpt_name");
            this.customizeCkptWidget(ckptWidget);

            return result;
        };


        // --- ckptWidgetをカスタマイズ ----------------
        nodeType.prototype.customizeCkptWidget = function(ckptWidget) {
            customize(ckptWidget);
        };


        // --- コンテキストメニュー関連メソッド -----------------
        nodeType.prototype.getClickedWidget = function(x, y) {
            // ckptWigetをクリックしたか判定
            const ckptWidget = this.widgets.find(w => w.name === "ckpt_name");
            if (ckptWidget) {
                if (ckptWidget.isClickedAt(x, y, this)) {
                    return ckptWidget;
                }
            }
            return null;
        }
    }
};

app.registerExtension(extension);