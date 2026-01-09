import * as vscode from "vscode";
import { Controller } from "../core/controller";
import { BookmarkPreview } from "./bookmarkNode";
import { listBookmarks } from "../core/operations";
import { parsePosition, Point } from "./parser";
import { codicons } from "vscode-ext-codicons";
import { saveBookmarks } from "../storage/workspaceState";

export class OrganizeViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'bookmarksOrganize';

    private _view?: vscode.WebviewView;
    private _onDidUpdateBookmarks: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidUpdateBookmarks: vscode.Event<void> = this._onDidUpdateBookmarks.event;
    private currentSearchLayer: string = "";
    private viewVersion: number = 0;
    private bookmarks: BookmarkPreview[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private controllers: Controller[]
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'reorder':
                    await this.handleReorder(data.sourceIdx, data.targetIdx, data.position);
                    break;
                case 'openBookmark':
                    this.openBookmark(data.bookmark);
                    break;
                case 'refresh':
                    await this.refresh();
                    break;
            }
        });

        // 如果已经有搜索层级，立即刷新
        if (this.currentSearchLayer) {
            this.refresh();
        }
    }

    public async search(layer: string) {
        this.currentSearchLayer = layer.split(' ')[0];
        this.viewVersion = Controller.globalVersion;
        await this.refresh();
    }

    public async refresh() {
        this.viewVersion = Controller.globalVersion;
        
        if (!this.currentSearchLayer) {
            this.bookmarks = [];
            this.updateWebview();
            return;
        }

        const allBookmarks: BookmarkPreview[] = [];
        for (const controller of this.controllers) {
            for (const file of controller.files) {
                const items = await listBookmarks(file, controller.workspaceFolder) as any[];
                if (items) {
                    for (const item of items) {
                        const point: Point = parsePosition(item.description);
                        allBookmarks.push({
                            file: item.detail,
                            line: point.line,
                            column: point.column,
                            preview: item.label.replace(codicons.tag, "\u270E"),
                            uri: item.uri
                        });
                    }
                }
            }
        }

        this.bookmarks = allBookmarks.filter(b => {
            if (!b.preview) return false;
            const label = b.preview.replace(/^\u270E\s*/, "");
            const match = label.match(/\[(.*?)\]/);
            if (!match) return false;
            const tags = match[1].split('-');
            return tags.some(t => t.replace(/\$\d+/, '').toLowerCase() === this.currentSearchLayer.toLowerCase());
        });

        this.bookmarks = this.sortBookmarks(this.bookmarks);
        this.updateWebview();
    }

    private sortBookmarks(books: BookmarkPreview[]): BookmarkPreview[] {
        return books.sort((a, b) => {
            const idxA = this.getIdxForLayer(a, this.currentSearchLayer);
            const idxB = this.getIdxForLayer(b, this.currentSearchLayer);
            if (idxA !== null && idxB !== null) return idxA - idxB;
            if (idxA !== null) return -1;
            if (idxB !== null) return 1;
            const labelA = (a.preview || "").replace(/^\u270E\s*/, "").replace(/^\[.*?\]/, "").trim();
            const labelB = (b.preview || "").replace(/^\u270E\s*/, "").replace(/^\[.*?\]/, "").trim();
            return labelA.localeCompare(labelB);
        });
    }

    private getIdxForLayer(b: BookmarkPreview, layer: string): number | null {
        if (!b.preview) return null;
        const label = b.preview.replace(/^\u270E\s*/, "");
        const match = label.match(/\[(.*?)\]/);
        if (!match) return null;
        const tags = match[1].split('-');
        for (const tag of tags) {
            if (tag.replace(/\$\d+/, '').toLowerCase() === layer.toLowerCase()) {
                const idxMatch = tag.match(/\$(\d+)/);
                return idxMatch ? parseInt(idxMatch[1], 10) : null;
            }
        }
        return null;
    }

    private updateWebview() {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'update',
                bookmarks: this.bookmarks.map(b => ({
                    ...b,
                    displayLabel: this.getDisplayLabel(b),
                    idx: this.getIdxForLayer(b, this.currentSearchLayer)
                })),
                layer: this.currentSearchLayer
            });
        }
    }

    private getDisplayLabel(b: BookmarkPreview): string {
        const previewText = b.preview || "";
        let label = previewText.replace(/^\u270E\s*/, "");
        label = label.replace(/^\[.*?\]/, "").trim();
        const idx = this.getIdxForLayer(b, this.currentSearchLayer);
        return idx !== null ? `${idx}. ${label}` : label;
    }

    private async handleReorder(sourceIdx: number, targetIdx: number, position: 'before' | 'after') {
        if (this.viewVersion < Controller.globalVersion) {
            vscode.window.showWarningMessage("书签内容已更新，请刷新后再试。");
            await this.refresh();
            return;
        }

        const sourceBook = this.bookmarks[sourceIdx];
        const targetBook = this.bookmarks[targetIdx];

        if (!sourceBook || !targetBook) return;

        // 执行重排逻辑 (类似于 OrganizeProvider.recalculateIndexes)
        // 注意：Webview 传回来的 targetIdx 和 position 决定了最终插入位置
        const books = [...this.bookmarks];
        const [movedBook] = books.splice(sourceIdx, 1);
        
        let insertIdx = books.findIndex(b => this.isSameBookmark(b, targetBook));
        if (position === 'after') {
            insertIdx += 1;
        }
        books.splice(insertIdx, 0, movedBook);

        await this.recalculateIndexes(books, movedBook, insertIdx);
    }

    private isSameBookmark(a: BookmarkPreview, b: BookmarkPreview): boolean {
        return a.uri.toString() === b.uri.toString() && a.line === b.line && a.column === b.column;
    }

    private async recalculateIndexes(books: BookmarkPreview[], movedBook: BookmarkPreview, movedInArrayIdx: number) {
        const edit = new vscode.WorkspaceEdit();
        const changes: { bookmark: BookmarkPreview, newIdx: number | null }[] = [];
        
        const prevNodeIdx = movedInArrayIdx > 0 ? this.getIdxForLayer(books[movedInArrayIdx - 1], this.currentSearchLayer) : null;
        const movedOriginalIdx = this.getIdxForLayer(movedBook, this.currentSearchLayer);
        
        let targetIdxToAssign: number | null = null;
        if (prevNodeIdx !== null) {
            targetIdxToAssign = prevNodeIdx + 1;
        } else {
            const nextNodeIdx = movedInArrayIdx + 1 < books.length ? this.getIdxForLayer(books[movedInArrayIdx + 1], this.currentSearchLayer) : null;
            if (nextNodeIdx === 1 || nextNodeIdx === 2) {
                targetIdxToAssign = 1;
            } else if (movedOriginalIdx !== null && movedInArrayIdx === 0) {
                targetIdxToAssign = 1;
            }
        }

        let nextIdxToAssign = targetIdxToAssign;

        for (let i = movedInArrayIdx; i < books.length; i++) {
            const b = books[i];
            const currentIdx = this.getIdxForLayer(b, this.currentSearchLayer);
            const isMovedBook = this.isSameBookmark(b, movedBook);

            if (currentIdx === null && !isMovedBook) break;
            
            if (isMovedBook && nextIdxToAssign === null) {
                if (currentIdx !== null) {
                    changes.push({ bookmark: b, newIdx: null });
                }
                break;
            }

            const assignedIdx = nextIdxToAssign!;

            if (isMovedBook) {
                if (currentIdx !== assignedIdx) {
                    changes.push({ bookmark: b, newIdx: assignedIdx });
                }
                nextIdxToAssign = assignedIdx + 1;
            } else {
                if (currentIdx !== null && currentIdx < assignedIdx) {
                    changes.push({ bookmark: b, newIdx: assignedIdx });
                    nextIdxToAssign = assignedIdx + 1;
                } else {
                    break;
                }
            }
        }

        if (changes.length === 0) {
            this._onDidUpdateBookmarks.fire();
            await this.refresh();
            return;
        }

        let controllerUpdated = false;
        for (const change of changes) {
            const b = change.bookmark;
            const currentLabel = (b.preview || "").replace(/^\u270E\s*/, "");
            const newLabel = this.computeNewLineText(currentLabel, change.newIdx);
            if (newLabel !== currentLabel) {
                if (this.updateBookmarkInController(b, newLabel)) {
                    controllerUpdated = true;
                }
            }
        }

        for (const change of changes) {
            const uri = change.bookmark.uri;
            try {
                const document = await vscode.workspace.openTextDocument(uri);
                const lineIdx = change.bookmark.line - 1;
                if (lineIdx >= 0 && lineIdx < document.lineCount) {
                    const lineText = document.lineAt(lineIdx).text;
                    const newLineText = this.computeNewLineText(lineText, change.newIdx);
                    if (lineText !== newLineText) {
                        const range = new vscode.Range(lineIdx, 0, lineIdx, lineText.length);
                        edit.replace(uri, range, newLineText);
                    }
                }
            } catch (e) {
                console.error(`[Organize] Failed to prepare edit for ${uri.toString()}: ${e}`);
            }
        }

        try {
            const fileSuccess = edit.size > 0 ? await vscode.workspace.applyEdit(edit) : false;
            if (fileSuccess) {
                const uris = edit.entries().map(entry => entry[0]);
                for (const editUri of uris) {
                    const doc = await vscode.workspace.openTextDocument(editUri);
                    await doc.save();
                }
            }
            if (fileSuccess || controllerUpdated) {
                this._onDidUpdateBookmarks.fire();
            }
            await this.refresh();
        } catch (err) {
            vscode.window.showErrorMessage(`重算序号失败: ${err}`);
        }
    }

    private updateBookmarkInController(b: BookmarkPreview, newLabel: string): boolean {
        let updated = false;
        for (const controller of this.controllers) {
            const file = controller.files.find(f => 
                f.uri?.toString() === b.uri.toString() || 
                (f.path && b.file && f.path.endsWith(b.file))
            );
            if (file) {
                const bookmark = file.bookmarks.find(bm => bm.line === b.line - 1);
                if (bookmark) {
                    bookmark.label = newLabel;
                    saveBookmarks(controller);
                    updated = true;
                }
            }
        }
        return updated;
    }

    private computeNewLineText(lineText: string, newIdx: number | null): string {
        const bracketMatch = lineText.match(/\[(.*?)\]/);
        if (!bracketMatch) return lineText;
        const fullTagContent = bracketMatch[1];
        const tags = fullTagContent.split('-');
        let found = false;
        const newTags = tags.map(tag => {
            const tagName = tag.replace(/\$\d+/, '');
            if (tagName.toLowerCase() === this.currentSearchLayer.toLowerCase()) {
                found = true;
                return newIdx !== null ? `${tagName}$${newIdx}` : tagName;
            }
            return tag;
        });
        if (!found) return lineText;
        const newFullTagContent = newTags.join('-');
        return lineText.replace(`[${fullTagContent}]`, `[${newFullTagContent}]`);
    }

    private openBookmark(bookmark: BookmarkPreview) {
        vscode.workspace.openTextDocument(bookmark.uri).then(doc => {
            vscode.window.showTextDocument(doc, {
                selection: new vscode.Range(bookmark.line - 1, bookmark.column, bookmark.line - 1, bookmark.column)
            });
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<style>
					body {
						padding: 0 4px;
						color: var(--vscode-foreground);
						font-family: var(--vscode-font-family);
                        user-select: none;
					}
					.bookmark-list {
						list-style: none;
						padding: 0;
						margin: 0;
					}
					.bookmark-item {
						padding: 6px 8px;
						cursor: pointer;
						display: flex;
						align-items: flex-start;
						border: 1px solid transparent;
                        position: relative;
                        gap: 8px;
					}
					.bookmark-item:hover {
						background: var(--vscode-list-hoverBackground);
					}
                    .bookmark-icon {
                        flex-shrink: 0;
                        width: 16px;
                        height: 16px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        color: var(--vscode-charts-blue);
                        margin-top: 1px; /* 对齐第一行文本 */
                    }
                    .bookmark-item.dragging {
                        opacity: 0.4;
                        background: var(--vscode-list-activeSelectionBackground);
                    }
                    /* 拖拽插入指示线 */
                    .bookmark-item.drag-over-above::before,
                    .bookmark-item.drag-over-below::after {
                        content: "";
                        position: absolute;
                        left: 0;
                        right: 0;
                        height: 2px;
                        background: #007acc; /* 强制使用经典的 VS Code 蓝色，确保可见 */
                        z-index: 100;
                        pointer-events: none;
                        box-shadow: 0 0 4px #007acc;
                    }
                    .bookmark-item.drag-over-above::before {
                        top: -1px;
                    }
                    .bookmark-item.drag-over-below::after {
                        bottom: -1px;
                    }
                    /* 指示线开头的圆点 */
                    .bookmark-item.drag-over-above::after,
                    .bookmark-item.drag-over-below::before {
                        content: "";
                        position: absolute;
                        left: -4px;
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        background: #007acc;
                        z-index: 101;
                        pointer-events: none;
                        box-shadow: 0 0 4px #007acc;
                    }
                    .bookmark-item.drag-over-above::after {
                        top: -4px;
                    }
                    .bookmark-item.drag-over-below::before {
                        bottom: -4px;
                    }
					.bookmark-label {
						display: -webkit-box;
						-webkit-line-clamp: 2;
						-webkit-box-orient: vertical;
						overflow: hidden;
						text-overflow: ellipsis;
						pointer-events: none; /* 防止子元素干扰拖拽事件 */
						line-height: 1.4;
						max-height: 2.8em;
						word-break: break-all;
					}
                    .empty-state {
                        padding: 20px;
                        text-align: center;
                        color: var(--vscode-descriptionForeground);
                    }
				</style>
			</head>
			<body>
				<div id="app">
                    <div class="empty-state">请输入层级进行整理...</div>
                </div>

				<script>
					const vscode = acquireVsCodeApi();
					const app = document.getElementById('app');
                    let bookmarks = [];
                    let draggingIdx = -1;

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'update':
                                bookmarks = message.bookmarks;
                                render();
                                break;
                        }
                    });

                    function render() {
                        if (bookmarks.length === 0) {
                            app.innerHTML = '<div class="empty-state">未找到匹配的书签</div>';
                            return;
                        }

                        const list = document.createElement('ul');
                        list.className = 'bookmark-list';
                        
                        bookmarks.forEach((b, i) => {
                            const item = document.createElement('li');
                            item.className = 'bookmark-item';
                            item.draggable = true;
                            item.innerHTML = \`
                                <div class="bookmark-icon">
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                                        <path d="M3 3v10.3l4.5-3.2 4.5 3.2V3H3zm8 9.1l-3.5-2.5-3.5 2.5V4h7v8.1z"/>
                                    </svg>
                                </div>
                                <span class="bookmark-label">\${b.displayLabel}</span>
                            \`;
                            
                            item.onclick = () => {
                                vscode.postMessage({ type: 'openBookmark', bookmark: b });
                            };

                            item.ondragstart = (e) => {
                                draggingIdx = i;
                                item.classList.add('dragging');
                                e.dataTransfer.setData('text/plain', i);
                                e.dataTransfer.effectAllowed = 'move';
                            };

                            item.ondragend = () => {
                                draggingIdx = -1;
                                item.classList.remove('dragging');
                                document.querySelectorAll('.bookmark-item').forEach(el => {
                                    el.classList.remove('drag-over-above', 'drag-over-below');
                                });
                            };

                            item.ondragover = (e) => {
                                e.preventDefault();
                                if (draggingIdx === i) return;

                                const rect = item.getBoundingClientRect();
                                const midpoint = rect.top + rect.height / 2;
                                
                                if (e.clientY < midpoint) {
                                    item.classList.add('drag-over-above');
                                    item.classList.remove('drag-over-below');
                                } else {
                                    item.classList.add('drag-over-below');
                                    item.classList.remove('drag-over-above');
                                }
                            };

                            item.ondragleave = () => {
                                item.classList.remove('drag-over-above', 'drag-over-below');
                            };

                            item.ondrop = (e) => {
                                e.preventDefault();
                                if (draggingIdx === -1 || draggingIdx === i) return;

                                const rect = item.getBoundingClientRect();
                                const midpoint = rect.top + rect.height / 2;
                                const position = e.clientY < midpoint ? 'before' : 'after';

                                vscode.postMessage({
                                    type: 'reorder',
                                    sourceIdx: draggingIdx,
                                    targetIdx: i,
                                    position: position
                                });
                            };

                            list.appendChild(item);
                        });

                        app.innerHTML = '';
                        app.appendChild(list);
                    }
				</script>
			</body>
			</html>`;
    }
}
