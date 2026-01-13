/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Alessandro Fragnani. All rights reserved.
 *  Licensed under the GPLv3 License. See License.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TreeItem, TreeItemCollapsibleState, ThemeIcon } from "vscode";
import { BookmarkNodeKind } from "./nodes";
import { BookmarkPreview } from "./bookmarkNode";

export class GroupNode extends TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: TreeItemCollapsibleState,
        public readonly kind: BookmarkNodeKind,
        public readonly books: BookmarkPreview[]
    ) {
        super(label, collapsibleState);
        this.iconPath = new ThemeIcon("tag");
        this.contextValue = "BookmarkNodeGroup";
    }
}
