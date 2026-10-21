import * as path from 'node:path';
import * as vscode from 'vscode';

import { hashDocumentText } from './anchors.js';
import { readCodeBlocks, withDetectedCodeBlocks } from './codeBlocks.js';
import { locateCodeBlock } from './codeLocation.js';
import { CodeReferences, openCodeCommand } from './codeReferences.js';
import type { CodeAnchor, ReviewMessage, ReviewStore, ReviewThread } from './contracts.js';
import { isWorkspaceRelativePath } from './git.js';

const snippetScheme = 'local-review-snippet';
const languageAliases: Readonly<Record<string, string>> = {
  js: 'javascript', cjs: 'javascript', mjs: 'javascript', jsx: 'javascriptreact',
  ts: 'typescript', tsx: 'typescriptreact', py: 'python', rs: 'rust', rb: 'ruby',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', yml: 'yaml',
  md: 'markdown', h: 'c', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', 'c++': 'cpp',
  cs: 'csharp', 'c#': 'csharp', ps1: 'powershell', kt: 'kotlin',
};

interface Snippet {
  readonly code: string;
}

/** Render native themed code and open only confirmed source or a read-only code preview. */
export interface ReviewCodeNavigation extends vscode.Disposable {
  markdown(thread: ReviewThread, message: ReviewMessage): vscode.MarkdownString;
  openAnchor(anchor: CodeAnchor): Promise<void>;
}

/** Connect review-owned code links to the real editor without accepting paths from Markdown. */
export async function createCodeNavigation(store: ReviewStore): Promise<ReviewCodeNavigation> {
  const references = new CodeReferences();
  const snippets = new Map<string, Snippet>();
  const languageIds = await vscode.languages.getLanguages();
  const registeredLanguages = new Map(languageIds.map((language) => [language.toLowerCase(), language]));

  /** Resolve a fence alias against installed language support without inventing a language. */
  function languageId(language: string): string {
    const normalized = language.toLowerCase();
    return registeredLanguages.get(languageAliases[normalized] ?? normalized) ?? 'plaintext';
  }

  /** Respect an open document's language override before falling back to its file extension. */
  function anchorLanguage(anchor: CodeAnchor): string {
    const uri = vscode.Uri.file(path.join(store.workspaceRoot, anchor.path)).toString();
    return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri)?.languageId
      ?? languageId(path.extname(anchor.path).slice(1));
  }

  /** Keep the discussion visible beside the existing project editor. */
  function editorColumn(uri: vscode.Uri, fromComposer: boolean): vscode.ViewColumn {
    const existing = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === uri.toString());
    if (existing?.viewColumn !== undefined) return existing.viewColumn;
    if (fromComposer) {
      return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.scheme === 'file')?.viewColumn
        ?? vscode.window.visibleTextEditors[0]?.viewColumn
        ?? vscode.ViewColumn.Beside;
    }
    return vscode.ViewColumn.Beside;
  }

  /** Preserve proposals verbatim when they cannot be located safely in the current file. */
  async function showSnippet(anchor: CodeAnchor, code: string, language: string, fromComposer: boolean): Promise<void> {
    const id = hashDocumentText(JSON.stringify([anchor.path, code]));
    const uri = vscode.Uri.from({
      scheme: snippetScheme,
      path: `/Codevorschau/Codevorschau – ${path.basename(anchor.path)}`,
      query: new URLSearchParams({ id }).toString(),
    });
    snippets.set(id, { code });
    let document = await vscode.workspace.openTextDocument(uri);
    const selectedLanguage = languageId(language);
    if (document.languageId !== selectedLanguage) document = await vscode.languages.setTextDocumentLanguage(document, selectedLanguage);
    await vscode.window.showTextDocument(document, { viewColumn: editorColumn(uri, fromComposer), preview: true });
    vscode.window.setStatusBarMessage('$(info) Codevorschau · Kein eindeutiger Treffer in der aktuellen Datei. Projektverweise sind hier eingeschränkt.', 7000);
  }

  /** Match current in-memory source by content so stale line numbers cannot redirect a click. */
  async function openCode(anchor: CodeAnchor, code: string, language: string, fromComposer = false): Promise<void> {
    if (!isWorkspaceRelativePath(anchor.path)) throw new Error('Der gespeicherte Codepfad gehört nicht zu diesem Arbeitsbereich.');
    const uri = vscode.Uri.file(path.join(store.workspaceRoot, anchor.path));
    let document: vscode.TextDocument | undefined;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      // Deleted files and proposals remain available as captured, read-only code.
    }
    const location = document === undefined ? undefined : locateCodeBlock(document.getText(), code, anchor);
    if (document !== undefined && location !== undefined) {
      const selection = document.validateRange(new vscode.Range(location.startLine - 1, 0, location.endLine - 1, Number.MAX_SAFE_INTEGER));
      await vscode.window.showTextDocument(document, { viewColumn: editorColumn(uri, fromComposer), selection, preview: true });
      return;
    }
    await showSnippet(anchor, code, language, fromComposer);
  }

  const provider = vscode.workspace.registerTextDocumentContentProvider(snippetScheme, {
    provideTextDocumentContent(uri) {
      const id = new URLSearchParams(uri.query).get('id');
      if (id === null || !/^[a-f\d]{64}$/u.test(id)) throw new Error('Der Verweis auf diese Codevorschau ist ungültig.');
      const snippet = snippets.get(id);
      if (snippet !== undefined) return snippet.code;
      for (const thread of store.threads) {
        const candidates = [thread.anchor.selectedText, ...thread.messages.flatMap((message) =>
          readCodeBlocks(withDetectedCodeBlocks(message.text, anchorLanguage(thread.anchor))).map((block) => block.code))];
        const code = candidates.find((candidate) => hashDocumentText(JSON.stringify([thread.anchor.path, candidate])) === id);
        if (code !== undefined) {
          snippets.set(id, { code });
          return code;
        }
      }
      throw new Error('Diese Codevorschau ist nicht mehr verfügbar. Öffne sie erneut aus dem Review oder dem gespeicherten Entwurf.');
    },
  });
  const command = vscode.commands.registerCommand(openCodeCommand, (handle: unknown) => {
    return (async () => {
      const reference = references.resolve(handle);
      const thread = reference === undefined ? undefined : store.threads.find((candidate) => candidate.id === reference.threadId);
      const message = thread?.messages.find((candidate) => candidate.id === reference?.messageId);
      if (reference === undefined || thread === undefined || message === undefined) {
        throw new Error('Dieser Code-Link ist nicht mehr gültig. Öffne die aktuelle Unterhaltung erneut.');
      }
      const language = anchorLanguage(thread.anchor);
      if (reference.blockIndex === undefined) {
        await openCode(thread.anchor, thread.anchor.selectedText, language);
        return;
      }
      const block = readCodeBlocks(withDetectedCodeBlocks(message.text, language), language)[reference.blockIndex];
      if (block === undefined || block.code.trim().length === 0) throw new Error('Dieser Codeblock wurde nicht gefunden.');
      await openCode(thread.anchor, block.code, block.language);
    })().catch((error: unknown) => {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Der Code konnte nicht geöffnet werden.');
    });
  });

  return {
    markdown(thread, message) {
      const body = new vscode.MarkdownString(references.render(thread, message, anchorLanguage(thread.anchor)));
      body.isTrusted = { enabledCommands: [openCodeCommand] };
      return body;
    },
    async openAnchor(anchor) {
      await openCode(anchor, anchor.selectedText, anchorLanguage(anchor), true);
    },
    dispose() {
      command.dispose();
      provider.dispose();
      references.dispose();
      snippets.clear();
    },
  };
}
