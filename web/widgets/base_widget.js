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

    mouse(event, pos, node) {
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
