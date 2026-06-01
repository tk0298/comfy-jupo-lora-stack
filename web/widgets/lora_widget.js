import { app } from "../../../scripts/app.js";

import { CONSTANTS, Utils, Renderer } from "../ui.js";
import { BaseWidget } from "./base_widget.js";
import { LoRAInfoDialog } from "../dialogs/lora_info_dialog.js";
import { LoRABlockWeightDialog } from "../dialogs/lora_block_weight_dialog.js";


// ==============================================
// LoRAコンパウンドウィジェット
// ==============================================

export class PowerLoRACompoundWidget extends BaseWidget {
    constructor(name = "lora_compound", options = {}) {
        super(name, "lora");
        this.haveMouseMovedNumber = false;
        this.haveMouseMovedClipNumber = false;
        
        const { deleteCallback, valueChangedCallback, ...valueOptions } = options;
        this.deleteCallback = deleteCallback;
        this.valueChangedCallback = valueChangedCallback;

        this._value = {
            enabled: true,
            lora: "None",
            display_name: null,

            strength_model: 1.0,

            clip_mode: false,
            strength_clip: 1.0,

            enabled_trigger: false, 
            trigger: "",

            enabled_block: false, 
            model_type: null, 
            block: null, 

            start: 0, 
            end: 1, 

            ...valueOptions
        };
        
        this.setupHitAreas();
    }
    
    get value() { return this._value; }
    set value(v) {
        let newValue = v;
        // 値が文字列であれば、JSONとして解析を試みる
        if (typeof v === 'string') {
            try {
                newValue = JSON.parse(v);
            } catch (e) {
                console.error("PowerLoRACompoundWidget: valueのJSON解析に失敗しました。", v, e);
                return; // 解析に失敗した場合は更新しない
            }
        }

        // 解析後の値がオブジェクトであることを確認してからマージする
        if (typeof newValue === 'object' && newValue !== null) {
            // 後方互換性: 古い strength を strength_model に変換
            if (newValue.strength !== undefined && newValue.strength_model === undefined) {
                newValue.strength_model = newValue.strength;
                delete newValue.strength;
            }
            this._value = { ...this._value, ...newValue };
            this.valueChangedCallback?.();
        }
    }

    serializeValue(node, index) {
        return this.value;
    }
    
    setupHitAreas() {
        this.hitAreas = {
            toggle: { bounds: [0, 0], onClick: this.onToggleClick },
            loraName: { bounds: [0, 0], onClick: this.onLoRANameClick },
            strengthLeft: { bounds: [0, 0], onClick: this.onStrengthDecrease },
            strengthNumber: { bounds: [0, 0], onClick: this.onStrengthClick, onMove: this.onStrengthMove },
            strengthRight: { bounds: [0, 0], onClick: this.onStrengthIncrease },
            clipStrengthLeft: { bounds: [0, 0], onClick: this.onClipStrengthDecrease },
            clipStrengthNumber: { bounds: [0, 0], onClick: this.onClipStrengthClick, onMove: this.onClipStrengthMove },
            clipStrengthRight: { bounds: [0, 0], onClick: this.onClipStrengthIncrease },
            delete: { bounds: [0, 0], onClick: this.onDeleteClick }
        };
    }

    // =============================================
    // コンテキストメニュー関連メソッド
    // =============================================

    /**
     * このウィジェットが指定された座標でクリックされたかどうかをチェック
     */
    isClickedAt(x, y, node) {
        // ウィジェットの描画位置を確認
        const widgetY = this.last_y || 0;
        const widgetHeight = CONSTANTS.PILL_HEIGHT;
        const margin = CONSTANTS.MARGIN;
        
        // LoRAウィジェットの領域内かチェック
        return (x >= margin && 
                x <= node.size[0] - margin && 
                y >= widgetY && 
                y <= widgetY + widgetHeight);
    }

    /**
     * コンテキストメニューを表示
     */
    showContextMenu(event, node) {
        const widgetIndex = node.loraWidgets.indexOf(this);
        const canMoveUp = widgetIndex > 0;
        const canMoveDown = widgetIndex < node.loraWidgets.length - 1;
        
        const menuOptions = [
            {
                content: "ℹ️ 情報を開く", 
                callback: async () => {
                    const dialog = new LoRAInfoDialog(this);
                    await dialog.show();
                }
            }, 
            {
                content: `📊 LBWを開く`, 
                callback: () => {
                    // LBWダイアログを開く
                    const dialog = new LoRABlockWeightDialog(this);
                    dialog.show();
                }
            }, 
            null, // セパレータ
            {
                content: `${this.value.enabled ? "🔴" : "🟢"} ${this.value.enabled ? "無効化" : "有効化"}`,
                callback: () => {
                    this.value.enabled = !this.value.enabled;
                    node.setDirtyCanvas(true, true);
                }
            },
            null, // セパレータ
            {
                content: "✏️ 表示名を設定",
                callback: () => {
                    app.canvas.prompt("表示名を入力", this.value.display_name || "", (v) => {
                        this.value.display_name = v || null;
                        node.setDirtyCanvas(true, true);
                    }, event);
                }
            },
            {
                content: `📝 表示: ${node.loraDisplayMode === 'full' ? 'ファイル名のみ' : 'フルパス'}`,
                callback: () => {
                    // 表示モードを切り替え
                    node.loraDisplayMode = node.loraDisplayMode === 'full' ? 'filename' : 'full';
                    node.setDirtyCanvas(true, true);
                }
            },
            null, // セパレータ
            {
                content: `🔎 Clipを${node.clipSettingMode === 'individual' ? '共通設定' : '個別設定'}`,
                callback: () => {
                    // Clip設定モードを切り替え
                    node.clipSettingMode = node.clipSettingMode === 'individual' ? 'common' : 'individual';
                    const isIndividual = node.clipSettingMode === 'individual';
                    node.loraWidgets.forEach(w => w.value.clip_mode = isIndividual);
                    node.updateNodeSize();
                    node.setDirtyCanvas(true, true);
                }
            },
            null, // セパレータ
            {
                content: "⬆️ 上に移動",
                disabled: !canMoveUp,
                callback: () => {
                    if (canMoveUp) {
                        this.moveUp(node, widgetIndex);
                    }
                }
            },
            {
                content: "⬇️ 下に移動",
                disabled: !canMoveDown,
                callback: () => {
                    if (canMoveDown) {
                        this.moveDown(node, widgetIndex);
                    }
                }
            },
            null, // セパレータ
            {
                content: "🗑️ 削除",
                callback: () => {
                    node.removeLoRAWidget(this);
                }
            }
        ];

        new LiteGraph.ContextMenu(menuOptions, {
            event: event,
            title: `LoRA`,
            className: "custom-lora-menu",
            node: node,
            filter: false
        }, window);
    }

    /**
     * ウィジェットを上に移動
     */
    moveUp(node, currentIndex) {
        // loraWidgets配列での移動
        [node.loraWidgets[currentIndex], node.loraWidgets[currentIndex - 1]] = 
        [node.loraWidgets[currentIndex - 1], node.loraWidgets[currentIndex]];
        
        // widgets配列での移動
        const currentWidgetIndex = node.widgets.indexOf(this);
        const targetWidget = node.loraWidgets[currentIndex];
        const targetWidgetIndex = node.widgets.indexOf(targetWidget);
        
        // widgets配列内で位置を交換
        [node.widgets[currentWidgetIndex], node.widgets[targetWidgetIndex]] = 
        [node.widgets[targetWidgetIndex], node.widgets[currentWidgetIndex]];
        
        node.setDirtyCanvas(true, true);
    }

    /**
     * ウィジェットを下に移動
     */
    moveDown(node, currentIndex) {
        // loraWidgets配列での移動
        [node.loraWidgets[currentIndex], node.loraWidgets[currentIndex + 1]] = 
        [node.loraWidgets[currentIndex + 1], node.loraWidgets[currentIndex]];
        
        // widgets配列での移動
        const currentWidgetIndex = node.widgets.indexOf(this);
        const targetWidget = node.loraWidgets[currentIndex];
        const targetWidgetIndex = node.widgets.indexOf(targetWidget);
        
        // widgets配列内で位置を交換
        [node.widgets[currentWidgetIndex], node.widgets[targetWidgetIndex]] = 
        [node.widgets[targetWidgetIndex], node.widgets[currentWidgetIndex]];
        
        node.setDirtyCanvas(true, true);
    }
    
    // =============================================
    // 描画メソッド
    // =============================================
    
    draw(ctx, node, w, posY, height) {
        if (Utils.isLowQuality()) return;
        
        ctx.save();
        
        const margin = CONSTANTS.MARGIN;
        const padding = CONSTANTS.PILL_PADDING;
        const pillWidth = w - margin * 2;
        const pillHeight = CONSTANTS.PILL_HEIGHT;
        const pillX = margin;
        
        // メインピル背景
        Renderer.drawPillBackground(ctx, pillX, posY, pillWidth, pillHeight, this.value.enabled);
        
        let currentX = pillX + padding;
        
        // トグルスイッチ
        const toggleWidth = Renderer.drawToggleSwitch(ctx, currentX, posY, pillHeight, this.value.enabled ? 'on' : 'off');
        this.hitAreas.toggle.bounds = [currentX, posY, toggleWidth, pillHeight];
        currentX += toggleWidth + padding;
        
        // LoRA名表示エリア
        const strengthControlWidth = CONSTANTS.STRENGTH_WIDTH;
        const deleteButtonWidth = 20;
        let clipStrengthControlWidth = 0;
        if(node.clipSettingMode === 'individual') {
            clipStrengthControlWidth = strengthControlWidth + padding;
        }

        const loraNameWidth = pillWidth - (currentX - pillX) - strengthControlWidth - clipStrengthControlWidth - deleteButtonWidth - padding * 3;
        
        // LoRA名テキスト
        ctx.font = "12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        
        // ノードの表示モードを参照
        const showFullPath = node.loraDisplayMode === 'full';
        const displayName = Utils.formatDisplayName(this.value.lora, showFullPath, this.value.display_name);
        const trimmedName = Utils.fitString(ctx, displayName, loraNameWidth - padding);

        // 有効な機能によってプレフィックス追加 / 文字色変更
        let textColor = "#e2e8f0";
        let prefix = "";
        if (this.value.enabled_trigger) {
            prefix += "📄";
            textColor = "#f6ad55";
        }
        if (this.value.enabled_block) {
            prefix += "📊";
            textColor = "#f6ad55";
        }
        if (this.value.start > 0 || this.value.end < 1) {
            prefix += "⏰";
            textColor = "#f6ad55";
        }
        // ウィジェット自体が無効の場合
        if (!this.value.enabled) {
            textColor = "#718096";
        }
        
        ctx.fillStyle = textColor;
        ctx.fillText(prefix + " " + trimmedName, currentX + padding/2, posY + pillHeight / 2);
        
        this.hitAreas.loraName.bounds = [currentX, posY, loraNameWidth, pillHeight];
        currentX += loraNameWidth + padding;
        
        // 強度コントロール
        const strengthBounds = Renderer.drawStrengthControl(ctx, currentX, posY + 4, strengthControlWidth, pillHeight - 8, this.value.strength_model, this.value.enabled);
        this.hitAreas.strengthLeft.bounds = strengthBounds.leftArrow;
        this.hitAreas.strengthNumber.bounds = strengthBounds.number;
        this.hitAreas.strengthRight.bounds = strengthBounds.rightArrow;
        currentX += strengthControlWidth + padding;

        // Clip Strength コントロール
        if (node.clipSettingMode === 'individual') {
            const clipStrengthBounds = Renderer.drawStrengthControl(ctx, currentX, posY + 4, strengthControlWidth, pillHeight - 8, this.value.strength_clip, this.value.enabled);
            this.hitAreas.clipStrengthLeft.bounds = clipStrengthBounds.leftArrow;
            this.hitAreas.clipStrengthNumber.bounds = clipStrengthBounds.number;
            this.hitAreas.clipStrengthRight.bounds = clipStrengthBounds.rightArrow;
            currentX += strengthControlWidth + padding;
        } else {
            // 個別設定じゃないときは、当たり判定をリセットしてゴーストクリックを防ぐ
            this.hitAreas.clipStrengthLeft.bounds = [-1, -1, 0, 0];
            this.hitAreas.clipStrengthNumber.bounds = [-1, -1, 0, 0];
            this.hitAreas.clipStrengthRight.bounds = [-1, -1, 0, 0];
        }
        
        // 削除ボタン
        ctx.beginPath();
        ctx.roundRect(currentX, posY + 4, deleteButtonWidth, pillHeight - 8, 4);
        ctx.fillStyle = "#718096";
        ctx.fill();
        
        // ×アイコン
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        const iconSize = 8;
        const iconX = currentX + deleteButtonWidth / 2;
        const iconY = posY + pillHeight / 2;
        ctx.beginPath();
        ctx.moveTo(iconX - iconSize/2, iconY - iconSize/2);
        ctx.lineTo(iconX + iconSize/2, iconY + iconSize/2);
        ctx.moveTo(iconX + iconSize/2, iconY - iconSize/2);
        ctx.lineTo(iconX - iconSize/2, iconY + iconSize/2);
        ctx.stroke();
        
        this.hitAreas.delete.bounds = [currentX, posY, deleteButtonWidth, pillHeight];
        
        ctx.restore();
    }
    
    // =============================================
    // イベントハンドラー
    // =============================================
    
    onToggleClick(event, pos, node) {
        this.value.enabled = !this.value.enabled;
        this.valueChangedCallback?.();
        this.cancelMouseDown();
        node.setDirtyCanvas(true, true);
        return true;
    }
    
    onLoRANameClick(event, pos, node) {
        
        Utils.showLoRAChooser(event, this.value.lora, (selectedLora) => {
            this.value.lora = selectedLora;
            this.valueChangedCallback?.();
            node.setDirtyCanvas(true, true);
        });
        
        this.cancelMouseDown();
        return true;
    }
    
    onStrengthClick(event, pos, node) {
        if (this.haveMouseMovedNumber) return;
        
        app.canvas.prompt("強度を入力", this.value.strength_model, (v) => {
            const num = parseFloat(v);
            if (!isNaN(num)) {
                this.value.strength_model = Math.round(num * 100) / 100;
                this.valueChangedCallback?.();
                node.setDirtyCanvas(true, true);
            }
        }, event);
        return true;
    }
    
    onStrengthMove(event, pos, node) {
        
        if (event.deltaX) {
            this.haveMouseMovedNumber = true;
            const newValue = this.value.strength_model + event.deltaX * CONSTANTS.DRAG_SENSITIVITY;
            this.value.strength_model = Math.round(newValue * 100) / 100;
            this.valueChangedCallback?.();
            node.setDirtyCanvas(true, true);
        }
        return true;
    }
    
    onStrengthDecrease(event, pos, node) {
        this.value.strength_model = Math.round((this.value.strength_model - CONSTANTS.STEP_SIZE) * 100) / 100;
        this.valueChangedCallback?.();
        node.setDirtyCanvas(true, true);
        return true;
    }
    
    onStrengthIncrease(event, pos, node) {
        this.value.strength_model = Math.round((this.value.strength_model + CONSTANTS.STEP_SIZE) * 100) / 100;
        this.valueChangedCallback?.();
        node.setDirtyCanvas(true, true);
        return true;
    }

    onClipStrengthClick(event, pos, node) {
        if (this.haveMouseMovedClipNumber) return;
        
        app.canvas.prompt("Clip強度を入力", this.value.strength_clip, (v) => {
            const num = parseFloat(v);
            if (!isNaN(num)) {
                this.value.strength_clip = Math.round(num * 100) / 100;
                this.valueChangedCallback?.();
                node.setDirtyCanvas(true, true);
            }
        }, event);
        return true;
    }

    onClipStrengthMove(event, pos, node) {
        
        if (event.deltaX) {
            this.haveMouseMovedClipNumber = true;
            const newValue = this.value.strength_clip + event.deltaX * CONSTANTS.DRAG_SENSITIVITY;
            this.value.strength_clip = Math.round(newValue * 100) / 100;
            this.valueChangedCallback?.();
            node.setDirtyCanvas(true, true);
        }
        return true;
    }

    onClipStrengthDecrease(event, pos, node) {
        this.value.strength_clip = Math.round((this.value.strength_clip - CONSTANTS.STEP_SIZE) * 100) / 100;
        this.valueChangedCallback?.();
        node.setDirtyCanvas(true, true);
        return true;
    }

    onClipStrengthIncrease(event, pos, node) {
        this.value.strength_clip = Math.round((this.value.strength_clip + CONSTANTS.STEP_SIZE) * 100) / 100;
        this.valueChangedCallback?.();
        node.setDirtyCanvas(true, true);
        return true;
    }
    
    onDeleteClick(event, pos, node) {
        this.deleteCallback?.(this);
        return true;
    }
    
    onMouseUp(event, pos, node) {
        super.onMouseUp(event, pos, node);
        this.haveMouseMovedNumber = false;
        this.haveMouseMovedClipNumber = false;
    }
}