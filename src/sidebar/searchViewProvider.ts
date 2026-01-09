import * as vscode from 'vscode';

import { Controller } from '../core/controller';

export class BookmarksSearchViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'bookmarksSearch';

    private _view?: vscode.WebviewView;

    private _onDidChangeSearchQuery = new vscode.EventEmitter<string>();
    public readonly onDidChangeSearchQuery = this._onDidChangeSearchQuery.event;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _controllers: Controller[],
    ) { }

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
                    {
                        this._onDidChangeSearchQuery.fire(data.value);
                        break;
                    }
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
					body {
						padding: 0 10px;
						color: var(--vscode-foreground);
						font-family: var(--vscode-font-family);
					}
					.search-container {
						display: flex;
						align-items: center;
						padding: 10px 0;
					}
					#search-input {
						width: 100%;
						padding: 5px;
						background: var(--vscode-input-background);
						color: var(--vscode-input-foreground);
						border: 1px solid var(--vscode-input-border);
						outline: none;
					}
					#search-input:focus {
						border: 1px solid var(--vscode-focusBorder);
					}
				</style>
			</head>
			<body>
				<div class="search-container">
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
