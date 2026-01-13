/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { Position, Tab, TabInputText, TextDocument, Uri, ViewColumn } from "vscode";
import { codicons } from "vscode-ext-codicons";
import { BookmarkQuickPickItem } from "./core/bookmark";
import { NO_BOOKMARKS_AFTER, NO_BOOKMARKS_BEFORE, NO_MORE_BOOKMARKS } from "./core/constants";
import { Directions, isWindows, SEARCH_EDITOR_SCHEME } from "./core/constants";
import { Container } from "./core/container";
import { createBookmarkDecorations, updateDecorationsInActiveEditor } from "./decoration/decoration";
import { File } from "./core/file";
import { Controller } from "./core/controller";
import { indexOfBookmark, listBookmarks, nextBookmark, sortBookmarks } from "./core/operations";
import { loadBookmarks, saveBookmarks } from "./storage/workspaceState";
import { pickController } from "./quickpick/controllerPicker";
import { expandSelectionToNextBookmark, selectBookmarkedLines, shrinkSelection } from "./selections";
import { BookmarksExplorer } from "./sidebar/bookmarkProvider";
import { OrganizeViewProvider } from "./sidebar/organizeViewProvider";
import { BookmarksSearchViewProvider } from "./sidebar/searchViewProvider";
import { parsePosition, Point } from "./sidebar/parser";
import { Sticky } from "./sticky/stickyLegacy";
import { updateStickyBookmarks } from "./sticky/sticky";
import { suggestLabel, useSelectionWhenAvailable } from "./suggestion";
import { appendPath, getRelativePath } from "./utils/fs";
import { formatBookmarkLabel } from "./utils/label";
import { TagManager } from "./core/tagManager";
import { isInDiffEditor, previewPositionInDocument, revealPosition } from "./utils/reveal";
import { registerOpenSettings } from "./commands/openSettings";
import { registerSupportBookmarks } from "./commands/supportBookmarks";
import { registerExport } from "./commands/export";
import { registerHelpAndFeedbackView } from "./sidebar/helpAndFeedbackView";
import { registerWhatsNew } from "./whats-new/commands";
import { ViewAs } from "./sidebar/nodes";
import { Selection } from "vscode";
import { EditorLineNumberContextParams, updateLinesWithBookmarkContext } from "./gutter/editorLineNumberContext";
import { registerGutterCommands } from "./gutter/commands";
import { registerWalkthrough } from "./commands/walkthrough";

// this method is called when vs code is activated
export async function activate(context: vscode.ExtensionContext) {

    Container.context = context;
  
    let activeController: Controller;
    let controllers: Controller[] = [];
    let activeEditorCountLine: number;
    let timeout = null;
    let activeEditor = vscode.window.activeTextEditor;
    let bookmarkDecorationType = createBookmarkDecorations();
    context.subscriptions.push(...bookmarkDecorationType);

    await registerWhatsNew();
    await registerWalkthrough();
    
    context.subscriptions.push(vscode.commands.registerCommand("_bookmarks.openFolderWelcome", () => {
        const openFolderCommand = isWindows ? "workbench.action.files.openFolder" : "workbench.action.files.openFileFolder"
        vscode.commands.executeCommand(openFolderCommand)
    }));    
    
    // load pre-saved bookmarks
    await loadWorkspaceState();

    // 更新当前活动的编辑器
    if (vscode.window.activeTextEditor) {
        activeEditor = vscode.window.activeTextEditor;
        // 在多个 controller 中找到匹配当前文件路径的那个
        const controller = controllers.find(c => {
            const workspacePath = c.workspaceFolder?.uri?.fsPath;
            return workspacePath && activeEditor.document.uri.fsPath.startsWith(workspacePath);
        });
        
        if (controller) {
            activeController = controller;
            activeController.activeFile = activeController.fromUri(activeEditor.document.uri);
            updateDecorations();
        }
    }
    
    registerOpenSettings();
    registerSupportBookmarks();
    registerExport(() => controllers);
    registerHelpAndFeedbackView(context);

    const searchViewProvider = new BookmarksSearchViewProvider(context.extensionUri, controllers);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(BookmarksSearchViewProvider.viewType, searchViewProvider)
    );

    const bookmarkExplorer = new BookmarksExplorer(controllers);
    const bookmarkProvider = bookmarkExplorer.getProvider();    

    const organizeViewProvider = new OrganizeViewProvider(context.extensionUri, controllers);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(OrganizeViewProvider.viewType, organizeViewProvider)
    );

    let refreshExplorerTimeout: NodeJS.Timeout | undefined;
    organizeViewProvider.onDidUpdateBookmarks(() => {
        if (refreshExplorerTimeout) {
            clearTimeout(refreshExplorerTimeout);
        }
        refreshExplorerTimeout = setTimeout(() => {
            bookmarkProvider.refresh();
        }, 500);
    });

    vscode.commands.registerCommand("bookmarks.organize.search", async () => {
        const layer = await vscode.window.showInputBox({
            prompt: "输入要整理的层级名称（如: a）",
            placeHolder: "层级名称"
        });
        if (layer) {
            await organizeViewProvider.search(layer);
        }
    });

    vscode.commands.registerCommand("bookmarks.organize.refresh", async () => {
        await organizeViewProvider.refresh();
    });

    let searchDebounceTimeout: NodeJS.Timeout | undefined;
    searchViewProvider.onDidChangeSearchQuery(query => {
        if (searchDebounceTimeout) {
            clearTimeout(searchDebounceTimeout);
        }
        searchDebounceTimeout = setTimeout(() => {
            bookmarkProvider.filterQuery = query;
            searchDebounceTimeout = undefined;
        }, 500);
    });

    bookmarkExplorer.updateBadge();

    toggleSideBarWelcomeVisibility();

    vscode.commands.registerCommand("_bookmarks.sidebar.hidePosition", () => toggleSidebarPositionVisibility(false));
    vscode.commands.registerCommand("_bookmarks.sidebar.showPosition", () => toggleSidebarPositionVisibility(true));
    vscode.commands.executeCommand("setContext", "bookmarks.isHidingPosition", 
        Container.context.globalState.get<boolean>("bookmarks.sidebar.hidePosition", false));
    
    function toggleSideBarWelcomeVisibility() {
        vscode.commands.executeCommand("setContext", "bookmarks.isHidingWelcome",
            vscode.workspace.getConfiguration("bookmarks").get("sideBar.hideWelcome", false)
        );
    }

    function toggleSidebarPositionVisibility(visible: boolean) {
        vscode.commands.executeCommand("setContext", "bookmarks.isHidingPosition", !visible);
        Container.context.globalState.update("bookmarks.sidebar.hidePosition", !visible);
        bookmarkProvider.refresh();
    }   
    
    const viewAsList = Container.context.globalState.get<boolean>("viewAsList", true);
    vscode.commands.executeCommand("setContext", "bookmarks.viewAsList", viewAsList);
    const viewAsGrouped = Container.context.globalState.get<boolean>("viewAsGrouped", false);
    vscode.commands.executeCommand("setContext", "bookmarks.viewAsGrouped", viewAsGrouped);
    vscode.commands.registerCommand("_bookmarks.viewAsTree#sideBar", () => toggleViewAs(ViewAs.VIEW_AS_TREE));
    vscode.commands.registerCommand("_bookmarks.viewAsList#sideBar", () => toggleViewAs(ViewAs.VIEW_AS_LIST));
    vscode.commands.registerCommand("_bookmarks.viewAsGrouped#sideBar", () => toggleViewAs(ViewAs.VIEW_AS_GROUPED));
    vscode.commands.registerCommand("_bookmarks.viewAsGrouped#sideBar_off", () => toggleViewAs(ViewAs.VIEW_AS_TREE));
    function toggleViewAs(view: ViewAs) {
        if (view === ViewAs.VIEW_AS_LIST) {
            vscode.commands.executeCommand("setContext", "bookmarks.viewAsList", true);
            vscode.commands.executeCommand("setContext", "bookmarks.viewAsGrouped", false);
        } else if (view === ViewAs.VIEW_AS_GROUPED) {
            vscode.commands.executeCommand("setContext", "bookmarks.viewAsList", false);
            vscode.commands.executeCommand("setContext", "bookmarks.viewAsGrouped", true);
        } else {
            vscode.commands.executeCommand("setContext", "bookmarks.viewAsList", false);
            vscode.commands.executeCommand("setContext", "bookmarks.viewAsGrouped", false);
        }
        Container.context.globalState.update("viewAsList", view === ViewAs.VIEW_AS_LIST);
        Container.context.globalState.update("viewAsGrouped", view === ViewAs.VIEW_AS_GROUPED);
        bookmarkProvider.refresh();
    }

    vscode.window.onDidChangeActiveTextEditor(editor => {
        activeEditor = editor;
        if (editor) {
            activeEditorCountLine = editor.document.lineCount;
            getActiveController(editor.document);
            activeController.addFile(editor.document.uri);
            activeController.activeFile = activeController.fromUri(editor.document.uri);
            triggerUpdateDecorations();
            updateLinesWithBookmarkContext(activeController.activeFile);
        }
    }, null, context.subscriptions);

    vscode.workspace.onDidChangeTextDocument(event => {
        if (activeEditor && event.document === activeEditor.document) {
//            triggerUpdateDecorations();
            let updatedBookmark = false;

            // workaround for formatters like Prettier (#118)
            if (vscode.workspace.getConfiguration("bookmarks").get("useWorkaroundForFormatters", false)) {
                updateDecorations();
                return;
            }

            // call sticky function when the activeEditor is changed
            if (activeController.activeFile && activeController.activeFile.bookmarks.length > 0) {
                if (vscode.workspace.getConfiguration("bookmarks").get<boolean>("experimental.enableNewStickyEngine", true)) {
                    updatedBookmark = updateStickyBookmarks(event, activeController.activeFile,
                        activeEditor, activeController);
                } else {
                    updatedBookmark = Sticky.stickyBookmarks(event, activeEditorCountLine, activeController.activeFile,
                        activeEditor, activeController);
                }
            }

            activeEditorCountLine = event.document.lineCount;
            updateDecorations();

            if (updatedBookmark) {
                saveWorkspaceState();
            }
        }
    }, null, context.subscriptions);

    context.subscriptions.push(vscode.workspace.onDidRenameFiles(async rename => {
        
        if (rename.files.length === 0) { return; } 
        
        for (const file of rename.files) {
            const files = activeController.files.map(file => file.path);
            const stat = await vscode.workspace.fs.stat(file.newUri);
            
            const fileRelativeOldPath = getRelativePath(activeController.workspaceFolder.uri.path, file.oldUri.path);
            const fileRelativeNewPath = getRelativePath(activeController.workspaceFolder.uri.path, file.newUri.path);

            if (stat.type === vscode.FileType.File) {
                if (files.includes(fileRelativeOldPath)) {
                    activeController.updateFilePath(fileRelativeOldPath, fileRelativeNewPath);
                }
            }
            if (stat.type === vscode.FileType.Directory) {
                activeController.updateDirectoryPath(fileRelativeOldPath, fileRelativeNewPath);
            }
        }

        bookmarkProvider.refresh();
        saveWorkspaceState();
        if (activeEditor) {
            activeController.activeFile = activeController.fromUri(activeEditor.document.uri);
            updateDecorations();
        }
    }));

    // Timeout
    function triggerUpdateDecorations() {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(updateDecorations, 100);
    }

    // Evaluate (prepare the list) and DRAW
    function updateDecorations() {
        updateDecorationsInActiveEditor(activeEditor, activeController, bookmarkDecorationType);
    }

    updateDecorations();

    vscode.commands.registerCommand("_bookmarks.jumpTo", (documentPath, line, column: string, uri: Uri) => {
        vscode.workspace.openTextDocument(uri).then(doc => {
            vscode.window.showTextDocument(doc ).then(() => {
                const lineInt: number = parseInt(line, 10);
                const colunnInt: number = parseInt(column, 10);
                revealPosition(lineInt - 1, colunnInt - 1);
            });
        });
    });

    registerGutterCommands(toggle, toggleLabeled);

    vscode.commands.registerCommand("bookmarks.refresh", () => {
        bookmarkProvider.refresh();
    });

    vscode.commands.registerCommand("_bookmarks.clearFromFile", node => {
        activeController.clear(node.bookmark);
        saveWorkspaceState();
        updateDecorations();
    });

    vscode.commands.registerCommand("_bookmarks.deleteBookmark", node => {
        const book: File = activeController.fromUri(node.command.arguments[3]);
        const index = indexOfBookmark(book, node.command.arguments[1] - 1); 
        activeController.removeBookmark(index, node.command.arguments[1] - 1, book);
        saveWorkspaceState();
        updateDecorations();
    });

    vscode.commands.registerCommand("_bookmarks.editLabel", node => {
        const book: File = activeController.fromUri(node.command.arguments[3]);
        const index = indexOfBookmark(book, node.command.arguments[1] - 1);

        const position: vscode.Position = new vscode.Position(node.command.arguments[1] - 1, 
            node.command.arguments[2] - 1);
        const suggestedLabel = book.bookmarks[index].label || node.label;
        askForBookmarkLabel(index, position, suggestedLabel, false, book);
    });

    vscode.commands.registerCommand("bookmarks.clear", () => clear());
    vscode.commands.registerCommand("bookmarks.clearFromAllFiles", () => clearFromAllFiles());
    vscode.commands.registerCommand("bookmarks.selectLines", () => selectBookmarkedLines(activeController));
    vscode.commands.registerCommand("bookmarks.expandSelectionToNext", () => expandSelectionToNextBookmark(activeController, Directions.Forward));
    vscode.commands.registerCommand("bookmarks.expandSelectionToPrevious", () => expandSelectionToNextBookmark(activeController, Directions.Backward));
    vscode.commands.registerCommand("bookmarks.shrinkSelection", () => shrinkSelection(activeController));
    vscode.commands.registerCommand("bookmarks.toggle", () => toggle());
    vscode.commands.registerCommand("bookmarks.toggleLabeled", () => toggleLabeled());    
    vscode.commands.registerCommand("bookmarks.jumpToNext", () => jumpToNext(Directions.Forward));
    vscode.commands.registerCommand("bookmarks.jumpToPrevious", () => jumpToNext(Directions.Backward));
    vscode.commands.registerCommand("bookmarks.list", () => list());
    vscode.commands.registerCommand("bookmarks.listFromAllFiles", () => listFromAllFiles());
    
    function getActiveController(document: TextDocument): void {
        // system files don't have workspace, so use the first one [0]
        if (!vscode.workspace.getWorkspaceFolder(document.uri)) {
            activeController = controllers[0];
            return;
        }

        if (controllers.length > 1) {
            activeController = controllers.find(ctrl =>
                ctrl.workspaceFolder.uri.path === vscode.workspace.getWorkspaceFolder(document.uri).uri.path);
        }
    }

    function splitOrMergeFilesInMultiRootControllers(): void {
        // 
        if (vscode.workspace.workspaceFolders.length < 2) {
            return;
        }

        //?? needs work
        const saveBookmarksInProject = vscode.workspace.getConfiguration("bookmarks").get("saveBookmarksInProject", false);

        if (saveBookmarksInProject) {
            const validFiles = activeController.files.filter(file => !file.path.startsWith(".."));
            activeController.files = [...validFiles];
        }
    }

    async function loadWorkspaceState(): Promise<void> {

        // no workspace, load as `undefined` and will always be from `workspaceState`
        if (!vscode.workspace.workspaceFolders) {
            const ctrl = await loadBookmarks(undefined);
            controllers.push(ctrl);
            activeController = ctrl;
            return;
        }

        // NOT `saveBookmarksInProject`
        if (!vscode.workspace.getConfiguration("bookmarks").get("saveBookmarksInProject", false)) {
            //if (vscode.workspace.workspaceFolders.length > 1) {
            // no matter how many workspaceFolders exists, will always load from [0] because even with 
            // multi-root, there would be no way to load state from different folders
            const ctrl = await loadBookmarks(vscode.workspace.workspaceFolders[0]);
            controllers.push(ctrl);
            activeController = ctrl;
            return;
        }

        // `saveBookmarksInProject` TRUE
        // single or multi-root, will load from each `workspaceFolder`
        controllers = await Promise.all(
            vscode.workspace.workspaceFolders!.map(async workspaceFolder => {
                const ctrl = await loadBookmarks(workspaceFolder);
                return ctrl;
            })
        );
        if (controllers.length === 1) {
            activeController = controllers[0];
        }
    }

    function saveWorkspaceState(): void {
        // no workspace, there is only one `controller`, and will always be from `workspaceState`
        if (!vscode.workspace.workspaceFolders) {
            saveBookmarks(activeController);
            return;
        }

        // NOT `saveBookmarksInProject`, will load from `workspaceFolders[0]` - as before
        if (!vscode.workspace.getConfiguration("bookmarks").get("saveBookmarksInProject", false)) {
            // no matter how many workspaceFolders exists, will always save to [0] because even with
            // multi-root, there would be no way to save state to different folders
            saveBookmarks(activeController);
            return;
        }

        // `saveBookmarksInProject` TRUE
        // single or multi-root, will save to each `workspaceFolder` 
        controllers.forEach(controller => {
            saveBookmarks(controller);
        });
    }

    function list() {
        
        if (!vscode.window.activeTextEditor) {
          vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to list bookmarks"));
          return;
        }
        
        // no active bookmark
        if (!activeController.activeFile) {
            vscode.window.showInformationMessage(vscode.l10n.t("No Bookmarks found"));
            return;  
        }
      
        // no bookmark
        if (activeController.activeFile.bookmarks.length === 0) {
            vscode.window.showInformationMessage(vscode.l10n.t("No Bookmarks found"));
            return;
        }

        // push the items
        const items: vscode.QuickPickItem[] = [];
        // tslint:disable-next-line:prefer-for-of
        for (let index = 0; index < activeController.activeFile.bookmarks.length; index++) {

            const bookmarkLine = activeController.activeFile.bookmarks[index].line + 1;
            const bookmarkColumn = activeController.activeFile.bookmarks[index].column + 1;
            const lineText = vscode.window.activeTextEditor.document.lineAt(bookmarkLine - 1).text.trim();

            if (activeController.activeFile.bookmarks[index].label === "") {
                items.push({ description: "(Ln " + bookmarkLine.toString() + ", Col " + 
                    bookmarkColumn.toString() + ")", label: lineText });
            } else {
                items.push({ description: "(Ln " + bookmarkLine.toString() + ", Col " + 
                bookmarkColumn.toString() + ")", 
                label: codicons.tag + " " + activeController.activeFile.bookmarks[index].label });
            }
        }

        // pick one
        const currentPosition: Position = vscode.window.activeTextEditor.selection.active;
        const options = <vscode.QuickPickOptions> {
            placeHolder: vscode.l10n.t("Type a line number or a piece of code to navigate to"),
            matchOnDescription: true,
            // matchOnDetail: true,
            onDidSelectItem: item => {
                const itemT = <vscode.QuickPickItem> item;
                const point: Point = parsePosition(itemT.description);
                if (point) {
                    revealPosition(point.line - 1, point.column - 1);
                }
            }
        };

        vscode.window.showQuickPick(items, options).then(selection => {
            if (typeof selection === "undefined") {
                revealPosition(currentPosition.line, currentPosition.character);
                return;
            }
            const itemT = <vscode.QuickPickItem> selection;
            const point: Point = parsePosition(itemT.description);
            if (point) {
                revealPosition(point.line - 1, point.column - 1);
            }
    });
    }

    function clear() {
        
        if (!vscode.window.activeTextEditor) {
          vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to clear bookmarks"));
          return;
        }      
      
        activeController.clear();
        saveWorkspaceState();
        updateDecorations();
    }

    async function clearFromAllFiles() {
        
        const controller = await pickController(controllers, activeController);
        if (!controller) {
            return
        }
        
        controller.clearAll();

        saveWorkspaceState();
        updateDecorations();
    }

    async function listFromAllFiles() {

        const controller = await pickController(controllers, activeController);
        if (!controller) {
            return
        }

        // no bookmark
        if (!controller.hasAnyBookmark()) {
            vscode.window.showInformationMessage(vscode.l10n.t("No Bookmarks found"));
            return;
        }

        // push the items
        const items: BookmarkQuickPickItem[] = [];
        const activeTextEditor = vscode.window.activeTextEditor;
        const promisses = [];
        const currentPosition: Position = vscode.window.activeTextEditor?.selection.active;
        
        for (const bookmark of controller.files) {
            const pp = listBookmarks(bookmark, controller.workspaceFolder);
            promisses.push(pp);
        }
        
        Promise.all(promisses).then(
          (values) => {
              
              for (const element of values) {
                  if (element) {
                    for (const elementInside of element) {
                        if (activeTextEditor &&
                            elementInside.detail.toString().toLocaleLowerCase() === getRelativePath(controller.workspaceFolder?.uri?.path, activeTextEditor.document.uri.path).toLocaleLowerCase()) {
                            items.push(
                                {
                                    label: elementInside.label,
                                    description: elementInside.description,
                                    uri: elementInside.uri
                                }
                            );
                        } else {
                            items.push(
                                {
                                    label: elementInside.label,
                                    description: elementInside.description,
                                    detail: elementInside.detail,
                                    uri: elementInside.uri
                                }
                            );
                        }
                    }

                  }

              }

              // sort
              // - active document
              // - no octicon - document in same workspaceFolder
              // - with octicon 'file-submodules' - document in another workspaceFolder
              // - with octicon - 'file-directory' - document outside any workspaceFolder
              const itemsSorted: vscode.QuickPickItem[] = items.sort(function(a: vscode.QuickPickItem, b: vscode.QuickPickItem): number {
                if (!a.detail && !b.detail) {
                    return 0;
                }
                
                if (!a.detail && b.detail) {
                    return -1;
                }
                
                if (a.detail && !b.detail) {
                    return 1;
                }
                
                if ((a.detail.toString().indexOf(codicons.file_submodule + " ") === 0) && (b.detail.toString().indexOf(codicons.file_directory + " ") === 0)) {
                    return -1;
                }
                
                if ((a.detail.toString().indexOf(codicons.file_directory + " ") === 0) && (b.detail.toString().indexOf(codicons.file_submodule + " ") === 0)) {
                    return 1;
                }
                
                if ((a.detail.toString().indexOf(codicons.file_submodule + " ") === 0) && (b.detail.toString().indexOf(codicons.file_submodule + " ") === -1)) {
                    return 1;
                }
                
                if ((a.detail.toString().indexOf(codicons.file_submodule + " ") === -1) && (b.detail.toString().indexOf(codicons.file_submodule + " ") === 0)) {
                    return -1;
                }
                
                if ((a.detail.toString().indexOf(codicons.file_directory + " ") === 0) && (b.detail.toString().indexOf(codicons.file_directory + " ") === -1)) {
                    return 1;
                }
                
                if ((a.detail.toString().indexOf(codicons.file_directory + " ") === -1) && (b.detail.toString().indexOf(codicons.file_directory + " ") === 0)) {
                    return -1;
                }
                
                return 0;
              });

              const options = <vscode.QuickPickOptions> {
                  placeHolder: vscode.l10n.t("Type a line number or a piece of code to navigate to"),
                  matchOnDescription: true,
                  onDidSelectItem: item => {

                    const itemT = <BookmarkQuickPickItem> item;

                    let fileUri: Uri;
                    if (!itemT.detail) {
                        fileUri = activeTextEditor.document.uri;
                    } else {
                        fileUri = itemT.uri;
                    }

                      const point: Point = parsePosition(itemT.description);
                      if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.fsPath.toLowerCase() === fileUri.fsPath.toLowerCase()) {
                        if (point) {
                            revealPosition(point.line - 1, point.column - 1);
                        }
                      } else {
                        previewPositionInDocument(point, fileUri);
                      }
                  }
              };
              vscode.window.showQuickPick(itemsSorted, options).then(selection => {
                  if (typeof selection === "undefined") {
                      if (!activeTextEditor)  {
                            vscode.commands.executeCommand("workbench.action.closeActiveEditor");
                          return;
                      } else {
                        vscode.workspace.openTextDocument(activeTextEditor.document.uri).then(doc => {
                            vscode.window.showTextDocument(doc).then(() => {
                                revealPosition(currentPosition.line, currentPosition.character);
                                return;
                            });
                        });                          
                      }
                  }
                  
                  if (typeof selection === "undefined") {
                      return;
                  }

                  const point: Point = parsePosition(selection.description);
                  if (!selection.detail) {
                    if (point) {
                        revealPosition(point.line - 1, point.column - 1);
                    }
                  }
              });
            }  
        );
    }

    function jumpToNext(direction: Directions) {
        
        if (!vscode.window.activeTextEditor) {
          vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to jump to bookmarks"));
          return;
        }
        
        if (!activeController.activeFile) {
            return;
        }      
        
        // 
        nextBookmark(activeController.activeFile, vscode.window.activeTextEditor.selection.active, direction)
            .then((next) => {
              if (typeof next === "number") {

                if (!checkBookmarks(next)) {
                    return;
                }

                activeController.nextDocumentWithBookmarks(activeController.activeFile, direction)
                  .then((nextDocument) => {
                      
                      if (nextDocument === NO_MORE_BOOKMARKS) {
                        return;
                      }

                      let uriDocument: Uri;
                      if (typeof nextDocument === "string") {
                        uriDocument = !activeController.workspaceFolder
                            ? Uri.file(nextDocument.toString())
                            : appendPath(activeController.workspaceFolder.uri, nextDocument.toString());
                      } else {
                          uriDocument = <Uri>nextDocument;
                      }

                      // same document?
                    //   const activeDocument = getRelativePath(activeController.workspaceFolder?.uri?.path, vscode.window.activeTextEditor.document.uri.fsPath);
                    //   if (nextDocument.toString() === activeDocument) {
                      if (uriDocument.fsPath === vscode.window.activeTextEditor.document.uri.fsPath) {
                        const bookmarkIndex = direction === Directions.Forward ? 0 : activeController.activeFile.bookmarks.length - 1;
                        revealPosition(activeController.activeFile.bookmarks[bookmarkIndex].line, 
                            activeController.activeFile.bookmarks[bookmarkIndex].column);
                        } else { 
                            // const uriDocument = !activeController.workspaceFolder
                            //     ? Uri.file(nextDocument.toString())
                            //     : appendPath(activeController.workspaceFolder.uri, nextDocument.toString());
                            const tabGroupColumn = findTabGroupColumn(uriDocument, vscode.window.activeTextEditor.viewColumn);

                            vscode.workspace.openTextDocument(uriDocument).then(doc => {
                                vscode.window.showTextDocument(doc, tabGroupColumn).then(() => {
                                    const bookmarkIndex = direction === Directions.Forward ? 0 : activeController.activeFile.bookmarks.length - 1;
                                    revealPosition(activeController.activeFile.bookmarks[bookmarkIndex].line, 
                                        activeController.activeFile.bookmarks[bookmarkIndex].column);
                            });
                        });
                      }
                  })
                  .catch(checkBookmarks);
              } else {
                  revealPosition(next.line, next.character);
              }
            })
            .catch((error) => {
              console.log("activeBookmark.nextBookmark REJECT" + error);
            });
    }

    function findTabGroupColumn(uri: Uri, column: ViewColumn): ViewColumn {
        if (vscode.window.tabGroups.all.length === 1) {
            return column;
        }

        for (const tab of vscode.window.tabGroups.activeTabGroup.tabs) {
            if (isTabOfUri(tab, uri)) {
                return tab.group.viewColumn;
            }
        }

        for (const tabGroup of vscode.window.tabGroups.all) {
            if (tabGroup.viewColumn === column) 
                continue;
            
            for (const tab of tabGroup.tabs) {
                if (isTabOfUri(tab, uri)) {
                    return tab.group.viewColumn;
                }
            }
        }

        return column;
    }

    function isTabOfUri(tab: Tab, uri: Uri): boolean {
        return tab.input instanceof TabInputText &&
                tab.input.uri.fsPath.toLocaleLowerCase() === uri.fsPath.toLocaleLowerCase()
    }

    function checkBookmarks(result: number | vscode.Position): boolean {
        if (result === NO_BOOKMARKS_BEFORE || result === NO_BOOKMARKS_AFTER) {
            if (vscode.workspace.getConfiguration("bookmarks").get("showNoMoreBookmarksWarning", true)) {
                vscode.window.showInformationMessage(vscode.l10n.t("No more bookmarks"));
            }
            return false;
        }
        return true;
    }

    function askForBookmarkLabel(index: number, position: vscode.Position, oldLabel?: string, jumpToPosition?: boolean,
                                 book?: File) {
        showTagInputBox(oldLabel || "", oldLabel || "").then(bookmarkLabel => {
            if (typeof bookmarkLabel === "undefined") {
                return;
            }
            // 'empty'
            if (bookmarkLabel === "" && oldLabel === "") {
                vscode.window.showWarningMessage(vscode.l10n.t("You must define a label for the bookmark."));
                return;
            }
            if (index >= 0) {
                activeController.removeBookmark(index, position.line, book);
            }
            const formattedLabel = formatBookmarkLabel(bookmarkLabel);
            activeController.addBookmark(position, formattedLabel, book);
            
            // toggle editing mode
            if (jumpToPosition) {
                vscode.window.showTextDocument(vscode.window.activeTextEditor.document, { preview: false, viewColumn: vscode.window.activeTextEditor.viewColumn });
            }
            // sorted
            /* let itemsSorted = [] =*/
            const b: File = book ? book : activeController.activeFile;
            sortBookmarks(b);
            saveWorkspaceState();
            updateDecorations();
        });
    }

    async function toggle(params?: EditorLineNumberContextParams) {
        const selections: Selection[] = [];

        if (params) {
            const posAnchor = new Position(params.lineNumber - 1, 0);
            const posActive= new Position(params.lineNumber - 1, 0);
            const sel = new Selection(posAnchor, posActive);
            selections.push(sel);
        } else {

            if (!vscode.window.activeTextEditor) {
                vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to toggle bookmarks"));
                return;
            }         
            
            if (vscode.window.activeTextEditor.document.uri.scheme === SEARCH_EDITOR_SCHEME) {
                vscode.window.showInformationMessage(vscode.l10n.t("You can't toggle bookmarks in Search Editor"));
                return;
            }         
            
            selections.push(...vscode.window.activeTextEditor.selections);
        }

        // fix issue emptyAtLaunch
        if (!activeController.activeFile) {
            activeController.addFile(vscode.window.activeTextEditor.document.uri);
            activeController.activeFile = activeController.fromUri(vscode.window.activeTextEditor.document.uri);
        }

        if (await activeController.toggle(selections)) {
            if (!isInDiffEditor()) {
                vscode.window.showTextDocument(vscode.window.activeTextEditor.document, {preview: false, viewColumn: vscode.window.activeTextEditor.viewColumn} );
            }
        }

        sortBookmarks(activeController.activeFile);
        saveWorkspaceState();
        updateDecorations();
        updateLinesWithBookmarkContext(activeController.activeFile);
        // bookmarkExplorer.updateBadge();
    }

    async function showTagInputBox(suggestion: string, oldLabel: string): Promise<string | undefined> {
        return new Promise((resolve) => {
            const quickPick = vscode.window.createQuickPick();
            quickPick.title = vscode.l10n.t("Bookmark Label");
            quickPick.placeholder = vscode.l10n.t("Type a label for your bookmark");
            
            // 初始值处理
            let initialValue = suggestion || oldLabel || "[]";
            if (!initialValue.includes("[") && !initialValue.includes("]")) {
                initialValue = `[${initialValue}]`;
            }
            quickPick.value = initialValue;

            const allNodes = TagManager.getAllTagNodes(controllers);

            // 针对 QuickPick 的特殊行为优化
            // 当 value 改变时，QuickPick 会自动过滤 items。
            // 我们的补全是基于逻辑生成的，需要关闭自动过滤或动态更新
            quickPick.items = []; // 初始清空

            const updateItems = (value: string) => {
                // 匹配方括号内的内容
                const openIdx = value.indexOf('[');
                const closeIdx = value.indexOf(']');
                
                let content = "";
                if (openIdx !== -1) {
                    if (closeIdx !== -1 && closeIdx > openIdx) {
                        // 有完整的 []
                        content = value.substring(openIdx + 1, closeIdx);
                    } else {
                        // 只有 [，取 [ 之后到空格或结尾的内容
                        const spaceIdx = value.indexOf(' ', openIdx);
                        if (spaceIdx === -1) {
                            content = value.substring(openIdx + 1);
                        } else {
                            content = value.substring(openIdx + 1, spaceIdx);
                        }
                    }

                    const completions = TagManager.getCompletions(content, allNodes);
                    
                    const newItems = completions.map(c => ({ 
                        label: c, // 只显示节点名称，如 "a"
                        description: "Add this tag node",
                        alwaysShow: true 
                    }));
                    
                    quickPick.items = newItems;
                } else {
                    quickPick.items = [];
                }
            };

            // 初始补全项
            updateItems(quickPick.value);

            quickPick.onDidChangeValue(value => {
                // 如果用户输入的是 [] 且之前已经有了 items，保持 items 不变，
                // 除非是由于 value 改变导致的过滤逻辑失效
                updateItems(value);
            });

            quickPick.onDidAccept(() => {
                // 如果当前有选中的建议项
                if (quickPick.selectedItems.length > 0) {
                    const selectedNode = quickPick.selectedItems[0].label; // 例如 "a"
                    const currentValue = quickPick.value;
                    
                    // 找到当前输入框中的 [] 位置
                    const openIdx = currentValue.indexOf('[');
                    const closeIdx = currentValue.indexOf(']');
                    
                    if (openIdx !== -1) {
                        // 提取括号内的现有内容
                        let contentBeforeClose = "";
                        if (closeIdx !== -1 && closeIdx > openIdx) {
                            contentBeforeClose = currentValue.substring(openIdx + 1, closeIdx);
                        } else {
                            // 如果没有闭合括号，尝试按空格分割或取到结尾
                            const spaceIdx = currentValue.indexOf(' ', openIdx);
                            contentBeforeClose = spaceIdx === -1 
                                ? currentValue.substring(openIdx + 1) 
                                : currentValue.substring(openIdx + 1, spaceIdx);
                        }

                        // 将选中的节点替换/追加到括号内的最后一个部分
                        const parts = contentBeforeClose.split('-');
                        parts[parts.length - 1] = selectedNode;
                        const newContent = parts.join('-') + '-'; // 补齐 '-'
                        
                        // 重新拼装完整字符串，确保保留右括号和后面的内容
                        let newValue = "";
                        let newCursorOffset = 0;
                        if (closeIdx !== -1 && closeIdx > openIdx) {
                            newValue = currentValue.substring(0, openIdx + 1) + 
                                       newContent + 
                                       currentValue.substring(closeIdx);
                            newCursorOffset = openIdx + 1 + newContent.length;
                        } else {
                            // 补上缺失的右括号
                            const suffix = currentValue.substring(openIdx + 1 + contentBeforeClose.length);
                            newValue = currentValue.substring(0, openIdx + 1) + 
                                       newContent + 
                                       ']' + suffix;
                            newCursorOffset = openIdx + 1 + newContent.length;
                        }
                        
                        quickPick.value = newValue;
                        
                        // 强制通过设置 value 来尝试让 VS Code 把光标放到最后，
                        // 但由于 VS Code QuickPick 的限制，我们采用一种“欺骗”方式：
                        // 如果有右括号，我们暂时去掉右括号后面的内容，让光标落在最后，然后再补回来？
                        // 不，更可靠的方法是：只保留到 '-' 为止的内容，让用户继续输入，
                        // 等用户最终回车时再由 formatBookmarkLabel 统一处理右括号和备注。
                        
                        // 既然用户希望光标在 '-' 后面，我们就在补全时，把 '-' 之后的所有内容（包括 ] 和备注）暂时去掉
                        // 这样 VS Code 就会自然地把光标停在 '-' 后面。
                        const valueToSet = currentValue.substring(0, openIdx + 1) + newContent;
                        const remainingToRestore = (closeIdx !== -1 && closeIdx > openIdx) 
                            ? currentValue.substring(closeIdx)
                            : "]" + currentValue.substring(openIdx + 1 + contentBeforeClose.length);
                        
                        quickPick.value = valueToSet;
                        
                        // 记录下剩余部分，在下一次 updateItems 或回车时拼回去？
                        // 这种做法比较复杂。其实最简单且符合 VS Code 行为的做法是：
                        // 如果 value 改变，光标默认会在末尾。
                        // 所以我们只需要让 '-' 成为 value 的末尾即可。
                        
                        // 为了不丢掉用户的备注，我们把备注存到一个临时变量里，或者直接让用户在补全完标签后再输入备注。
                        // 但考虑到用户体验，我们还是尝试保留：
                        quickPick.value = valueToSet + remainingToRestore;
                        // 此时光标会在 newValue 的末尾。
                        
                        // 重点：VS Code QuickPick API 确实不支持设置光标位置。
                        // 唯一的办法是：补全时，不补全右括号及其后面的内容，
                        // 让用户一路补全节点，最后想写备注时再写，或者由我们最后自动补齐 ]。
                        
                        const simplifiedValue = currentValue.substring(0, openIdx + 1) + newContent;
                        const extraText = (closeIdx !== -1 && closeIdx > openIdx)
                            ? currentValue.substring(closeIdx + 1).trim()
                            : currentValue.substring(openIdx + 1 + contentBeforeClose.length).trim();
                        
                        // 如果后面有备注，补全后变成 "[a-b-] 备注"，光标会在最后。
                        // 如果我们希望光标在 - 后面，我们只能把 newValue 设为 "[a-b-"
                        // 然后把备注暂时存在 description 或者某个地方？不，这太奇怪了。
                        
                        // 另一种尝试：利用 VS Code 会把光标放在新插入文本之后的特性（如果能模拟输入）
                        // 但 QuickPick 只能设置整个 value。
                        
                        // 最终方案：为了连续补全的爽快感，补全节点时暂时移除右括号和备注，
                        // 让输入框只剩下 "[a-b-"，这样光标一定在横杠后。
                        // 用户补全完所有节点后，直接按回车，我们在 resolve 前自动补齐括号。
                        
                        quickPick.value = simplifiedValue;
                        if (extraText) {
                            // 如果有备注，把它放在 placeholder 里提醒用户，或者等用户最后再输
                            quickPick.placeholder = `Tag: ${simplifiedValue}], Note: ${extraText}`;
                        }
                    } else {
                        // 兜底逻辑：如果没有找到 [，直接补全为 [a-]
                        quickPick.value = `[${selectedNode}-]${currentValue}`;
                    }
                    
                    // 清空选中状态，这样下次回车就会触发 else 分支提交书签
                    quickPick.selectedItems = [];
                    // 重新触发一次 items 更新
                    updateItems(quickPick.value);
                    return;
                }
                
                // 如果没有选中项，说明用户是在输入框里直接按回车，此时提交结果
                let finalValue = quickPick.value;
                // 如果结尾没有 ]，补上
                if (finalValue.includes('[') && !finalValue.includes(']')) {
                    finalValue += ']';
                }
                resolve(finalValue);
                quickPick.hide();
            });

            quickPick.onDidHide(() => {
                resolve(undefined);
                quickPick.dispose();
            });

            quickPick.show();
        });
    }

    async function toggleLabeled(params?: EditorLineNumberContextParams) {

        const selections: Selection[] = [];

        if (params) {
            const posAnchor = new Position(params.lineNumber - 1, 0);
            const posActive= new Position(params.lineNumber - 1, 0);
            const sel = new Selection(posAnchor, posActive);
            selections.push(sel);
        } else {
            if (!vscode.window.activeTextEditor) {
                vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to toggle bookmarks"));
                return;
            }

            selections.push(...vscode.window.activeTextEditor.selections);
        }
        // fix issue emptyAtLaunch
        if (!activeController.activeFile) {
            activeController.addFile(vscode.window.activeTextEditor.document.uri);
            activeController.activeFile = activeController.fromUri(vscode.window.activeTextEditor.document.uri);
        }

        let suggestion = suggestLabel(vscode.window.activeTextEditor.selection);
        if (!params && suggestion !== "" && useSelectionWhenAvailable()) {
            const formattedSuggestion = formatBookmarkLabel(suggestion);
            if (await activeController.toggle(selections, formattedSuggestion)) {
                vscode.window.showTextDocument(vscode.window.activeTextEditor.document, {preview: false, viewColumn: vscode.window.activeTextEditor.viewColumn} );
            }
            sortBookmarks(activeController.activeFile); 
            saveWorkspaceState();
            updateDecorations();
            updateLinesWithBookmarkContext(activeController.activeFile);
            return;
        }

        // ask label
        let oldLabel = "";
        if (!params && suggestion === "" && selections.length === 1) {
            const index = indexOfBookmark(activeController.activeFile, selections[0].active.line);
            oldLabel = index > -1 ? activeController.activeFile.bookmarks[index].label : "";
            suggestion = oldLabel;
        }

        const newLabel = await showTagInputBox(suggestion, oldLabel);
        if (typeof newLabel === "undefined") { return; }
        if (newLabel === "" && oldLabel === "") {
            vscode.window.showWarningMessage(vscode.l10n.t("You must define a label for the bookmark."));
            return;
        }

        const formattedLabel = formatBookmarkLabel(newLabel);
        if (await activeController.toggle(selections, formattedLabel)) {
            vscode.window.showTextDocument(vscode.window.activeTextEditor.document, {preview: false, viewColumn: vscode.window.activeTextEditor.viewColumn} );
        }

        // sorted
        /* let itemsSorted = [] =*/
        const b: File = activeController.activeFile;
        b.bookmarks.sort((n1, n2) => {
            if (n1.line > n2.line) {
                return 1;
            }
            if (n1.line < n2.line) {
                return -1;
            }
            return 0;
        });
        
        saveWorkspaceState();
        updateDecorations();
        updateLinesWithBookmarkContext(activeController.activeFile);
    }
}