import { app } from "../../scripts/app.js";
import { mk_name } from "./utils.js";
import { applyContextMenuPatch } from "./context_menu_patch.js";

import { CONSTANTS, Utils, Renderer } from "./ui.js";
import { settings } from "./settings.js";
import { PowerLoRAHeaderWidget } from "./widgets/header_widget.js";
import { PowerLoRASpacerWidget } from "./widgets/spacer_widget.js";
import { PowerLoRAButtonWidget } from "./widgets/button_widget.js";
import { PowerLoRACompoundWidget } from "./widgets/lora_widget.js";
import {
    installVueNodesRedrawHook,
    installVueContextMenuBridge,
    insertWidget,
    removeWidget,
    growNodeToFit,
} from "./widgets/base_widget.js";


const classNames = [mk_name("LoRA_Stack_(jupo)"), mk_name("LoRA_Loader_(jupo)")];


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
// lora_list ウィジェットを非表示にするヘルパー
// 最新版では type="hidden" が無効になったため
// computeSize 無効化で代用
// ==============================================
function hideLoraListWidget(widget) {
    if (!widget) return;
    // Nodes 2.0 / 右パネルの両方から隠す
    try { widget.options ??= {}; widget.options.hideInPanel = true; } catch (_) {}
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
        installVueContextMenuBridge();
    },

    // ノードの右クリックメニュー (従来キャンバス / Nodes 2.0 共通の公式API)
    // Nodes 2.0 でウィジェット上以外を右クリックした場合もここから各LoRAを操作できる
    getNodeMenuItems(node) {
        const nodeClass = node?.comfyClass ?? node?.type;
        if (!classNames.includes(nodeClass)) return [];
        if (!Array.isArray(node.loraWidgets)) return [];

        const items = [null, {
            content: "➕ LoRAを追加",
            callback: (value, options, event) => {
                Utils.showLoRAChooser(event, "None", (selectedLora) => {
                    node.addLoRAWidget(selectedLora);
                });
            }
        }];

        // LoRA ごとにサブメニュー (Nodes 2.0 のメニューはサブメニュー1階層まで対応)
        node.loraWidgets.forEach((w, i) => {
            const v = w.getCurrentValue();
            const name = Utils.formatDisplayName(v.lora, false, v.display_name);
            items.push({
                content: `${v.enabled ? "🟢" : "⚪"} LoRA ${i + 1}: ${name}`,
                has_submenu: true,
                submenu: { options: w.getMenuOptions(null, node) },
            });
        });
        return items;
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
                const loraList = (this.loraWidgets ?? []).map(widget => widget.getCurrentValue());
                const json = JSON.stringify(loraList);
                if (loraListWidget.value !== json) loraListWidget.value = json;
            }
            // Nodes 2.0: ヘッダー (全体トグル) などの描画も更新する
            this.redrawCustomWidgets?.();
        };

        // ===== シリアライズ =====
        // 最新ComfyUI では onSerialize(data) が推奨されるが
        // serialize() オーバーライドも引き続き動作する
        nodeType.prototype.serialize = function() {
            const data = originalSerialize?.apply(this, arguments) || {};

            data.lora_list = this.widgets
                ?.filter(widget => PowerLoRACompoundWidget.is(widget))
                .map(widget => ({ ...widget.getCurrentValue() })) ?? [];

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

            // lora_list (ノード直下) が無い場合は、隠し lora_list ウィジェットの保存値から復元
            let loraList = data?.lora_list;
            if (!Array.isArray(loraList)) {
                const saved = data?.widgets_values_named?.lora_list;
                if (typeof saved === "string" && saved.trim()) {
                    try { loraList = JSON.parse(saved); } catch (_) { loraList = null; }
                }
            }

            if (Array.isArray(loraList)) {
                loraList.forEach(widgetData => {
                    if (!widgetData || typeof widgetData !== "object") return;
                    this.addLoRAWidget(widgetData.lora ?? "None", widgetData);
                });
            }

            this.updateLoraListValue();
            this.updateNodeSize();

            return result;
        };

        nodeType.prototype.initializeUI = function() {
            safeAddCustomWidget(this, decorative(new PowerLoRASpacerWidget("spacerTop", { marginTop: 0, marginBottom: 0 })));
            safeAddCustomWidget(this, decorative(new PowerLoRAHeaderWidget("lora_header")));
            safeAddCustomWidget(this, decorative(new PowerLoRASpacerWidget("spacerBottom", { marginTop: 4, marginBottom: 4 })));

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
            safeAddCustomWidget(this, decorative(addButton));
        };

        nodeType.prototype.addLoRAWidget = function(selectedLora = "None", initialValue = null) {
            this.loraWidgets ??= [];
            this.loraCounter = (this.loraCounter ?? 0) + 1;
            // ウィジェット名はノード内で一意である必要がある (ストアのキー)
            while (this.widgets?.some(w => w.name === `lora_${this.loraCounter}`)) {
                this.loraCounter++;
            }

            const value = {
                enabled: true,
                lora: selectedLora,
                strength_model: 1.0,
                strength_clip: 1.0,
                clip_mode: this.clipSettingMode === "individual",
                ...(initialValue ?? {}),
            };
            // 旧形式 (strength) の互換
            if (initialValue?.strength !== undefined && initialValue?.strength_model === undefined) {
                value.strength_model = initialValue.strength;
            }
            delete value.strength;

            let loraWidget = new PowerLoRACompoundWidget(`lora_${this.loraCounter}`, {
                ...value,
                deleteCallback: (widget) => this.removeLoRAWidget(widget),
                valueChangedCallback: () => this.updateLoraListValue(),
            });

            // spacerBottom の前に挿入
            const spacerIndex = this.widgets?.findIndex(w => w.name === "spacerBottom") ?? -1;
            loraWidget = insertWidget(this, loraWidget, spacerIndex);
            this.loraWidgets.push(loraWidget);

            // ストアに同名の古い値が残っていた場合でも、確実にこの値で上書きする
            loraWidget.value = { ...value };

            this.updateLoraListValue();
            this.updateNodeSize();
            return loraWidget;
        };

        nodeType.prototype.removeLoRAWidget = function(widget) {
            const index = this.loraWidgets?.indexOf(widget) ?? -1;
            if (index !== -1) {
                this.loraWidgets.splice(index, 1);
                // splice ではなく removeWidget (ストアの値も削除される)
                removeWidget(this, widget);
                this.updateLoraListValue();
                this.updateNodeSize();
            }
        };

        nodeType.prototype.clearAllWidgets = function() {
            // lora_list ウィジェットだけ残し、他は削除
            const targets = (this.widgets ?? []).filter(w => w.name !== "lora_list");
            for (const w of targets) removeWidget(this, w);
            this.loraWidgets = [];
        };

        nodeType.prototype.updateNodeSize = function() {
            growNodeToFit(this);
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
