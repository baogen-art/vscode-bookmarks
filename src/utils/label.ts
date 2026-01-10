/**
 * 格式化书签标签
 * 规则：
 * 1. 必须符合 [xx-xx-xx]xxx 格式
 * 2. 如果没有方括号，自动在前面加一个 "[]"
 * 3. 方括号内部的连接符必须是 "-"，任何特殊符号都要换成 "-"
 * 
 * @param label 原始标签
 * @returns 格式化后的标签
 */
export function formatBookmarkLabel(label: string): string {
    if (!label) return "[default]";

    let formattedLabel = label.trim();
    
    // 1. 检查方括号
    const openBracketIndex = formattedLabel.indexOf('[');
    const closeBracketIndex = formattedLabel.indexOf(']');

    let bracketContent = "";
    let remainingContent = "";

    if (openBracketIndex === -1) {
        // 完全没有 [，整体作为剩余内容，前面补 []
        bracketContent = "";
        remainingContent = formattedLabel;
    } else if (closeBracketIndex === -1 || closeBracketIndex < openBracketIndex) {
        // 有 [ 但没有 ]，或者 ] 在 [ 之前
        // 尝试寻找 [ 之后第一个空格，作为标签结束
        const firstSpaceAfterOpen = formattedLabel.indexOf(' ', openBracketIndex);
        if (firstSpaceAfterOpen === -1) {
            bracketContent = formattedLabel.substring(openBracketIndex + 1);
            remainingContent = "";
        } else {
            bracketContent = formattedLabel.substring(openBracketIndex + 1, firstSpaceAfterOpen);
            remainingContent = formattedLabel.substring(firstSpaceAfterOpen + 1).trim();
        }
    } else {
        // 提取方括号内容和剩余内容
        // 改进：保留方括号之前的内容，将其并入剩余内容中
        const prefixContent = formattedLabel.substring(0, openBracketIndex).trim();
        bracketContent = formattedLabel.substring(openBracketIndex + 1, closeBracketIndex);
        remainingContent = formattedLabel.substring(closeBracketIndex + 1).trim();
        
        if (prefixContent) {
            remainingContent = prefixContent + (remainingContent ? " " + remainingContent : "");
        }
    }

    // 2. 处理方括号内部：特殊符号换成 "-"
    // 允许字母、数字、$，其余替换为 "-"
    // 连续的多个特殊符号合并为一个 "-"
    const cleanedBracket = bracketContent
        .replace(/[^a-zA-Z0-9$]/g, '-')
        .replace(/-+/g, '-')        // 合并连续的 -
        .replace(/^-+|-+$/g, '');   // 去除首尾的 -

    const finalBracket = cleanedBracket || "default";

    return `[${finalBracket}]${remainingContent}`;
}
