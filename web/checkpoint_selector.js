import { app } from "../../scripts/app.js";
import { mk_name } from "./utils.js";
import { applyContextMenuPatch } from "./context_menu_patch.js";

import { Utils } from "./ui.js"
import { PowerLoRASpacerWidget } from "./widgets/spacer_widget.js";
import { PowerLoRAButtonWidget } from "./widgets/button_widget.js";
import { PowerCheckpointCompoundWidget } from "./widgets/ckpt_widget.js";
import {
    installVueNodesRedrawHook,
    installVueContextMenuBridge,
    insertWidget,
    removeWidget,
    growNodeToFit,
} from "./widgets/base_widget.js";

const classNames = [mk_name("Checkpoint_Selector_(jupo)")];

// ==============================================
// addCustomWidget の互換ヘルパー
// node.addCustomWidget() があればそれを使う (ストア登録・値復元が行われる)
// ==============================================
function safeAddCustomWidget(node, widget) {
    return insertWidget(node, widget);
}

// 装飾用ウィジェット (値を持たない) はワークフローに保存しない
function decorative(widget) {
    widget.serialize = false;
    return widget;
}

// ==============================================
// checkpoint ウィジェットを非表示にするヘルパー
// ==============================================
function hideCheckpointWidget(widget) {
    if (!widget) return;
    // Nodes 2.0 / 右パネルの両方から隠す
    try { widget.options ??= {}; widget.options.hideInPanel = true; } catch (_) {}
    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
    widget.serializeValue = async () => widget.value;
    widget.hidden = true;
}

// ==============================================
// ノード拡張
// ==============================================
const extension = {
    name: mk_name("CheckpointSelector"), 

    init: async function(app) {
        applyContextMenuPatch(classNames);
        installVueContextMenuBridge();
    }, 

    // ノードの右クリックメニュー (従来キャンバス / Nodes 2.0 共通の公式API)
    getNodeMenuItems(node) {
        const nodeClass = node?.comfyClass ?? node?.type;
        if (!classNames.includes(nodeClass)) return [];
        if (typeof node.addCheckpointWidget !== "function") return [];

        const items = [null, {
            content: "➕ Checkpointを追加",
            callback: (value, options, event) => {
                Utils.showCheckpointChooser(event, "None", (selected) => {
                    node.disableAllWidgets();
                    node.addCheckpointWidget(selected);
                });
            }
        }];

        const widgets = (node.widgets ?? []).filter(w => PowerCheckpointCompoundWidget.is(w));
        widgets.forEach((w, i) => {
            const v = w.getCurrentValue();
            const name = Utils.formatDisplayName(v.path, false, v.display_name);
            items.push({
                content: `${v.enabled ? "🟢" : "⚪"} Checkpoint ${i + 1}: ${name}`,
                has_submenu: true,
                submenu: { options: w.getMenuOptions(null, node) },
            });
        });
        return items;
    },

    beforeRegisterNodeDef: async function(nodeType, nodeData, app) {
        const nodeClass = nodeType.comfyClass ?? nodeData?.name;
        if (!classNames.includes(nodeClass)) return;

        // Nodes 2.0 (Vue ノード) で他ウィジェットのトグルが再描画されない問題への対策
        installVueNodesRedrawHook(nodeType);

        // --------------------------------------
        // onNodeCreated
        // --------------------------------------
        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            const result = originalOnNodeCreated?.apply(this, arguments);

            // checkpoint入力を非表示にする
            const checkpointWidget = this.widgets?.find(w => w.name === "checkpoint");
            if (checkpointWidget) {
                hideCheckpointWidget(checkpointWidget);
            }

            this.counter = 0;
            this.serialize_widgets = true;
            this.displayMode = "filename"; // filename or full
            this.initializeUI();
            this.updateNodeSize();

            return result;
        };


        // --------------------------------------
        // initializeUI
        // --------------------------------------
        nodeType.prototype.initializeUI = function() {
            safeAddCustomWidget(this, decorative(new PowerLoRASpacerWidget("spacerTop", { marginTop: 0, marginBottom: 0 })));

            // ヘッダー
            // checkpointにはヘッダーは必要ない

            safeAddCustomWidget(this, decorative(new PowerLoRASpacerWidget("spacerBottom", { marginTop: 4, marginBottom: 4 })));

            // 追加ボタン
            const addButton = new PowerLoRAButtonWidget(
                "add_checkpoint_botton", 
                "➕ Checkpointを追加", 
                (event, pos, node) => {
                    Utils.showCheckpointChooser(event, "None", (selected) => {
                        this.disableAllWidgets();
                        this.addCheckpointWidget(selected);
                    });
                    return true;
                }
            );
            safeAddCustomWidget(this, decorative(addButton));
        };


        // --------------------------------------
        // addCheckpointWidget
        // --------------------------------------
        nodeType.prototype.addCheckpointWidget = function(selected = "None", initialValue = null) {
            this.counter = (this.counter ?? 0) + 1;
            // ウィジェット名はノード内で一意である必要がある (ストアのキー)
            // "checkpoint" (隠し入力) と衝突しないよう番号付きの名前を使う
            while (this.widgets?.some(w => w.name === `checkpoint_${this.counter}`)) {
                this.counter++;
            }

            const value = {
                enabled: true, 
                path: selected, 
                ...(initialValue ?? {}),
            };

            let checkpointWidget = new PowerCheckpointCompoundWidget(`checkpoint_${this.counter}`, {
                ...value,
                deleteCallback: (widget) => this.removeCheckpointWidget(widget), 
                valueChangedCallback: () => this.updateCheckpointValue(), 
            });

            // spacerBottomの前にウィジェットを挿入
            const spacerIndex = this.widgets?.findIndex(w => w.name === "spacerBottom") ?? -1;
            checkpointWidget = insertWidget(this, checkpointWidget, spacerIndex);

            // ストアに同名の古い値が残っていた場合でも、確実にこの値で上書きする
            checkpointWidget.value = { ...value };

            this.updateCheckpointValue();
            this.updateNodeSize();
            return checkpointWidget;
        };


        // --------------------------------------
        // removeCheckpointWidget
        // --------------------------------------
        nodeType.prototype.removeCheckpointWidget = function(widget) {
            // splice ではなく removeWidget (ストアの値も削除される)
            removeWidget(this, widget);
            this.updateCheckpointValue();
            this.updateNodeSize();
        };


        // --------------------------------------
        // clearAllWidgets
        // --------------------------------------
        nodeType.prototype.clearAllWidgets = function() {
            const targets = (this.widgets ?? []).filter(w => w.name !== "checkpoint");
            for (const w of targets) removeWidget(this, w);
        };


        // --------------------------------------
        // updateCheckpointValue
        // --------------------------------------
        nodeType.prototype.updateCheckpointValue = function() {
            const checkpointWidget = this.widgets?.find(w => w.name === "checkpoint");
            if (checkpointWidget) {
                const enabledWidget = this.widgets
                    .filter(w => PowerCheckpointCompoundWidget.is(w))
                    .find(w => w.getCurrentValue()?.enabled);
                const value = enabledWidget?.getCurrentValue() ?? {};
                const json = JSON.stringify(value);
                if (checkpointWidget.value !== json) checkpointWidget.value = json;
            }
            this.redrawCustomWidgets?.();
        };


        // --------------------------------------
        // updateNodeSize
        // --------------------------------------
        nodeType.prototype.updateNodeSize = function() {
            growNodeToFit(this);
        };


        // --------------------------------------
        // disableAllWidgets
        // --------------------------------------
        nodeType.prototype.disableAllWidgets = function() {
            this.widgets?.forEach(w => {
                if (PowerCheckpointCompoundWidget.is(w) && w.getCurrentValue()?.enabled) {
                    w.updateValue({ enabled: false });
                }
            });
            this.updateCheckpointValue();
        };


        // --------------------------------------
        // selectCheckpointWidget
        // 指定ウィジェットだけを有効化する (ラジオ動作)
        // --------------------------------------
        nodeType.prototype.selectCheckpointWidget = function(target) {
            (this.widgets ?? []).forEach(w => {
                if (!PowerCheckpointCompoundWidget.is(w)) return;
                const shouldEnable = (w === target);
                if (!!w.getCurrentValue()?.enabled !== shouldEnable) {
                    w.updateValue({ enabled: shouldEnable });
                }
            });
            this.updateCheckpointValue();
            this.setDirtyCanvas?.(true, true);
        };


        // --------------------------------------
        // normalizeSelection
        // 複数が有効になっている壊れた状態を修復 (先頭の1つだけ残す)
        // --------------------------------------
        nodeType.prototype.normalizeSelection = function() {
            const enabled = (this.widgets ?? [])
                .filter(w => PowerCheckpointCompoundWidget.is(w) && w.getCurrentValue()?.enabled);
            if (enabled.length > 1) {
                this.selectCheckpointWidget(enabled[0]);
            }
        };


        // --------------------------------------
        // serialize
        // --------------------------------------
        const originalSerialize = nodeType.prototype.serialize;
        nodeType.prototype.serialize = function() {
            const data = originalSerialize?.apply(this, arguments) || {};

            data.widgetValues = (this.widgets ?? [])
                .filter(w => PowerCheckpointCompoundWidget.is(w))
                .map(w => ({ ...w.getCurrentValue() }));
            
            data.displayMode = this.displayMode;

            return data;
        };


        // --------------------------------------
        // configure
        // 親の configure() は widgets_values を this.widgets に
        // 位置/名前ベースで復元するが、動的に増減する checkpoint
        // ウィジェットとは噛み合わず、後から呼ぶとカスタム復元結果を
        // 上書きしてしまう (最新ComfyUIで顕在化)。
        // そのため widgets_values を渡さずに親を先に呼び、
        // カスタム復元は最後に行うことで常に自前の状態を優先させる。
        // --------------------------------------
        const originalConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function(data) {
            const { widgets_values, ...safeData } = data || {};

            let result;
            try {
                result = originalConfigure?.apply(this, [safeData]);
            } catch (e) {
                console.warn("[CheckpointSelector] configure() parent call failed:", e);
            }

            this.clearAllWidgets();
            this.displayMode = data.displayMode || "filename";
            this.initializeUI();

            if (data.widgetValues && Array.isArray(data.widgetValues)) {
                data.widgetValues.forEach(value => {
                    if (!value || typeof value !== "object") return;
                    this.addCheckpointWidget(value.path ?? "None", value);
                });
            }

            this.normalizeSelection();
            this.updateCheckpointValue();
            this.updateNodeSize();

            return result;
        };


        // --------------------------------------
        // コンテキストメニュー関連メソッド
        // getClickedWidget
        // --------------------------------------
        nodeType.prototype.getClickedWidget = function(x, y) {
            for (const widget of (this.widgets ?? [])) {
                if (PowerCheckpointCompoundWidget.is(widget)) {
                    if (widget.isClickedAt(x, y, this)) {
                        return widget;
                    }
                }
            }
            return null;
        };
    } 
};

app.registerExtension(extension);
