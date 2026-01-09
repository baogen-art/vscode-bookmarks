/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import path = require("path");
import * as vscode from "vscode";
import { Controller } from "../core/controller";
import { parsePosition, Point } from "./parser";
import { codicons } from "vscode-ext-codicons";
import { listBookmarks } from "../core/operations";
import { Container } from "../core/container";
import { FileNode } from "./fileNode";
import { BookmarkNode, BookmarkPreview } from "./bookmarkNode";
import { WorkspaceNode } from "./workspaceNode";
import { GroupNode } from "./groupNode";
import { BookmarkNodeKind, ViewAs } from "./nodes";
import { BadgeConfig } from "../core/constants";

export class BookmarkProvider implements vscode.TreeDataProvider<BookmarkNode | WorkspaceNode | FileNode | GroupNode> {

    // tslint:disable-next-line: variable-name
    private _onDidChangeTreeData: vscode.EventEmitter<BookmarkNode | void> = new vscode.EventEmitter<BookmarkNode | void>();
    // tslint:disable-next-line: member-ordering
    public readonly onDidChangeTreeData: vscode.Event<BookmarkNode | void> = this._onDidChangeTreeData.event;

    private tree: BookmarkNode[] = [];

    private collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;

    private _filterQuery: string = "";

    constructor(private controllers: Controller[]) {

        if (vscode.workspace.getConfiguration("bookmarks.sideBar").get<boolean>("expanded", false)) {
            this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        }

        for (const controller of controllers) {
            controller.onDidClearBookmarks(() => {
                this._onDidChangeTreeData.fire();
            });
        }

        for (const controller of controllers) {

            controller.onDidAddBookmark(bkm => {

                // no bookmark in this file
                if (this.tree.length === 0) {
                    this._onDidChangeTreeData.fire();
                    return;
                }

                // has bookmarks - find it
                for (const bn of this.tree) {
                    if (bn.bookmark === bkm.file) {

                        if (!bkm.label) {
                            bn.books.push({
                                file: bn.books[ 0 ].file,
                                line: bkm.line,
                                column: bkm.column,
                                preview: bkm.linePreview,
                                uri: bkm.uri
                            });
                        } else {
                            bn.books.push({
                                file: bn.books[ 0 ].file,
                                line: bkm.line,
                                column: bkm.column,
                                preview: "\u270E " + bkm.label,
                                uri: bkm.uri
                            });
                        }

                        bn.books.sort((n1, n2) => {
                            if (n1.line > n2.line) {
                                return 1;
                            }

                            if (n1.line < n2.line) {
                                return -1;
                            }

                            return 0;
                        });

                        this._onDidChangeTreeData.fire(bn);
                        return;
                    }
                }

                // not found - new file
                this._onDidChangeTreeData.fire();
            });
        }


        for (const controller of controllers) {

            controller.onDidRemoveBookmark(bkm => {

                // no bookmark in this file
                if (this.tree.length === 0) {
                    this._onDidChangeTreeData.fire();
                    return;
                }

                // has bookmarks - find it
                for (const bn of this.tree) {
                    if (bn.bookmark === bkm.bookmark) {

                        // last one - reset
                        if (bn.books.length === 1) {
                            this._onDidChangeTreeData.fire(null);
                            return;
                        }

                        // remove just that one
                        for (let index = 0; index < bn.books.length; index++) {
                            const element = bn.books[ index ];
                            if (element.line === bkm.line) {
                                bn.books.splice(index, 1);
                                this._onDidChangeTreeData.fire(bn);
                                return;
                            }
                        }
                    }
                }
            });
        }

        for (const controller of controllers) {

            controller.onDidUpdateBookmark(bkm => {

                // no bookmark in this file
                if (this.tree.length === 0) {
                    this._onDidChangeTreeData.fire();
                    return;
                }

                // has bookmarks - find it
                for (const bn of this.tree) {
                    if (bn.bookmark === bkm.file) {

                        bn.books[ bkm.index ].line = bkm.line;
                        bn.books[ bkm.index ].column = bkm.column ? bkm.column : bn.books[ bkm.index ].column;
                        if (bkm.linePreview) {
                            bn.books[ bkm.index ].preview = bkm.linePreview;
                        } else {
                            bn.books[ bkm.index ].preview = "\u270E " + bkm.label;
                        }

                        this._onDidChangeTreeData.fire(bn);
                        return;
                    }
                }

                // not found - new file
                this._onDidChangeTreeData.fire();
            });
        }
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    public set filterQuery(query: string) {
        this._filterQuery = query;
        this.refresh();
    }

    private _matchesFilter(label: string | undefined): boolean {
        if (!this._filterQuery || this._filterQuery.trim() === "") {
            return true;
        }

        if (!label) {
            return false;
        }

        const viewAsGrouped = Container.context.globalState.get<boolean>("viewAsGrouped", false);

        if (viewAsGrouped) {
            // 分组模式下：提取方括号内的内容 [xx-xx-xx] 并匹配
            const match = label.match(/^\[(.*?)\]/);
            if (!match) {
                return false;
            }

            const bracketContent = match[1].toLowerCase();
            const searchTerms = this._filterQuery.toLowerCase()
                .split(/\s+/) // 统一使用空格分隔
                .filter(term => term.length > 0);

            if (searchTerms.length === 0) {
                return true;
            }

            return searchTerms.every(term => bracketContent.includes(term));
        } else {
            // 非分组模式下：全文本模糊匹配（支持空格）
            const searchTerms = this._filterQuery.toLowerCase()
                .split(/\s+/)
                .filter(term => term.length > 0);

            if (searchTerms.length === 0) {
                return true;
            }

            const lowerLabel = label.toLowerCase();
            return searchTerms.every(term => lowerLabel.includes(term));
        }
    }

    public getTreeItem(element: BookmarkNode | GroupNode | FileNode | WorkspaceNode): vscode.TreeItem {
        return element;
    }

    // very much based in `listFromAllFiles` command
    public getChildren(element?: FileNode | WorkspaceNode | GroupNode): Thenable<BookmarkNode[] | WorkspaceNode[] | FileNode[] | GroupNode[]> {

        // no bookmark
        // let totalBookmarkCount = 0;

        let someFileHasBookmark: boolean;
        for (const controller of this.controllers) {
            someFileHasBookmark = controller.hasAnyBookmark();
            if (someFileHasBookmark) { break }
        }

        if (!someFileHasBookmark) {
            this.tree = [];
            return Promise.resolve([]);
        }

        // loop !!!
        return new Promise(resolve => {

            if (element) {

                if (element.kind === BookmarkNodeKind.NODE_WORKSPACE_FOLDER) {

                    const promisses = [];
                    const ne = <WorkspaceNode>element;
                    for (const file of ne.controller.files) {
                        const pp = listBookmarks(file, ne.controller.workspaceFolder);
                        promisses.push(pp);
                    }

                    Promise.all(promisses).then(
                        (values) => {

                            // raw list
                            const lll: FileNode[] = [];
                            for (const bb of ne.controller.files) {

                                // this bookmark has bookmarks?
                                if (bb.bookmarks.length > 0) {

                                    const books: BookmarkPreview[] = [];

                                    // search from `values`no
                                    for (const elm of values) {
                                        if (elm) {
                                            for (const elementInside of elm) {

                                                if (bb.path === elementInside.detail) {

                                                    const point: Point = parsePosition(elementInside.description);
                                                    
                                                    // 模糊搜索过滤
                                                    const rawLabel = elementInside.label.replace(codicons.tag, "").trim();
                                                    if (!this._matchesFilter(rawLabel)) {
                                                        continue;
                                                    }

                                                    books.push(
                                                        {
                                                            file: elementInside.detail,
                                                            line: point.line,
                                                            column: point.column,
                                                            preview: elementInside.label.replace(codicons.tag, "\u270E"),
                                                            uri: elementInside.uri
                                                        }
                                                    );
                                                }
                                            }
                                        }
                                    }

                                    const itemPath = path.basename(bb.path);
                                    const bn: FileNode = new FileNode(itemPath, removeRelativePathFromFile(bb.path), this.collapsibleState, BookmarkNodeKind.NODE_FILE, bb, books);
                                    lll.push(bn);
                                    // this.tree.push(bn);
                                }
                            }

                            resolve(lll);
                        }
                    );
                    return
                }

                if (element.kind === BookmarkNodeKind.NODE_FILE || element.kind === BookmarkNodeKind.NODE_GROUP) {
                    const ll: BookmarkNode[] = [];

                    const ne = <BookmarkNode | GroupNode | FileNode>element;
                    const isGroup = element.kind === BookmarkNodeKind.NODE_GROUP;

                    const hidePosition = Container.context.globalState.get<boolean>("bookmarks.sidebar.hidePosition", false);

                    let groupLevelIdx = -1;
                    let groupLevelName = "";
                    if (isGroup) {
                        const groupLabel = (ne as GroupNode).label;
                        const cleanGroupTag = groupLabel.slice(1, -1); // 去掉 []
                        const groupParts = cleanGroupTag.split('-');
                        groupLevelIdx = groupParts.length - 1;
                        groupLevelName = groupParts[groupLevelIdx];
                    }

                    let lastDisplayedLevelName = "";
                    for (let i = 0; i < (ne as any).books.length; i++) {
                        const bbb = (ne as any).books[i];
                        let label = bbb.preview;

                        // 树结构模式下的过滤逻辑
                        if (!isGroup) {
                            if (!this._matchesFilter(label)) {
                                continue;
                            }
                        }

                        if (isGroup) {
                            // v3.0 展示优化：在组内排每一层时，加上序号和层级名
                            const match = label.match(/^✎\s*\[(.*?)\](.*)$/);
                            if (match) {
                                const rawTag = match[1];
                                const content = match[2].trim();
                                const tagParts = rawTag.split('-');
                                
                                // 核心展示逻辑：溯源序号展示
                                // 修正 v3.0：遵循“最高权重层级优先”原则
                                // 如果一个标签在更高级别（更浅层）已经有了序号，那么在该序号确定的权重下，
                                // 后续更深层级的序号就不应该再作为展示权重。
                                
                                let foundIdx = -1;
                                let foundLevelName = "";
                                let foundIdxNum = "";

                                // 从最顶层（level 0）开始向下遍历到当前层级
                                // 寻找第一个（最高权重的）序号
                                for (let level = 0; level <= groupLevelIdx; level++) {
                                    const part = tagParts[level] || "";
                                    const idxMatch = part.match(/\$(\d+)/);
                                    if (idxMatch) {
                                        foundIdx = level;
                                        foundIdxNum = idxMatch[1];
                                        
                                        const groupLabel = (ne as GroupNode).label;
                                        const cleanGroupTag = groupLabel.slice(1, -1);
                                        const groupParts = cleanGroupTag.split('-');
                                        foundLevelName = groupParts[level] || "";
                                        
                                        // 一旦找到最高权重的序号，立即停止，后面的序号不再关心
                                        break;
                                    }
                                }
                                
                                let displayLabel = content;
                                if (foundIdx !== -1) {
                                    displayLabel = `${foundIdxNum}.${displayLabel}`;
                                    
                                    // 只要当前找到的有序号层级名与上一个显示的不同，就显示新的层级名
                                    if (foundLevelName !== lastDisplayedLevelName) {
                                        displayLabel = `[${foundLevelName}]${displayLabel}`;
                                        lastDisplayedLevelName = foundLevelName;
                                    }
                                }
                                
                                label = `✎ ${displayLabel}`;
                            } else {
                                label = label.replace(/^✎\s*\[.*?\]/, "✎ ");
                            }
                        }

                        ll.push(new BookmarkNode(label, !hidePosition ? `(Ln ${bbb.line}, Col ${bbb.column})` : undefined, vscode.TreeItemCollapsibleState.None, BookmarkNodeKind.NODE_BOOKMARK, null, [], {
                            command: "_bookmarks.jumpTo",
                            title: "",
                            arguments: [ bbb.file, bbb.line, bbb.column, bbb.uri ],
                        }));
                    }

                    // 排序：按标签字典序排列（如果是分组模式，则维持创建分组时已排好的序号顺序，不再重新按字典序排）
                    if (!isGroup) {
                        ll.sort((a, b) => {
                            const labelA = (a.label as string) || "";
                            const labelB = (b.label as string) || "";
                            return labelA.localeCompare(labelB);
                        });
                    }

                    resolve(ll);
                } else {
                    resolve([]);
                }
            } else { // ROOT

                //
                const viewAsList = Container.context.globalState.get<boolean>("viewAsList", false);
                const viewAsGrouped = Container.context.globalState.get<boolean>("viewAsGrouped", false);

                // has more than one controller/worskpace and View As TREE, just loop through the controllers and returns its workspaces
                if (this.controllers.length > 1 && !viewAsList && !viewAsGrouped) {
                    const workspaces = [];
                    for (const controller of this.controllers) {
                        const wn: WorkspaceNode = new WorkspaceNode(controller.workspaceFolder.name, controller.workspaceFolder,
                            this.collapsibleState, BookmarkNodeKind.NODE_WORKSPACE_FOLDER, [], controller);
                        workspaces.push(wn);
                    }
                    resolve(workspaces);
                    return
                }

                this.tree = [];
                const promisses = [];
                
                // get all files, from all controllers/workspaces
                for (const controller of this.controllers) {
                    for (const file of controller.files) {
                        const pp = listBookmarks(file, controller.workspaceFolder);
                        promisses.push(pp);
                    }
                }

                // all files, from all controllers/workspaces
                Promise.all(promisses).then(
                    (values) => {

                        // raw list
                        const lll: FileNode[] = [];
                        const allBooks: BookmarkPreview[] = [];

                        for (const controller of this.controllers) {
                            for (const bb of controller.files) {

                                // this bookmark has bookmarks?
                                if (bb.bookmarks.length > 0) {

                                    const books: BookmarkPreview[] = [];

                                    // search from `values`no
                                    for (const elm of values) {
                                        if (elm) {
                                            for (const elementInside of elm) {

                                                if (bb.path === elementInside.detail) {

                                                    const point: Point = parsePosition(elementInside.description);

                                                    // 模糊搜索过滤
                                                    const rawLabel = elementInside.label.replace(codicons.tag, "").trim();
                                                    if (!this._matchesFilter(rawLabel)) {
                                                        continue;
                                                    }

                                                    const bPreview: BookmarkPreview = {
                                                        file: elementInside.detail,
                                                        line: point.line,
                                                        column: point.column,
                                                        preview: elementInside.label.replace(codicons.tag, "\u270E"),
                                                        uri: elementInside.uri
                                                    };
                                                    books.push(bPreview);
                                                    allBooks.push(bPreview);
                                                }
                                            }
                                        }
                                    }

                                    const itemPath = path.basename(bb.path);
                                    const bn: FileNode = new FileNode(itemPath, removeRelativePathFromFile(bb.path), this.collapsibleState, BookmarkNodeKind.NODE_FILE, bb, books);
                                    lll.push(bn);
                                    // this.tree.push(bn);
                                }
                            }
                        }

                        // 分组展示逻辑 (v3.0 优化版：支持 [xx$1] 序号排序)
                        if (viewAsGrouped) {
                            const groupsMap = new Map<string, BookmarkPreview[]>();
                            const actualTags = new Set<string>();
                            
                            // 预提取书签的标签信息，包括原始标签和去序号后的标签
                            const booksWithTags = allBooks.map(book => {
                                const match = book.preview.match(/^✎\s*\[(.*?)\]/);
                                if (!match) return { book, rawTag: null, cleanTag: null, tagParts: [] };
                                
                                const rawTag = match[1];
                                // 将 a$1-b$2 转换为 a-b，用于确定分组归类
                                const cleanTag = rawTag.replace(/\$\d+/g, "");
                                // 拆分每一层，保留 a$1 这种形式用于排序计算
                                const tagParts = rawTag.split("-");
                                
                                return { book, rawTag, cleanTag, tagParts };
                            });

                            // 1. 预处理：提取所有书签中实际存在的去序号后的完整标签
                            booksWithTags.forEach(item => {
                                if (item.cleanTag) {
                                    actualTags.add(item.cleanTag);
                                }
                            });

                            // 2. 遍历实际存在的标签，建立分组
                            actualTags.forEach(groupTag => {
                                const groupKey = `[${groupTag}]`;
                                
                                // 只有当分组标签本身满足搜索过滤条件时才处理
                                if (!this._matchesFilter(groupKey)) {
                                    return;
                                }

                                const groupBooks: any[] = [];
                                booksWithTags.forEach(item => {
                                    if (item.cleanTag) {
                                        // 归类逻辑：书签标签以分组标签开头
                                        if (item.cleanTag === groupTag || item.cleanTag.startsWith(groupTag + "-")) {
                                            groupBooks.push(item);
                                        }
                                    }
                                });

                                if (groupBooks.length > 0) {
                                    // 3. 核心排序逻辑：v3.0 组内多级序号排序
                                    groupBooks.sort((a, b) => {
                                        const partsA = a.tagParts;
                                        const partsB = b.tagParts;
                                        const maxLen = Math.max(partsA.length, partsB.length);

                                        for (let i = 0; i < maxLen; i++) {
                                            const partA = partsA[i] || "";
                                            const partB = partsB[i] || "";

                                            // 提取序号，例如 a$1 提取出 1
                                            const matchA = partA.match(/\$(\d+)/);
                                            const matchB = partB.match(/\$(\d+)/);
                                            const idxA = matchA ? parseInt(matchA[1], 10) : Infinity;
                                            const idxB = matchB ? parseInt(matchB[1], 10) : Infinity;

                                            // 如果这一层有序号差异，按序号排
                                            if (idxA !== idxB) {
                                                return idxA - idxB;
                                            }
                                            
                                            // 如果序号相同（或都没有序号），继续检查下一层级
                                        }

                                        // 如果所有层级序号都一样，最后按完整标签和预览文本进行字典序排序
                                        const labelA = a.book.preview;
                                        const labelB = b.book.preview;
                                        return labelA.localeCompare(labelB);
                                    });

                                    groupsMap.set(groupKey, groupBooks.map(item => item.book));
                                }
                            });

                            // 4. 转换为分组节点
                            const groupNodes: GroupNode[] = [];
                            groupsMap.forEach((books, label) => {
                                groupNodes.push(new GroupNode(label, this.collapsibleState, BookmarkNodeKind.NODE_GROUP, books));
                            });

                            // 5. 分组节点本身按名称排序
                            groupNodes.sort((a, b) => a.label.localeCompare(b.label));
                            resolve(groupNodes);
                            return;
                        }

                        // choose the view
                        if (viewAsList) {
                            const hidePosition = Container.context.globalState.get<boolean>("bookmarks.sidebar.hidePosition", false);
                            const bookmarkNodes: BookmarkNode[] = [];
                            lll.forEach(FileNode => {
                                for (const bbb of FileNode.books) {
                                    // 检查是否满足过滤条件（针对列表模式）
                                    if (!this._matchesFilter(bbb.preview)) {
                                        continue;
                                    }
                                    bookmarkNodes.push(new BookmarkNode(bbb.preview, !hidePosition ? `(Ln ${bbb.line}, Col ${bbb.column})` : undefined, vscode.TreeItemCollapsibleState.None, BookmarkNodeKind.NODE_BOOKMARK, null, [], {
                                        command: "_bookmarks.jumpTo",
                                        title: "",
                                        arguments: [ bbb.file, bbb.line, bbb.column, bbb.uri ],
                                    }));
                                }
                            });

                            // 排序：列表模式下按标签字典序排列
                            bookmarkNodes.sort((a, b) => {
                                const labelA = (a.label as string) || "";
                                const labelB = (b.label as string) || "";
                                return labelA.localeCompare(labelB);
                            });

                            resolve(bookmarkNodes);
                            return;
                        }
                        
                        // viewAsTree returns FileNode[]
                        // 排序：树模式下按文件名字典序排列
                        lll.sort((a, b) => {
                            const labelA = (a.label as string) || "";
                            const labelB = (b.label as string) || "";
                            return labelA.localeCompare(labelB);
                        });
                        resolve(lll);
                    }
                );
            }
        });
    }

}

function removeRelativePathFromFile(aPath: string): string {
    const filename = path.basename(aPath);
    const dirname = aPath.substring(0, aPath.length - filename.length - 1)
    return dirname;
}

export class BookmarksExplorer {

    private bookmarksExplorer: vscode.TreeView<BookmarkNode | WorkspaceNode | FileNode | GroupNode>;
    private treeDataProvider: BookmarkProvider;
    private controllers: Controller[];

    constructor(controllers: Controller[]) {
        this.controllers = controllers;
        this.treeDataProvider = new BookmarkProvider(controllers);
        this.bookmarksExplorer = vscode.window.createTreeView("bookmarksExplorer", {
            treeDataProvider: this.treeDataProvider,
            showCollapseAll: true
        });

        for (const controller of controllers) {
            controller.onDidClearBookmarks(() => {
                this.updateBadge();
            });
            controller.onDidAddBookmark(() => {
                this.updateBadge();
            });
            controller.onDidRemoveBookmark(() => {
                this.updateBadge();
            });
        }
    }

    getProvider() {
        return this.treeDataProvider;
    }

    updateBadge() {
        const config = vscode.workspace.getConfiguration("bookmarks.sideBar").get<string>("countBadge", "all");
        if (config === BadgeConfig.Off) {
            this.bookmarksExplorer.badge = { value: 0, tooltip: ""};
            return;
        }

        if (config === BadgeConfig.All) {
            this.updateBadgeAllFiles()
        } else {
            this.updateBadgePerFile();
        }
    }

    private updateBadgeAllFiles() {
        let total = 0;
        this.controllers.forEach(controller => 
            total = total + controller.countBookmarks()
        );
            
        const badgeTooltip = total === 0
            ? ""
            : total === 1
                ? "1 bookmark"
                : `${total} bookmarks`;

        this.bookmarksExplorer.badge = { value: total, tooltip: badgeTooltip};
    }

    private updateBadgePerFile() {
        let total = 0;
        this.controllers.forEach(controller => 
                total = total + controller.countFilesWithBookmarks()
        );
            
        const badgeTooltip = total === 0
            ? ""
            : total === 1
                ? vscode.l10n.t("1 file with bookmarks")
                : `${total} ` + vscode.l10n.t("files with bookmarks");

        this.bookmarksExplorer.badge = { value: total, tooltip: badgeTooltip};

    }
}