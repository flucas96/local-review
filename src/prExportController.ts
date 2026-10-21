import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ReviewStore, ReviewThread } from './contracts.js';
import { GitHubReviewClient, type GitHubHandoffTarget } from './github.js';
import { createPrExportDraft, maximumPrExportLength, type PrExportDraft } from './prExport.js';
import { webviewFontStyles } from './webviewStyles.js';

/** Register a human-reviewed handoff without publishing ordinary local comments automatically. */
export function registerPrExport(context: vscode.ExtensionContext, store: ReviewStore): vscode.Disposable {
  let activePanel: vscode.WebviewPanel | undefined;
  let disposed = false;
  let publicationInFlight: Promise<void> | undefined;

  /** Reuse an existing editable draft instead of discarding the human's changes. */
  function revealExistingPanel(): boolean {
    if (activePanel === undefined) return false;
    activePanel.reveal();
    return true;
  }

  const command = vscode.commands.registerCommand('localReview.exportToPr', async () => {
    if (disposed || revealExistingPanel()) return;
    const pendingPublication = publicationInFlight;
    if (pendingPublication !== undefined) {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'Vorherige PR-Übergabe wird noch veröffentlicht',
      }, () => pendingPublication);
      if (disposed || revealExistingPanel()) return;
    }
    const sourceThreads = [...store.threads];
    const sourceEvents = [...store.events];
    const capturedAt = new Date().toISOString();
    const candidates = sourceThreads.map((thread) => ({
      thread, draft: createPrExportDraft([thread], sourceEvents, capturedAt),
    }));
    const eligible = candidates.filter(({ draft }) => draft.summaryCount + draft.questionCount > 0);
    if (eligible.length === 0) {
      void vscode.window.showInformationMessage(candidates.some(({ draft }) => draft.pendingSummaryCount > 0)
        ? 'Die angeforderte Zusammenfassung ist noch nicht beantwortet. Warte auf Claudes Antwort oder öffne eine Frage, bevor du sie an den PR übergibst.'
        : 'Es gibt keine Zusammenfassungen oder Fragen in offenen Review-Unterhaltungen zum Übergeben. /r fasst eine bestehende Unterhaltung lokal zusammen.');
      return;
    }
    try {
      const items: (vscode.QuickPickItem & { readonly thread: ReviewThread })[] = eligible.map(({ thread, draft }) => ({
        thread,
        label: `${thread.anchor.path}:${thread.anchor.startLine}${thread.anchor.endLine === thread.anchor.startLine ? '' : `–${thread.anchor.endLine}`}`,
        description: [thread.resolved ? 'Erledigt (optional)' : '', draft.summaryCount ? '/r Zusammenfassung' : '', draft.questionCount ? 'offene Frage' : ''].filter(Boolean).join(' · '),
        detail: thread.messages[0]?.text.replaceAll(/\s+/gu, ' ').slice(0, 140) ?? 'Offene Unterhaltung',
        picked: !thread.resolved,
      }));
      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true, ignoreFocusOut: true, title: 'Welche Unterhaltungen möchtest du an den PR übergeben?',
        placeHolder: 'Offene Unterhaltungen sind ausgewählt. Erledigte Zusammenfassungen kannst du optional ergänzen.',
      });
      if (selected === undefined || selected.length === 0 || disposed || revealExistingPanel()) return;
      const draft = createPrExportDraft(selected.map((item) => item.thread), sourceEvents, capturedAt);
      const client = await GitHubReviewClient.connect(store.workspaceRoot);
      const target = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'GitHub-PR für diesen Branch suchen',
      }, () => client.readTarget());
      if (disposed || revealExistingPanel()) return;
      const panel = vscode.window.createWebviewPanel('localReview.prExport', `PR #${target.pullRequest.number} · Review übergeben`,
        vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] });
      activePanel = panel;
      panel.webview.html = previewHtml(draft, target);
      let currentTarget = target;
      let panelDisposed = false;

      /** Closing the preview must not turn a completed remote write into an unhandled UI error. */
      function post(message: Readonly<Record<string, unknown>>): void {
        if (panelDisposed) return;
        void panel.webview.postMessage(message).then(undefined, () => undefined);
      }

      const listener = panel.webview.onDidReceiveMessage(async (value: unknown) => {
        if (typeof value !== 'object' || value === null || !('action' in value)) return;
        if (value.action === 'openPr') {
          try {
            await vscode.env.openExternal(vscode.Uri.parse(currentTarget.comment?.url ?? currentTarget.pullRequest.url));
          } catch (error: unknown) {
            post({ kind: 'error', message: describeError(error) });
          }
          return;
        }
        if (!('body' in value) || typeof value.body !== 'string') return;
        const body = value.body;
        if (value.action === 'markdown') {
          try {
            const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: body });
            await vscode.commands.executeCommand('markdown.showPreviewToSide', document.uri);
          } catch (error: unknown) {
            post({ kind: 'error', message: describeError(error) });
          }
          return;
        }
        if (value.action !== 'publish' || publicationInFlight !== undefined) return;
        post({ kind: 'busy' });
        publicationInFlight = (async (): Promise<void> => {
          try {
            const result = await client.publish(currentTarget, body);
            currentTarget = result.target;
            post({ kind: 'published', message: result.changed
              ? 'Im GitHub-PR veröffentlicht. Deine lokalen Unterhaltungen behalten ihren Status.'
              : 'Dieser Stand ist bereits im PR. Es wurde kein weiterer Kommentar angelegt.' });
          } catch (error: unknown) {
            post({ kind: 'error', message: describeError(error) });
          } finally {
            publicationInFlight = undefined;
            post({ kind: 'idle' });
          }
        })();
        await publicationInFlight;
      });
      panel.onDidDispose(() => {
        panelDisposed = true;
        listener.dispose();
        if (activePanel === panel) activePanel = undefined;
      });
    } catch (error: unknown) {
      void vscode.window.showErrorMessage(describeError(error));
    }
  });
  return vscode.Disposable.from(command, { dispose: () => { disposed = true; activePanel?.dispose(); } });
}

/** Present the exact editable outgoing Markdown before any external write is allowed. */
function previewHtml(draft: PrExportDraft, target: GitHubHandoffTarget): string {
  const nonce = randomUUID().replaceAll('-', '');
  const action = target.comment === undefined ? 'Im PR veröffentlichen' : 'Im PR aktualisieren';
  const summaryLabel = `${draft.summaryCount} ${draft.summaryCount === 1 ? 'Zusammenfassung' : 'Zusammenfassungen'}`;
  const questionLabel = `${draft.questionCount} ${draft.questionCount === 1 ? 'offene Frage' : 'offene Fragen'}`;
  return `<!doctype html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Review an GitHub übergeben</title>
<style nonce="${nonce}">
${webviewFontStyles}
body{margin:0;padding:28px 30px 20px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--review-font-ui);font-size:var(--vscode-font-size);line-height:1.5}main{max-width:1020px;margin:auto}h1{font-size:24px;font-weight:600;margin:0 0 6px}.muted{color:var(--vscode-descriptionForeground)}.target{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:14px 0 18px;padding:12px 16px;border:1px solid var(--vscode-widget-border);border-radius:6px}.target strong{flex:1;min-width:180px}.badges{display:flex;gap:8px;margin:12px 0}.badge{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);padding:3px 9px;border-radius:12px;font-size:12px}label{display:block;font-weight:600;margin:18px 0 8px}textarea{box-sizing:border-box;width:100%;height:53vh;min-height:270px;resize:vertical;border:1px solid var(--vscode-input-border,var(--vscode-widget-border));border-radius:5px;padding:14px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);font:13px/1.55 var(--review-font-code);tab-size:2}textarea:focus,button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:10px 0 14px}.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}button{border:1px solid transparent;border-radius:3px;padding:7px 12px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);font:inherit;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}button:disabled{opacity:.55;cursor:default}.status{min-height:22px;white-space:pre-wrap;margin:12px 0}.error{color:var(--vscode-errorForeground)}.success{color:var(--vscode-testing-iconPassed,var(--vscode-foreground))}.footnote{font-size:12px;margin:8px 0 0}.counter.over{color:var(--vscode-errorForeground)}
</style></head><body><main>
<h1>Review an GitHub übergeben</h1>
<p class="muted">Prüfe den Entwurf und passe ihn an. Erst die Schaltfläche unten schreibt in den PR.</p>
<div class="target"><strong>#${target.pullRequest.number} · ${escapeHtml(target.pullRequest.title)}</strong><span class="muted">${escapeHtml(`${target.pullRequest.owner}/${target.pullRequest.repository} · ${target.pullRequest.branch}`)}</span><button class="secondary" id="open">PR öffnen</button></div>
<div class="badges"><span class="badge">${summaryLabel}</span><span class="badge">${questionLabel}</span></div>
<p class="muted">${target.comment === undefined ? 'Ein gemeinsamer Kommentar hält die Übergabe im PR zusammen.' : 'Der vorhandene Local-Review-Kommentar wird aktualisiert. Eigene Ergänzungen außerhalb seines verwalteten Abschnitts bleiben erhalten.'} /r bleibt eine lokale Aktion.</p>
<label for="body">Inhalt der Übergabe · Markdown</label>
<textarea id="body" spellcheck="false">${escapeHtml(draft.markdown)}</textarea>
<div class="toolbar"><button class="secondary" id="markdown">Markdown-Vorschau</button><span id="counter" class="muted counter"></span></div>
<div class="actions"><button id="publish">${action}</button><span class="muted">${escapeHtml(target.viewerLogin)} · GitHub-Kommentar</span></div>
<p id="status" class="status" role="status" aria-live="polite"></p>
<p class="muted footnote">Dieser Entwurf ist eine Momentaufnahme. Für neue lokale Antworten schließe diese Vorschau und öffne die Übergabe erneut. Lokale Zustellung und Erledigt-Status bleiben erhalten. Strg/⌘ + Enter veröffentlicht den sichtbaren Entwurf.</p>
</main><script nonce="${nonce}">
const api=acquireVsCodeApi();
const body=document.getElementById('body');
const publish=document.getElementById('publish');
const counter=document.getElementById('counter');
const status=document.getElementById('status');
let busy=false;
function update(){const length=body.value.trim().length;counter.textContent=length.toLocaleString('de-DE')+' / ${maximumPrExportLength.toLocaleString('de-DE')} Zeichen';counter.classList.toggle('over',length>${maximumPrExportLength});publish.disabled=busy||length===0||length>${maximumPrExportLength};}
body.addEventListener('input',update);
publish.addEventListener('click',()=>{if(!publish.disabled)api.postMessage({action:'publish',body:body.value});});
document.getElementById('markdown').addEventListener('click',()=>api.postMessage({action:'markdown',body:body.value}));
document.getElementById('open').addEventListener('click',()=>api.postMessage({action:'openPr'}));
body.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();publish.click();}});
window.addEventListener('message',event=>{const message=event.data;if(message.kind==='busy'){busy=true;body.readOnly=true;status.className='status muted';status.textContent='PR prüfen und Übergabe veröffentlichen …';}else if(message.kind==='idle'){busy=false;body.readOnly=false;}else if(message.kind==='published'){publish.textContent='Im PR aktualisieren';document.getElementById('open').textContent='Kommentar öffnen';status.className='status success';status.textContent=message.message;}else if(message.kind==='error'){status.className='status error';status.textContent=message.message;}update();});
update();
</script></body></html>`;
}

/** Escape untrusted review content before placing it in a webview document. */
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** Keep a failed preview editable while exposing a useful error to the human. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Die PR-Übergabe konnte nicht vorbereitet werden. Dein lokales Review bleibt gespeichert.';
}
