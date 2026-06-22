import { $el } from "../../../../scripts/ui.js";
import { loadCSS } from "../../utils.js";

loadCSS("dialogs/model_info/css/info_section.css");

// ==============================================
// 情報セクション(metadata, civita)
// ==============================================
export class InfoSection {
    constructor({title, callback}) {
        this.title = title;
        this.callback = callback;

        // UI要素
        this.element = null; // 全体コンテナ
        this.container = null; // アイテムコンテナ

        this.createUI();
    }

    // ------------------------------------------
    // UIを作成
    // ------------------------------------------
    createUI() {
        this.element = $el("div.jupo-info-section");
        
        const header = this.createHeader();
        this.container = $el("div.jupo-info-section-item-container");

        this.element.append(header, this.container);
    }

    // --- ヘッダー ---
    createHeader() {
        const header = $el("div.jupo-info-section-header");
        const title = $el("div.jupo-info-section-header-title", { textContent: this.title });
        const button = $el("button.jupo-info-section-header-button", {
            textContent: "📄", 
            title: "生データを表示", 
            onclick: this.callback
        });
        header.append(title, button);
        return header;
    }


    // ------------------------------------------
    // 情報アイテムを追加
    // ------------------------------------------
    addItem(label, value) {
        // undefined, null, 空文字列を空文字に統一
        const displayValue = (value == null || value === "") ? "" : value;

        const valueElement = typeof displayValue === "string"
            ? $el("span.jupo-info-section-value", { textContent: displayValue })
            : displayValue;
        
        const labelElement = $el("div.jupo-info-section-label", { textContent: label });

        const item = $el("div.jupo-info-section-item", [
            labelElement, valueElement
        ]);

        this.container.append(item);
    }
}