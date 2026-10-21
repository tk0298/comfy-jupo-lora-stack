import { app } from "../../scripts/app.js";
import { mk_name } from "./utils.js";
import { applyContextMenuPatch } from "./context_menu_patch.js";

import { CONSTANTS, Utils, Renderer } from "./ui.js";
import { settings } from "./settings.js";
import { PowerLoRAHeaderWidget } from "./widgets/header_widget.js";
import { PowerLoRASpacerWidget } from "./widgets/spacer_widget.js";
import { PowerLoRAButtonWidget } from "./widgets/button_widget.js";
import { PowerLoRACompoundWidget } from "./widgets/lora_widget.js";
import { installVueNodesRedrawHook } from "./widgets/base_widget.js";


const classNames = [mk_name("LoRA_Stack_(jupo)"), mk_name("LoRA_Loader_(jupo)")];


// ==============================================
// addCustomWidget の互換ヘルパー
// 最新ComfyUIでは node.addCustomWidget() が廃止され
// widgets.push() + computeSize() 再計算が必要
// ==============================================
function safeAddCustomWidget(node, widget) {
    // 旧API: node.addCustomWidget(widget) が存在すればそちらを使用
    if (typeof node.addCustomWidget === "function") {
        return node.addCustomWidget(widget);
    }
    // 新API: widgets 配列に直接追加
    if (!node.widgets) node.widgets = [];
    node.widgets.push(widget);
    return widget;
}

// ==============================================
// lora_list ウィジェットを非表示にするヘルパー
// 最新版では type="hidden" が無効になったため
// computeSize 無効化で代用
// ==============================================
function hideLoraListWidget(widget) {
    if (!widget) return;
    // 方法1: type を hidden に (旧来の方法)
    widget.type = "hidden";
    // 方法2: 描画サイズを 0 にする (最新版対応)
    widget.computeSize = () => [0, -4];
    widget.serializeValue = async () => widget.value;
    // 方法3: 表示フラグ (一部バージョン対応)
    widget.hidden = true;
}


// ==============================================
// ノード拡張
// ==============================================
const extension = {
    name: mk_name("LoRAStack"),

    settings: settings.slice().reverse(),

    init: async function(app) {
        applyContextMenuPatch(classNames);
    },

    beforeRegisterNodeDef: async function(nodeType, nodeData, app) {
        // 最新ComfyUIでは nodeType.comfyClass が undefined の場合があるため
        // nodeData.name をフォールバックとして使用
        const nodeClass = nodeType.comfyClass ?? nodeData?.name;
        if (!classNames.includes(nodeClass)) return;

        // Nodes 2.0 (Vue ノード) で値変更後に再描画されない問題への対策
        installVueNodesRedrawHook(nodeType);

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        const originalSerialize = nodeType.prototype.serialize;
        const originalConfigure = nodeType.prototype.configure;

        nodeType.prototype.onNodeCreated = function() {
            const result = originalOnNodeCreated?.apply(this, arguments);

            // lora_list 入力を非表示にする
            const loraListWidget = this.widgets?.find(w => w.name === "lora_list");
            if (loraListWidget) {
                hideLoraListWidget(loraListWidget);
            }

            this.loraCounter = 0;
            this.loraWidgets = [];
            this.serialize_widgets = true;
            this.loraDisplayMode = "filename";
            this.clipSettingMode = "common";
            this.initializeUI();
            this.updateNodeSize();

            return result;
        };

        // lora_list の隠しフィールドを更新
        nodeType.prototype.updateLoraListValue = function() {
            const loraListWidget = this.widgets?.find(w => w.name === "lora_list");
            if (loraListWidget) {
                const loraList = this.loraWidgets.map(widget => widget.value);
                loraListWidget.value = JSON.stringify(loraList);
            }
        };

        // ===== シリアライズ =====
        // 最新ComfyUI では onSerialize(data) が推奨されるが
        // serialize() オーバーライドも引き続き動作する
        nodeType.prototype.serialize = function() {
            const data = originalSerialize?.apply(this, arguments) || {};

            data.lora_list = this.widgets
                ?.filter(widget => PowerLoRACompoundWidget.is(widget))
                .map(widget => widget.value) ?? [];

            data.lora_display_mode = this.loraDisplayMode;
            data.clip_setting_mode = this.clipSettingMode;

            return data;
        };

        // ===== デシリアライズ =====
        // 親の configure() は widgets_values を this.widgets に
        // 位置/名前ベースで復元するが、動的に増減する lora ウィジェットとは
        // 噛み合わず、後から呼ぶとカスタム復元結果を上書きしてしまう
        // (最新ComfyUIで顕在化)。
        // そのため widgets_values を渡さずに親を先に呼び、
        // カスタム復元は最後に行うことで常に自前の状態を優先させる。
        nodeType.prototype.configure = function(data) {
            const { widgets_values, ...safeData } = data || {};

            let result;
            try {
                result = originalConfigure?.apply(this, [safeData]);
            } catch (e) {
                console.warn("[LoRAStack] configure() parent call failed:", e);
            }

            this.clearAllWidgets();

            this.loraDisplayMode = data.lora_display_mode ?? "filename";
            this.clipSettingMode = data.clip_setting_mode ?? "common";

            this.initializeUI();

            if (Array.isArray(data.lora_list)) {
                data.lora_list.forEach(widgetData => {
                    const widget = this.addLoRAWidget(widgetData.lora);
                    widget.value = widgetData;
                });
            }

            this.updateLoraListValue();
            this.updateNodeSize();

            return result;
        };

        nodeType.prototype.initializeUI = function() {
            safeAddCustomWidget(this, new PowerLoRASpacerWidget("spacerTop", { marginTop: 0, marginBottom: 0 }));
            safeAddCustomWidget(this, new PowerLoRAHeaderWidget("lora_header"));
            safeAddCustomWidget(this, new PowerLoRASpacerWidget("spacerBottom", { marginTop: 4, marginBottom: 4 }));

            const addButton = new PowerLoRAButtonWidget(
                "add_lora_button",
                "➕ LoRAを追加",
                (event, pos, node) => {
                    Utils.showLoRAChooser(event, "None", (selectedLora) => {
                        this.addLoRAWidget(selectedLora);
                    });
                    return true;
                }
            );
            safeAddCustomWidget(this, addButton);
        };

        nodeType.prototype.addLoRAWidget = function(selectedLora = "None") {
            this.loraCounter++;

            const loraWidget = new PowerLoRACompoundWidget(`lora_${this.loraCounter}`, {
                enabled: true,
                lora: selectedLora,
                strength_model: 1.0,
                strength_clip: 1.0,
                clip_mode: this.clipSettingMode === "individual",
                deleteCallback: (widget) => this.removeLoRAWidget(widget),
                valueChangedCallback: () => this.updateLoraListValue(),
            });

            this.loraWidgets.push(loraWidget);

            // spacerBottom の前に挿入
            if (!this.widgets) this.widgets = [];
            const spacerIndex = this.widgets.findIndex(w => w.name === "spacerBottom");
            if (spacerIndex !== -1) {
                this.widgets.splice(spacerIndex, 0, loraWidget);
            } else {
                this.widgets.push(loraWidget);
            }

            this.updateLoraListValue();
            this.updateNodeSize();
            return loraWidget;
        };

        nodeType.prototype.removeLoRAWidget = function(widget) {
            const index = this.loraWidgets.indexOf(widget);
            if (index !== -1) {
                this.loraWidgets.splice(index, 1);
                const widgetIndex = this.widgets?.indexOf(widget) ?? -1;
                if (widgetIndex !== -1) {
                    this.widgets.splice(widgetIndex, 1);
                }
                this.updateLoraListValue();
                this.updateNodeSize();
            }
        };

        nodeType.prototype.clearAllWidgets = function() {
            // lora_list ウィジェットだけ残し、他は削除
            this.widgets = (this.widgets ?? []).filter(w => w.name === "lora_list");
            this.loraWidgets = [];
        };

        nodeType.prototype.updateNodeSize = function() {
            // computeSize が存在しない場合の安全ガード
            if (typeof this.computeSize !== "function") return;
            const computed = this.computeSize();
            if (!this.size) this.size = [300, 200];
            this.size[0] = Math.max(this.size[0], computed[0]);
            this.size[1] = Math.max(this.size[1], computed[1]);
            if (typeof this.setDirtyCanvas === "function") {
                this.setDirtyCanvas(true, true);
            }
        };

        // ===== コンテキストメニュー =====
        nodeType.prototype.getClickedWidget = function(x, y) {
            for (const widget of (this.widgets ?? [])) {
                if (PowerLoRACompoundWidget.is(widget)) {
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
