import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { $el } from "../../../scripts/ui.js";
import { mk_name, mk_endpoint, api_get, api_post, loadCSS } from "../utils.js";

import { CONSTANTS, Utils, Renderer } from "../ui.js";

// ==============================================
// Nodes 2.0 (Vue ノード) 再描画フック
// Vue モードではカスタムウィジェットが個別の <canvas> に描画され、
// node.setDirtyCanvas() では再描画されない (widget.triggerDraw() が必要)。
// 他ウィジェットの値を変更しても見た目が古いまま残る
// (例: Checkpoint Selector で複数のトグルが ON に見える) ため、
// setDirtyCanvas() 呼び出し時にノード内の全ウィジェットを再描画する。
// マイクロタスクに遅延させるのは、値ストアへの反映後に描画するため。
// ==============================================
export function installVueNodesRedrawHook(nodeType) {
    const proto = nodeType?.prototype;
    if (!proto || proto.__jupoRedrawHookInstalled) return;
    proto.__jupoRedrawHookInstalled = true;

    const originalSetDirtyCanvas = proto.setDirtyCanvas;
    proto.setDirtyCanvas = function(...args) {
        const result = originalSetDirtyCanvas?.apply(this, args);
        this.redrawCustomWidgets?.();
        return result;
    };

    proto.redrawCustomWidgets = function() {
        if (this.__jupoRedrawPending) return;
        this.__jupoRedrawPending = true;
        queueMicrotask(() => {
            this.__jupoRedrawPending = false;
            for (const w of (this.widgets ?? [])) {
                try {
                    w?.triggerDraw?.();
                } catch (e) {
                    console.warn("[jupo] widget redraw failed:", e);
                }
            }
        });
    };
}

// ==============================================
// ウィジェット追加/削除の互換ヘルパー (最新フロントエンド対応)
// - ウィジェット値は Pinia ストア管理。node.widgets を直接 splice すると
//   ストアに古い値が残り、同名ウィジェットを再追加したとき古い値が復活する。
//   削除は node.removeWidget() を使う。
// - node.widgets に積んだオブジェクトはその場で LegacyWidget に変換されるが、
//   変換できない場合は別インスタンスに置き換わるため、配列から読み戻す。
// ==============================================
export function insertWidget(node, widget, index = -1) {
    node.widgets ??= [];
    const list = node.widgets;
    if (index < 0 || index > list.length) {
        if (typeof node.addCustomWidget === "function") {
            return node.addCustomWidget(widget) ?? widget;
        }
        list.push(widget);
        return list[list.length - 1] ?? widget;
    }
    list.splice(index, 0, widget);
    // 変換後のインスタンスを読み戻す (同一オブジェクトのことがほとんど)
    const actual = node.widgets?.[index];
    return actual && actual.name === widget.name ? actual : widget;
}

export function removeWidget(node, widget) {
    if (!node?.widgets || !widget) return;
    if (!node.widgets.includes(widget)) return;
    if (typeof node.removeWidget === "function") {
        try {
            node.removeWidget(widget);
            return;
        } catch (e) {
            console.warn("[jupo] removeWidget failed, falling back to splice:", e);
        }
    }
    const index = node.widgets.indexOf(widget);
    if (index !== -1) node.widgets.splice(index, 1);
}

// node.size を直接書き換えず setSize() で拡張する (Nodes 2.0 のレイアウトストア対応)
export function growNodeToFit(node) {
    if (typeof node?.computeSize !== "function") return;
    const computed = node.computeSize();
    const current = node.size ?? [300, 200];
    const next = [Math.max(current[0], computed[0]), Math.max(current[1], computed[1])];
    if (next[0] !== current[0] || next[1] !== current[1]) {
        if (typeof node.setSize === "function") node.setSize(next);
        else node.size = next;
    }
    node.setDirtyCanvas?.(true, true);
}

// ==============================================
// Nodes 2.0 (Vue ノード) 右クリックメニューのブリッジ
// Vue モードではウィジェット上で右クリックすると Vue のノードメニューが開き、
// LGraphCanvas.processContextMenu を経由しないため、LoRA ごとのメニューが出せない。
// draw() 時に「ウィジェット専用 canvas → ウィジェット」を記録し、
// その canvas 上の contextmenu をキャプチャ段階で横取りして独自メニューを表示する。
// ==============================================
const widgetCanvasMap = new WeakMap();

export function trackWidgetCanvas(widget, ctx, node) {
    const el = ctx?.canvas;
    if (!el || el === app?.canvas?.canvas) return; // 従来のメインキャンバスは対象外
    widgetCanvasMap.set(el, { widget, node });
}

let contextMenuBridgeInstalled = false;
export function installVueContextMenuBridge() {
    if (contextMenuBridgeInstalled) return;
    contextMenuBridgeInstalled = true;

    window.addEventListener("contextmenu", (e) => {
        const target = e.target;
        if (!(target instanceof HTMLCanvasElement)) return;
        const entry = widgetCanvasMap.get(target);
        if (!entry) return;

        const { widget, node } = entry;
        // 削除済みウィジェット / ノードは無視
        if (!node?.graph || !node.widgets?.includes(widget)) return;
        if (typeof widget.showContextMenu !== "function") return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        widget.showContextMenu(e, node);
    }, true);
}

// ==============================================
// カスタムウィジェットの基底クラス
// ==============================================

export class BaseWidget {
    constructor(name, type = "custom") {
        this.type = type;
        this.name = name;
        this.y = 0;
        this.last_y = 0;
        this.mouseDowned = null;
        this.isMouseDownedAndOver = false;
        this.hitAreas = {};
        this.downedHitAreasForMove = [];
        this.downedHitAreasForClick = [];
    }
    
    // 値は「新しいオブジェクトの代入」で更新する。
    // ウィジェット値はストア管理のため、this.value.xxx = ... の破壊的変更では
    // Vue 側 (Nodes 2.0 / 右パネル) に変更が伝わらない場合がある。
    updateValue(patch) {
        const current = this.getCurrentValue();
        this.value = { ...((current && typeof current === "object") ? current : {}), ...patch };
    }

    // 最新の値を返す。
    // ストア連携された setter は「自前の setter → ストア」の順に書き込むため、
    // 自前 setter 内のコールバックから this.value を読むとストア側がまだ古い。
    // 自前で保持している _value を優先する。
    getCurrentValue() {
        return this._value !== undefined ? this._value : this.value;
    }

    clickWasWithinBounds(pos, bounds) {
        const xStart = bounds[0];
        const xEnd = xStart + (bounds.length > 2 ? bounds[2] : bounds[1]);
        const clickedX = pos[0] >= xStart && pos[0] <= xEnd;
        if (bounds.length === 2) return clickedX;
        return clickedX && pos[1] >= bounds[1] && pos[1] <= bounds[1] + bounds[3];
    }
    
    // ------------------------------------------
    // Nodes 2.0 (Vue ノード) 対応
    // Vue モードではウィジェットごとに専用の <canvas> が作られ、
    // pointerup だけはノード全体基準の座標 (canvasX - node.pos) で渡ってくる。
    // そのため pointerdown と座標系がずれ、クリック判定が失敗する。
    // イベントの発生元がウィジェット専用 canvas の場合は、
    // そのローカル座標 (offsetX/offsetY) を使う。
    // ------------------------------------------
    resolveEventPos(event, pos) {
        const target = event?.target;
        const mainCanvas = app?.canvas?.canvas;
        if (
            target instanceof HTMLCanvasElement &&
            mainCanvas && target !== mainCanvas &&
            Number.isFinite(event.offsetX) && Number.isFinite(event.offsetY)
        ) {
            return [event.offsetX, event.offsetY];
        }
        return pos;
    }

    // 主ボタン以外 (右クリック・中クリック) のイベントか
    // Nodes 2.0 では右クリックの pointerdown/up もウィジェットに届くため、
    // そのままだとトグル等がクリック扱いで反応してしまう。
    isSecondaryButton(event) {
        if (event?.type !== "pointerdown" && event?.type !== "pointerup") return false;
        return typeof event.button === "number" && event.button > 0;
    }

    mouse(event, pos, node) {
        if (this.isSecondaryButton(event)) {
            if (event.type === "pointerup") this.cancelMouseDown();
            return false;
        }
        pos = this.resolveEventPos(event, pos);
        if (event.type === "pointerdown") {
            return this.handlePointerDown(event, pos, node);
        } else if (event.type === "pointerup") {
            return this.handlePointerUp(event, pos, node);
        } else if (event.type === "pointermove") {
            return this.handlePointerMove(event, pos, node);
        }
        return false;
    }

    handlePointerDown(event, pos, node) {
        this.mouseDowned = [...pos];
        this.isMouseDownedAndOver = true;
        this.downedHitAreasForMove.length = 0;
        this.downedHitAreasForClick.length = 0;
        let anyHandled = false;
        
        for (const part of Object.values(this.hitAreas)) {
            if (this.clickWasWithinBounds(pos, part.bounds)) {
                if (part.onMove) this.downedHitAreasForMove.push(part);
                if (part.onClick) this.downedHitAreasForClick.push(part);
                if (part.onDown) {
                    const thisHandled = part.onDown.apply(this, [event, pos, node, part]);
                    anyHandled = anyHandled || thisHandled === true;
                }
                part.wasMouseClickedAndIsOver = true;
            }
        }
        return this.onMouseDown?.(event, pos, node) ?? anyHandled;
    }

    handlePointerUp(event, pos, node) {
        if (!this.mouseDowned) return true;
        this.downedHitAreasForMove.length = 0;
        const wasMouseDownedAndOver = this.isMouseDownedAndOver;
        this.cancelMouseDown();
        let anyHandled = false;
        
        for (const part of Object.values(this.hitAreas)) {
            if (part.onUp && this.clickWasWithinBounds(pos, part.bounds)) {
                const thisHandled = part.onUp.apply(this, [event, pos, node, part]);
                anyHandled = anyHandled || thisHandled === true;
            }
            part.wasMouseClickedAndIsOver = false;
        }
        
        for (const part of this.downedHitAreasForClick) {
            if (this.clickWasWithinBounds(pos, part.bounds)) {
                const thisHandled = part.onClick.apply(this, [event, pos, node, part]);
                anyHandled = anyHandled || thisHandled === true;
            }
        }
        this.downedHitAreasForClick.length = 0;
        
        if (wasMouseDownedAndOver) {
            const thisHandled = this.onMouseClick?.(event, pos, node);
            anyHandled = anyHandled || thisHandled === true;
        }
        return this.onMouseUp?.(event, pos, node) ?? anyHandled;
    }

    handlePointerMove(event, pos, node) {
        this.isMouseDownedAndOver = !!this.mouseDowned;
        if (this.mouseDowned &&
            (pos[0] < 15 || pos[0] > node.size[0] - 15 ||
             pos[1] < this.last_y || pos[1] > this.last_y + CONSTANTS.PILL_HEIGHT)) {
            this.isMouseDownedAndOver = false;
        }
        
        for (const part of Object.values(this.hitAreas)) {
            if (this.downedHitAreasForMove.includes(part)) {
                part.onMove.apply(this, [event, pos, node, part]);
            }
            if (this.downedHitAreasForClick.includes(part)) {
                part.wasMouseClickedAndIsOver = this.clickWasWithinBounds(pos, part.bounds);
            }
        }
        return this.onMouseMove?.(event, pos, node) ?? true;
    }
    
    cancelMouseDown() {
        this.mouseDowned = null;
        this.isMouseDownedAndOver = false;
        this.downedHitAreasForMove.length = 0;
    }
    
    onMouseDown(event, pos, node) { return; }
    onMouseUp(event, pos, node) { return; }
    onMouseClick(event, pos, node) { return; }
    onMouseMove(event, pos, node) { return; }
}
