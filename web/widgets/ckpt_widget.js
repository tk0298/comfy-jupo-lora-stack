import { app } from "../../../scripts/app.js";
import { CONSTANTS, Utils, Renderer } from "../ui.js";
import { BaseWidget } from "./base_widget.js";
import { CheckpointInfoDialog } from "../dialogs/checkpoint_info_dialog.js";

// ==============================================
// Ckpt Widget (Combo Widget) をカスタマイズ
// ==============================================

export function customize(widget) {
    // isClickedAtメソッドを追加
    widget.isClickedAt = function(x, y, node) {
        // ウィジェットの描画位置を確認
        const widgetY = this.last_y || 0;
        const widgetHeight = 20;
        const margin = 10;

        return (
            x >= margin &&
            x <= node.size[0] - margin &&
            y >= widgetY &&
            y <= widgetY + widgetHeight
        );
    };

    // showContextMenuメソッドを追加
    widget.showContextMenu = function(event, node) {
        const menuOptions = [
            {
                content: "ℹ️ 情報を開く", 
                callback: async () => {
                    const dialog = new CheckpointInfoDialog(this, true);
                    await dialog.show();
                }
            }
        ];

        new LiteGraph.ContextMenu(menuOptions, {
            event: event, 
            title: "Checkpoint", 
            className: "custom-checkpoint-menu", 
            node: node, 
            filter: false
        }, window);
    };

    // onClickメソッドを上書き
    widget.onClick = function({ e, node, canvas }) {
        const x = e.canvasX - node.pos[0];
        const width = this.width || node.size[0];

        if (x < 40) return this.decrementValue({ e, node, canvas });
        if (x > width - 40) return this.incrementValue({ e, node, canvas });

        Utils.showCheckpointChooser(e, this.value, (selected) => {
            const file = selected.replaceAll("/", "\\"); // サーバー側のパスに合わせる
            this.setValue(file, { e, node, canvas });
        });

        return true;
    }
};



// ==============================================
// Checkpointコンパウンドウィジェット
// ==============================================
export class PowerCheckpointCompoundWidget extends BaseWidget {
    constructor(name = "checkpoint_compound", options = {}) {
        super(name, "checkpoint");

        const { deleteCallback, valueChangedCallback, ...valueOptions} = options;
        this.deleteCallback = deleteCallback;
        this.valueChangedCallback = valueChangedCallback;

        this._value = {
            enabled: true, 
            path: "None", 
            display_name: null, 

            enabled_trigger: false, 
            trigger: "", 

            ...valueOptions
        };

        this.setupHitAreas();
    }

    get value() { return this._value; }
    set value(v) {
        let newValue = v;
        if (typeof v === "string") {
            try {
                newValue = JSON.parse(v);
            } catch (e) {
                console.error("PowerCheckpointCompoundWidget: valueのJSON解析に失敗しました", v, e);
                return;
            }
        }

        if (typeof newValue === "object" && newValue !== null) {
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
            name: { bounds: [0, 0], onClick: this.onNameClick }, 
            delete: { bounds: [0, 0], onClick: this.onDeleteClick }
        };
    }


    // ------------------------------------------
    // イベントハンドラ
    // ------------------------------------------
    onToggleClick(event, pos, node) {
        // 既に有効の場合はなにもしない
        if (this.value.enabled) return;

        // 全部のウィジェットを無効化
        node.widgets.forEach(w => {
            if (w instanceof this.constructor) w.value.enabled = false;
        });

        this.value.enabled = true;
        this.valueChangedCallback?.();
        this.cancelMouseDown();
        node?.setDirtyCanvas?.(true, true);
        return true;
    }

    onNameClick(event, pos, node) {

        Utils.showCheckpointChooser(event, this.value.path, (selected) => {
            this.value.path = selected;
            this.valueChangedCallback?.();
            node?.setDirtyCanvas?.(true, true);
        });

        this.cancelMouseDown();
        return true;
    }

    onDeleteClick(event, pos, node) {
        this.deleteCallback?.(this);
        return true;
    }


    // ------------------------------------------
    // 描画
    // ------------------------------------------
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
        const toggleWidth = Renderer.drawToggleSwitch(ctx, currentX, posY, pillHeight, this.value.enabled ? "on" : "off");
        this.hitAreas.toggle.bounds = [currentX, posY, toggleWidth, pillHeight];
        currentX += toggleWidth + padding;

        // 名前表示エリア
        const deleteButtonWidth = 20;
        const nameWidth = pillWidth - (currentX - pillX) - deleteButtonWidth - padding * 2;

        // テキスト
        ctx.font = "12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";

        // ノードの表示モードを参照
        const showFullPath = node.displayMode === "full";
        const displayName = Utils.formatDisplayName(this.value.path, showFullPath, this.value.display_name);
        const trimmedName = Utils.fitString(ctx, displayName, nameWidth - padding);

        let textColor = "#e2e8f0";
        let prefix = "";
        if (this.value.enabled_trigger) {
            prefix += "📄";
            textColor = "#f6ad55";
        }
        if (!this.value.enabled) {
            textColor = "#718096";
        }

        ctx.fillStyle = textColor;
        ctx.fillText(prefix + " " + trimmedName, currentX + padding/2, posY + pillHeight/2);

        this.hitAreas.name.bounds = [currentX, posY, nameWidth, pillHeight];
        currentX += nameWidth + padding;

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


    // ------------------------------------------
    // コンテキストメニュー関連メソッド
    // ------------------------------------------
    isClickedAt(x, y, node) {
        // ウィジェットの描画位置を確認
        const widgetY = this.last_y || 0;
        const widgetHeight = CONSTANTS.PILL_HEIGHT;
        const margin = CONSTANTS.MARGIN;

        return (x >= margin &&
                x <= node.size[0] - margin &&
                y >= widgetY &&
                y <= widgetY + widgetHeight);
    }

    showContextMenu(event, node) {
        const checkpointWidgets = node.widgets.filter(w => w instanceof PowerCheckpointCompoundWidget);
        const widgetIndex = checkpointWidgets.indexOf(this);
        const canMoveUp = widgetIndex > 0;
        const canMoveDown = widgetIndex < checkpointWidgets.length - 1;

        const menuOptions = [
            {
                content: "ℹ️ 情報を開く", 
                callback: async () => {
                    const dialog = new CheckpointInfoDialog(this, false);
                    await dialog.show();
                }
            }, 
            null, 
            {
                content: "✏️ 表示名を設定",
                callback: () => {
                    app.canvas.prompt("表示名を入力", this.value.display_name || "", (v) => {
                        this.value.display_name = v || null;
                        node?.setDirtyCanvas?.(true, true);
                    }, event);
                }
            }, 
            {
                content: `📝 表示: ${node.displayMode === 'full' ? 'ファイル名のみ' : 'フルパス'}`,
                callback: () => {
                    node.displayMode = node.displayMode === "full" ? "filename" : "full";
                    node?.setDirtyCanvas?.(true, true);
                }
            }, 
            null, 
            {
                content: "⬆️ 上に移動",
                disabled: !canMoveUp, 
                callback: () => {
                    if (canMoveUp) {
                        this.moveUp(node);
                    }
                }
            }, 
            {
                content: "⬇️ 下に移動",
                disabled: !canMoveDown, 
                callback: () => {
                    if (canMoveDown) {
                        this.moveDown(node);
                    }
                }
            }, 
            null, 
            {
                content: "🗑️ 削除",
                callback: () => {
                    node.removeCheckpointWidget(this);
                }
            }
        ];

        new LiteGraph.ContextMenu(menuOptions, {
            event: event, 
            title: "Checkpoint", 
            className: "custom-checkpoint-menu", 
            node: node, 
            filter: false
        }, window);
    }

    moveUp(node) {
        const currentIndex = node.widgets.indexOf(this);
        const targetIndex = currentIndex - 1;

        [node.widgets[currentIndex], node.widgets[targetIndex]] = 
        [node.widgets[targetIndex], node.widgets[currentIndex]];

        node?.setDirtyCanvas?.(true, true);
    }

    moveDown(node) {
        const currentIndex = node.widgets.indexOf(this);
        const targetIndex = currentIndex + 1;

        [node.widgets[currentIndex], node.widgets[targetIndex]] = 
        [node.widgets[targetIndex], node.widgets[currentIndex]];

        node?.setDirtyCanvas?.(true, true);
    }
}