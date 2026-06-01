import { $el } from "../../../../scripts/ui.js";
import { loadCSS } from "../../utils.js";
import { GalleryModal } from "./gallery_modal.js";

loadCSS("dialogs/model_info/css/gallery_section.css");

// ==============================================
// Gallery Section
// ==============================================
export class GallerySection {
    constructor({ onSave, onPreview }) {
        // UI要素
        this.element = null; // 全体コンテナ
        this.counter = null; // カウンター要素
        this.grid = null; // ギャラリーコンテナ

        // コールバック
        this.onSave = onSave; // 保存ボタンを押したとき
        this.onPreview = onPreview; // プレビューとして保存を押したとき

        // メディアモーダルダイアログ
        this.modal = new GalleryModal();

        this.createUI();
    }

    // ------------------------------------------
    // UIを作成
    // ------------------------------------------
    createUI() {
        this.element = $el("div.jupo-gallery-section");

        // ヘッダー
        const header = $el("div.jupo-gallery-section-header");
        const title = $el("div.jupo-gallery-section-header-title", {
            textContent: "Civitai ギャラリー"
        });
        this.counter = $el("span.jupo-gallery-section-header-counter", {
            textContent: "0"
        });
        header.append(title, this.counter);

        // ギャラリーコンテナ
        this.grid = $el("div.jupo-gallery-section-grid");

        this.element.append(header, this.grid);
    }


    // ------------------------------------------
    // ギャラリーを表示
    // ------------------------------------------
    display(images) {
        this.clear();

        if (!images || images.length === 0) {
            this.showEmpty();
            return;
        }

        this.updateCount(images.length);
        this.renderImages(images);
    }


    // --- 画像を描画 ---
    renderImages(images) {
        images.forEach((image, index) => {
            const item = this.createGalleryItem(image, index);
            if (item) {
                this.grid.append(item);
            }
        });
    }


    // --- ギャラリーアイテムを作成 ---
    createGalleryItem(image, index) {
        if (!image.url) return null;

        const isVideo = image.type === "video" || this.isVideoUrl(image.url);
        
        const item = $el("div.jupo-gallery-section-item");

        // アイテム全体のクリックイベント(モーダル表示)
        item.addEventListener("click", (e) => {
            if (!e.target.closest(".jupo-gallery-section-action-button")) {
                this.modal?.show(image, index, isVideo);
            }
        });

        // 保存ボタン
        const saveButton = $el("button.jupo-gallery-section-action-button", {
            textContent: "💾", 
            title: "メディアを保存", 
            onclick: (e) => {
                e.stopPropagation(); // モーダル表示を防ぐ
                this.onSave(image);
            }
        })

        // プレビューとして保存ボタン
        const previewButton = $el("button.jupo-gallery-section-action-button", {
            textContent: "📌", 
            title: "プレビューとして保存", 
            onclick: (e) => {
                e.stopPropagation(); // モーダル表示を防ぐ
                this.onPreview(image);
            }
        });

        // ボタンコンテナ
        const actions = $el("div.jupo-gallery-section-actions", [
            previewButton, saveButton
        ]);
        item.append(actions);

        // メディア部分
        if (isVideo) {
            const video = $el("video.jupo-gallery-section-media", {
                src: image.url, 
                muted: true, 
                loop: true, 
                preload: "metadata"
            });

            // マウスホバーで再生 / 停止
            item.addEventListener("mouseenter", () => {
                this.pauseAllVideos();
                video.play().catch(e => console.warn("Autoplay failed: ", e));
            });
            item.addEventListener("mouseleave", () => {
                video.pause();
                video.currentTime = 0;
            });
            
            item.append(video);

        } else {
            const img = $el("img.jupo-gallery-section-media", {
                src: image.url, 
                alt: image.meta?.prompt || `Gallery image ${index + 1}`, 
                loading: "lazy"
            });

            item.append(img);
        }

        return item;
    }

    // --- URLから動画かどうか判定 ---
    isVideoUrl(url) {
        const videoExtensions = [".mp4", ".webm", ".mov", ".avi"];
        return videoExtensions.some(ext => url.toLowerCase().includes(ext));
    }


    // --- 空のギャラリーを表示 ---
    showEmpty() {
        const emptyElement = $el("div.jupo-gallery-section-empty", [
            $el("div", { textContent: "Empty" })
        ]);
        this.grid.append(emptyElement);
    }


    // ------------------------------------------
    // カウントを更新
    // ------------------------------------------
    updateCount(count) {
        if (this.counter) {
            this.counter.textContent = count.toString();
        }
    }


    // ------------------------------------------
    // すべての動画を停止
    // ------------------------------------------
    pauseAllVideos() {
        if (!this.grid) return;

        const videos = this.grid.querySelectorAll("video");
        videos.forEach(video => {
            video.pause();
            video.currentTime = 0;
        });
    }


    // ------------------------------------------
    // クリア
    // ------------------------------------------
    clear() {
        this.pauseAllVideos();

        this.grid.replaceChildren();
        this.updateCount(0);
    }
}