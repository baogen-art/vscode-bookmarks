import * as vscode from "vscode";
import { Controller } from "../core/controller";

export class BookmarksSearchViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'bookmarksSearch';

    private _view?: vscode.WebviewView;
    private _onDidChangeSearchQuery: vscode.EventEmitter<string> = new vscode.EventEmitter<string>();
    public readonly onDidChangeSearchQuery: vscode.Event<string> = this._onDidChangeSearchQuery.event;

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

        webviewView.webview.onDidReceiveMessage(data => {
            switch (data.type) {
                case 'search':
                    this._onDidChangeSearchQuery.fire(data.value);
                    break;
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<style>
					html, body {
						margin: 0;
						padding: 0;
						color: var(--vscode-foreground);
						font-family: var(--vscode-font-family);
                        overflow: hidden;
                        height: 100%;
					}
                    .container {
                        padding: 5px 8px;
                        display: flex;
                        align-items: center;
                    }
					#search-input {
						flex: 1;
						padding: 4px 6px;
						background: var(--vscode-input-background);
						color: var(--vscode-input-foreground);
						border: 1px solid var(--vscode-input-border);
						outline: none;
                        box-sizing: border-box;
                        height: 26px;
					}
					#search-input:focus {
						border: 1px solid var(--vscode-focusBorder);
					}
                    ::placeholder {
                        color: var(--vscode-input-placeholderForeground);
                    }
				</style>
			</head>
			<body>
                <div class="container">
				    <input type="text" id="search-input" placeholder="Search Label Bookmark (itemA itemB...)" autocomplete="off" />
                </div>
				<script>
					const vscode = acquireVsCodeApi();
					const searchInput = document.getElementById('search-input');
					searchInput.addEventListener('input', (e) => {
						vscode.postMessage({
							type: 'search',
							value: e.target.value
						});
					});
				</script>
			</body>
			</html>`;
    }
}
