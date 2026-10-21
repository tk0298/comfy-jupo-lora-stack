import { app } from "../../scripts/app.js";
import { mk_name } from "./utils.js";
import { applyContextMenuPatch } from "./context_menu_patch.js";

import { Utils } from "./ui.js"
import { PowerLoRASpacerWidget } from "./widgets/spacer_widget.js";
import { PowerLoRAButtonWidget } from "./widgets/button_widget.js";
import { PowerCheckpointCompoundWidget } from "./widgets/ckpt_widget.js";
import { installVueNodesRedrawHook } from "./widgets/base_widget.js";

const classNames = [mk_name("Checkpoint_Selector_(jupo)")];

// ==============================================
// addCustomWidget の互換ヘルパー
// 最新ComfyUIでは node.addCustomWidget() が廃止され
// widgets.push() が必要
// ==============================================
function safeAddCustomWidget(node, widget) {
    if (typeof node.addCustomWidget === "function") {
        return node.addCustomWidget(widget);
    }
    if (!node.widgets) node.widgets = [];
    node.widgets.push(widget);
    return widget;
}

// ==============================================
// checkpoint ウィジェットを非表示にするヘルパー
// ==============================================
function hideCheckpointWidget(widget) {
    if (!widget) return;
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
            safeAddCustomWidget(this, new PowerLoRASpacerWidget("spacerTop", { marginTop: 0, marginBottom: 0 }));

            // ヘッダー
            // checkpointにはヘッダーは必要ない

            safeAddCustomWidget(this, new PowerLoRASpacerWidget("spacerBottom", { marginTop: 4, marginBottom: 4 }));

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
            safeAddCustomWidget(this, addButton);
        };


        // --------------------------------------
        // addCheckpointWidget
        // --------------------------------------
        nodeType.prototype.addCheckpointWidget = function(selected = "None") {
            this.counter++;

            const checkpointWidget = new PowerCheckpointCompoundWidget(`checkpoint_${this.counter}`, {
                enabled: true, 
                path: selected, 
                deleteCallback: (widget) => this.removeCheckpointWidget(widget), 
                valueChangedCallback: () => this.updateCheckpointValue(), 
            });

            // spacerBottomの前にウィジェットを挿入
            if (!this.widgets) this.widgets = [];
            const spacerIndex = this.widgets.findIndex(w => w.name === "spacerBottom");
            if (spacerIndex !== -1) {
                this.widgets.splice(spacerIndex, 0, checkpointWidget);
            } else {
                this.widgets.push(checkpointWidget);
            }

            this.updateCheckpointValue();
            this.updateNodeSize();
            return checkpointWidget;
        };


        // --------------------------------------
        // removeCheckpointWidget
        // --------------------------------------
        nodeType.prototype.removeCheckpointWidget = function(widget) {
            const index = this.widgets?.indexOf(widget) ?? -1;
            if (index !== -1) {
                this.widgets.splice(index, 1);
            }
            this.updateCheckpointValue();
            this.updateNodeSize();
        };


        // --------------------------------------
        // clearAllWidgets
        // --------------------------------------
        nodeType.prototype.clearAllWidgets = function() {
            this.widgets = (this.widgets ?? []).filter(w => w.name === "checkpoint");
        };


        // --------------------------------------
        // updateCheckpointValue
        // --------------------------------------
        nodeType.prototype.updateCheckpointValue = function() {
            const checkpointWidget = this.widgets?.find(w => w.name === "checkpoint");
            if (checkpointWidget) {
                const enabledWidget = this.widgets
                    .filter(w => PowerCheckpointCompoundWidget.is(w))
                    .find(w => w.value.enabled);
                const value = enabledWidget?.value ?? {};
                checkpointWidget.value = JSON.stringify(value);
            }
            this.redrawCustomWidgets?.();
        };


        // --------------------------------------
        // updateNodeSize
        // --------------------------------------
        nodeType.prototype.updateNodeSize = function() {
            if (typeof this.computeSize !== "function") return;
            const computed = this.computeSize();
            if (!this.size) this.size = [300, 200];
            this.size[0] = Math.max(this.size[0], computed[0]);
            this.size[1] = Math.max(this.size[1], computed[1]);
            if (typeof this.setDirtyCanvas === "function") {
                this.setDirtyCanvas(true, true);
            }
        };


        // --------------------------------------
        // disableAllWidgets
        // --------------------------------------
        nodeType.prototype.disableAllWidgets = function() {
            this.widgets?.forEach(w => {
                if (PowerCheckpointCompoundWidget.is(w) && w.value?.enabled) {
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
                if (!!w.value?.enabled !== shouldEnable) {
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
                .filter(w => PowerCheckpointCompoundWidget.is(w) && w.value?.enabled);
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
                .map(w => ({ ...w.value }));
            
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
                    const widget = this.addCheckpointWidget(value.path);
                    widget.value = { ...value };
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
