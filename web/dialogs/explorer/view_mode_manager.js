import { app } from "../../../../scripts/app.js";
import { $el } from "../../../../scripts/ui.js";
import { loadCSS, mk_name } from "../../utils.js";

loadCSS("dialogs/explorer/css/view_mode.css");

// ==============================================
// 表示形式管理クラス
// ==============================================
export class ViewModeManager {
    static viewMode = "grid";

    constructor(parent) {
        this.parent = parent;
        this.element = null;
        this.createUI();

        const settings = app.extensionManager.setting;
        const savedMode = settings.get(mk_name("explorerViewMode"));
        if (savedMode && (savedMode === "grid" || savedMode === "list")) {
            ViewModeManager.viewMode = savedMode;
        }
        this.updateViewButtons();
    }

    // ------------------------------------------
    // UIを作成
    // ------------------------------------------
    createUI() {
        this.element = $el("div.jupo-file-explorer-view-mode-container");

        this.gridViewButton = $el("button.jupo-file-explorer-view-mode-button", {
            textContent: "🪟",
            title: "グリッド表示"
        });
        this.gridViewButton.addEventListener("click", () => this.setViewMode("grid"));

        this.listViewButton = $el("button.jupo-file-explorer-view-mode-button", {
            textContent: "📋",
            title: "リスト表示"
        });
        this.listViewButton.addEventListener("click", () => this.setViewMode("list"));

        this.element.append(this.gridViewButton, this.listViewButton);
    }

    // ------------------------------------------
    // 表示形式ボタンの状態を更新
    // ------------------------------------------
    updateViewButtons() {
        if (!this.parent.fileContainer) return;

        this.gridViewButton.classList.toggle("jupo-file-explorer-active-view", ViewModeManager.viewMode === "grid");
        this.listViewButton.classList.toggle("jupo-file-explorer-active-view", ViewModeManager.viewMode === "list");

        this.parent.fileContainer.classList.remove("jupo-file-explorer-files-grid", "jupo-file-explorer-files-list");
        if (ViewModeManager.viewMode === "list") {
            this.parent.fileContainer.classList.add("jupo-file-explorer-files-list");
        } else {
            this.parent.fileContainer.classList.add("jupo-file-explorer-files-grid");
        }
    }

    // ------------------------------------------
    // 表示形式を切り替え
    // ------------------------------------------
    setViewMode(mode) {
        if (ViewModeManager.viewMode === mode) return;

        ViewModeManager.viewMode = mode;

        const settings = app.extensionManager.setting;
        settings.set(mk_name("explorerViewMode"), mode);

        this.updateViewButtons();

        if (this.parent.searchManager.isSearching) {
            this.parent.searchManager.displaySearchResults();
        } else {
            this.parent.displayFiles(this.parent.currentDirectoryPath);
        }
    }
}