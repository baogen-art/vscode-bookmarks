import { Controller } from "./controller";

export class TagManager {
    public static getAllTagNodes(controllers: Controller[]): string[] {
        const nodes = new Set<string>();
        for (const controller of controllers) {
            for (const file of controller.files) {
                for (const bookmark of file.bookmarks) {
                    if (bookmark.label) {
                        const match = bookmark.label.match(/\[(.*?)\]/);
                        if (match) {
                            const tags = match[1].split('-');
                            for (const tag of tags) {
                                const nodeName = tag.replace(/\$\d+$/, '');
                                if (nodeName) {
                                    nodes.add(nodeName);
                                }
                            }
                        }
                    }
                }
            }
        }
        return Array.from(nodes).sort();
    }

    /**
     * 根据当前输入的标签内容获取补全建议（仅返回单节点建议）
     * @param currentContent 方括号内的内容，如 "a-b-"
     * @param allNodes 所有已有的标签节点
     */
    public static getCompletions(currentContent: string, allNodes: string[]): string[] {
        const parts = currentContent.split('-');
        const lastPart = parts[parts.length - 1].replace(/\$\d+$/, '');
        const existingNodes = parts.slice(0, -1).map(p => p.replace(/\$\d+$/, ''));
        
        // 过滤出以 lastPart 开头的节点，且该节点不在已输入的节点列表中
        const matches = allNodes.filter(node => 
            node.toLowerCase().startsWith(lastPart.toLowerCase()) && 
            !existingNodes.includes(node)
        );

        // 仅返回匹配的单节点名称，而不是完整路径
        return matches;
    }
}
