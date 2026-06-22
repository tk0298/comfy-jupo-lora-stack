import { $el } from "../../../../scripts/ui.js";
import { mk_endpoint, api_get, loadCSS } from "../../utils.js";
import { ViewModeManager } from "./view_mode_manager.js";

loadCSS("dialogs/explorer/css/file_render.css");

// ==============================================
// ファイル表示を管理するクラス
// ==============================================
export class FileRenderManager {
    static gridWidth = 150;
    static gridHeight = 200;

    constructor(parent) {
        this.parent = parent;
    }

    // ------------------------------------------
    // ファイル要素を作成
    // ------------------------------------------
    createFileElement(filePath, fileName) {
        if (ViewModeManager.viewMode === "list") {
            return this.createFileListItem(filePath, fileName);
        } else {
            return this.createFileGridItem(filePath, fileName);
        }
    }

    // ------------------------------------------
    // リスト表示用のファイル項目を作成
    // ------------------------------------------
    createFileListItem(filePath, fileName) {
        const nameWithoutExt = fileName.substring(0, fileName.lastIndexOf(".")) || fileName;
        const extension = fileName.includes('.') ? fileName.split('.').pop().toUpperCase() : '';

        const fileExtensionElement = $el("span.jupo-file-explorer-file-extension", { textContent: extension });
        const filePathElement = $el("span.jupo-file-explorer-file-path", { textContent: filePath });

        const fileInfo = $el("div.jupo-file-explorer-file-list-info", [
            fileExtensionElement,
            filePathElement
        ]);

        const fileNameElement = $el("span.jupo-file-explorer-file-list-name", { textContent: nameWithoutExt });

        const infoButton = $el("button.jupo-file-explorer-info-button-list", {
            textContent: "ℹ️",
            title: "情報を表示"
        });
        infoButton.addEventListener("click", (e) => {
            e.stopPropagation();
            if (this.parent.infoDialog) {
                const infoDialog = new this.parent.infoDialog();
                infoDialog.modelPath = filePath;
                infoDialog.show();
            }
        });

        const fileListIcon = $el("div.jupo-file-explorer-file-list-icon", { textContent: "📄"});
        const fileListContent = $el("div.jupo-file-explorer-file-list-content", [fileNameElement, fileInfo]);

        const listItem = $el("div.jupo-file-explorer-list-item", [
            fileListIcon,
            fileListContent,
            infoButton
        ]);
        listItem.title = filePath;

        listItem.addEventListener("click", () => {
            if (this.parent.callback) {
                this.parent.callback(filePath);
            }
            this.parent.close();
        });

        return listItem;
    }

    // ------------------------------------------
    // グリッド表示用のファイル項目を作成
    // ------------------------------------------
    createFileGridItem(filePath, fileName) {
        const nameWithoutExt = fileName.substring(0, fileName.lastIndexOf(".")) || fileName;

        const gridItem = $el("div.jupo-file-explorer-grid-item", {
            title: filePath,
            style: {
                width: `${FileRenderManager.gridWidth}px`,
                height: `${FileRenderManager.gridHeight}px`
            }
        });

        gridItem.addEventListener("click", (e) => {
            if (!e.target.closest(".jupo-file-explorer-info-button-grid")) {
                if (this.parent.callback) {
                    this.parent.callback(filePath);
                }
                this.parent.close();
            }
        });

        const overlay = $el("div.jupo-file-explorer-grid-text-overlay", [
            $el("span", { textContent: nameWithoutExt })
        ]);

        const infoButton = $el("button.jupo-file-explorer-info-button-grid", {
            textContent: "ℹ️",
            title: "情報を表示"
        });
        infoButton.addEventListener("click", (e) => {
            e.stopPropagation();
            if (this.parent.infoDialog) {
                const infoDialog = new this.parent.infoDialog();
                infoDialog.modelPath = filePath;
                infoDialog.show();
            }
        });

        // 【修正点】ボタンをラップするアクションコンテナを作成
        const actionsContainer = $el("div.jupo-file-explorer-grid-actions", [infoButton]);

        gridItem.append(overlay, actionsContainer);

        if (this.parent.apiDir) {
            this.loadPreview(filePath, gridItem);
        }

        return gridItem;
    }

    // ------------------------------------------
    // APIからプレビューメディアを読み込んで表示
    // ------------------------------------------
    async loadPreview(filePath, itemElement) {
        try {
            const mediaData = await api_get("preview/" + encodeURIComponent(`${this.parent.apiDir}/${filePath}`));

            if (mediaData?.token) {
                const url = mk_endpoint(`media/${mediaData.token}`);
                let mediaElement;

                if (mediaData.cate === "image") {
                    mediaElement = $el("img.jupo-file-explorer-preview-media", { 
                        src: url, 
                        alt: filePath, 
                        loading: "lazy"
                    });
                } else if (mediaData.cate === "video") {
                    mediaElement = $el("video.jupo-file-explorer-preview-media", {
                        src: url,
                        muted: true,
                        loop: true,
                        preload: "metadata"
                    });

                    // マウスホバーで再生 / 停止
                    itemElement.addEventListener("mouseenter", () => {
                        this.pauseAllVideos();
                        mediaElement.play().catch(e => console.warn("Autoplay failed: ", e));
                    });
                    itemElement.addEventListener("mouseleave", () => {
                        mediaElement.pause();
                        mediaElement.currentTime = 0;
                    });
                }

                if (mediaElement) {
                    itemElement.prepend(mediaElement);
                }
            }
        } catch (error) {
            console.error("プレビューの読み込みに失敗しました:", error);
        }
    }

    // ------------------------------------------
    // すべての動画を停止
    // ------------------------------------------
    pauseAllVideos() {
        if (!this.parent.fileContainer) return;

        const videos = this.parent.fileContainer.querySelectorAll("video");
        videos.forEach(video => {
            video.pause();
            video.currentTime = 0;
        });
    }
}