import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { ReviewBridge } from './contracts.js';
import { record } from './connection.js';
import { requireNodeRuntime, resolveExecutable } from './executables.js';

const reviewTerminalName = 'Claude · Local Review';

/** Quote a single argument for the POSIX shell used by Claude command hooks. */
export function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Quote terminal arguments without interpreting user-configured executable paths. */
function terminalCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(quotePosix).join(' ');
}

/** Write a private runtime file outside the reviewed source repository. */
async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (record(error)?.code !== 'ENOENT') throw error;
    });
  }
}

/** Reuse this project's managed terminal when VS Code reloads the extension host. */
function existingReviewTerminal(workspaceRoot: string, inactiveTerminals: WeakSet<vscode.Terminal>): vscode.Terminal | undefined {
  return vscode.window.terminals.findLast((candidate) => {
    const options = candidate.creationOptions;
    if (options.name !== reviewTerminalName || candidate.exitStatus !== undefined || inactiveTerminals.has(candidate)) return false;
    const cwd = 'cwd' in options ? options.cwd : undefined;
    const path = typeof cwd === 'string' ? cwd : cwd?.scheme === 'file' ? cwd.fsPath : undefined;
    return path !== undefined && resolve(path) === resolve(workspaceRoot);
  });
}

/** Generate session-scoped integration files without changing Claude user settings. */
export async function prepareConnection(
  context: vscode.ExtensionContext,
  bridge: ReviewBridge,
  storagePath: string,
  runtimeNodePath?: string,
): Promise<{ readonly mcpPath: string; readonly hooksPath: string; readonly transport: 'hooks' | 'channels' }> {
  await mkdir(storagePath, { recursive: true, mode: 0o700 });
  const configuration = vscode.workspace.getConfiguration('localReview');
  const nodePath = runtimeNodePath ?? configuration.get<string>('nodePath', 'node');
  const transport = configuration.get<string>('transport', 'hooks') === 'channels' ? 'channels' : 'hooks';
  const connectionPath = join(storagePath, 'connection.json');
  const mcpPath = join(storagePath, 'mcp.json');
  const hooksPath = join(storagePath, 'hooks.json');
  const channelPath = join(context.extensionPath, 'dist', 'channel.cjs');
  const waiterPath = join(context.extensionPath, 'dist', 'hook-waiter.cjs');
  await writePrivateJson(connectionPath, bridge.descriptor);
  await writePrivateJson(mcpPath, {
    mcpServers: {
      'local-review': {
        command: nodePath,
        args: [channelPath, '--connection', connectionPath, ...(transport === 'hooks' ? ['--no-push'] : [])],
      },
    },
  });
  const waiterCommand = [nodePath, waiterPath, '--connection', connectionPath].map(quotePosix).join(' ');
  const waiter = { type: 'command', command: waiterCommand, asyncRewake: true, timeout: 86_400, statusMessage: 'Wartet auf Review-Feedback' };
  await writePrivateJson(hooksPath, {
    hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].map(event => [event, [{ hooks: [waiter] }]])),
  });
  return { mcpPath, hooksPath, transport };
}

/** Select a conversation without guessing which recent session created the code. */
async function selectConversation(): Promise<boolean | undefined> {
  const selection = await vscode.window.showQuickPick([
    {
      label: 'Unterhaltung auswählen', description: 'Bestehenden Kontext behalten', resume: true,
      detail: 'Sitzung läuft noch? Erst /exit, dann hier auswählen.',
    },
    { label: 'Neue Unterhaltung', description: 'Mit leerem Gespräch beginnen', resume: false },
  ], { title: 'Claude Code verbinden', placeHolder: 'Welche Unterhaltung soll deine Kommentare erhalten?' });
  return selection?.resume;
}

/** Prepare the same private review connection for either terminal location. */
async function prepareClaudeCommand(
  context: vscode.ExtensionContext, bridge: ReviewBridge, storagePath: string, resume: boolean,
): Promise<string> {
  const configuration = vscode.workspace.getConfiguration('localReview');
  const [executable, nodePath] = await Promise.all([
    resolveExecutable(configuration.get<string>('claudePath', 'claude'), bridge.descriptor.workspaceRoot),
    resolveExecutable(configuration.get<string>('nodePath', 'node'), bridge.descriptor.workspaceRoot),
  ]);
  await requireNodeRuntime(nodePath);
  const prepared = await prepareConnection(context, bridge, storagePath, nodePath);
  const args = ['--mcp-config', prepared.mcpPath];
  if (prepared.transport === 'hooks') args.push('--settings', prepared.hooksPath);
  else args.push('--dangerously-load-development-channels', 'server:local-review');
  if (resume) args.push('--resume');
  return terminalCommand(executable, args);
}

/** Connect a chosen or new conversation, or copy its command for a separate terminal. */
export function registerClaudeLauncher(
  context: vscode.ExtensionContext,
  bridge: ReviewBridge,
  storagePath: string,
): vscode.Disposable {
  const inactiveTerminals = new WeakSet<vscode.Terminal>();
  let terminal: vscode.Terminal | undefined = existingReviewTerminal(bridge.descriptor.workspaceRoot, inactiveTerminals);
  let launching = false;
  const closed = vscode.window.onDidCloseTerminal(closedTerminal => {
    inactiveTerminals.add(closedTerminal);
    if (terminal === closedTerminal) terminal = undefined;
  });
  const ended = vscode.window.onDidEndTerminalShellExecution(event => {
    inactiveTerminals.add(event.terminal);
    if (event.terminal === terminal) terminal = undefined;
  });
  const isLive = (candidate: vscode.Terminal | undefined): candidate is vscode.Terminal => candidate !== undefined
    && !inactiveTerminals.has(candidate) && candidate.exitStatus === undefined && vscode.window.terminals.includes(candidate);
  const receiverConflict = (ownedTerminal: vscode.Terminal | undefined): boolean => {
    if (bridge.state.deliveryReady !== true || isLive(ownedTerminal)) return false;
    void vscode.window.showInformationMessage('Die Review-Verbindung ist noch aktiv oder wird getrennt. Falls Claude noch läuft: /exit. Der Status aktualisiert sich innerhalb von 45 Sekunden.');
    return true;
  };
  const register = (id: string, action: () => Promise<void>): vscode.Disposable => vscode.commands.registerCommand(id, async () => {
    if (launching) return;
    launching = true;
    try {
      if (process.platform === 'win32') {
        throw new Error('Die automatische Claude-Verbindung dieser ersten Version unterstützt macOS und Linux. Windows folgt nach einer eigenen Prüfung.');
      }
      await action();
    } catch (error: unknown) {
      void vscode.window.showErrorMessage(`Local Review: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      launching = false;
    }
  });
  const command = register('localReview.startClaude', async () => {
    let replaceTerminal: vscode.Terminal | undefined;
    if (!isLive(terminal)) terminal = existingReviewTerminal(bridge.descriptor.workspaceRoot, inactiveTerminals);
    const currentTerminal = terminal;
    if (receiverConflict(currentTerminal)) return;
    if (currentTerminal !== undefined) {
      const show = { label: 'Terminal anzeigen', description: 'Die bestehende Unterhaltung öffnen', restart: false };
      const restart = {
        label: bridge.state.deliveryReady === true ? 'Unterhaltung wechseln' : 'Verbindung neu starten',
        description: 'Das bisherige Review-Terminal schließen',
        detail: 'Danach wählst du eine bestehende Unterhaltung oder startest eine neue.', restart: true,
      };
      const action = await vscode.window.showQuickPick(bridge.state.deliveryReady === true ? [show, restart] : [restart, show], {
        title: bridge.state.deliveryReady === true ? 'Claude Code ist verbunden' : 'Automatische Zustellung wiederherstellen',
      });
      if (action === undefined || receiverConflict(currentTerminal)) return;
      if (!action.restart) {
        if (isLive(currentTerminal)) currentTerminal.show();
        return;
      }
      replaceTerminal = currentTerminal;
    }
    const resume = await selectConversation();
    if (resume === undefined || receiverConflict(replaceTerminal)) return;
    const launch = await prepareClaudeCommand(context, bridge, storagePath, resume);
    if (receiverConflict(replaceTerminal)) return;
    if (isLive(replaceTerminal)) {
      inactiveTerminals.add(replaceTerminal);
      replaceTerminal.dispose();
    }
    terminal = vscode.window.createTerminal({ name: reviewTerminalName, cwd: bridge.descriptor.workspaceRoot });
    terminal.show();
    terminal.sendText(launch);
  });
  const copy = register('localReview.copyClaudeCommand', async () => {
    const resume = await selectConversation();
    if (resume === undefined) return;
    const launch = await prepareClaudeCommand(context, bridge, storagePath, resume);
    await vscode.env.clipboard.writeText(`cd ${quotePosix(bridge.descriptor.workspaceRoot)} && ${launch}`);
    void vscode.window.showInformationMessage('Befehl kopiert. Im Shell-Prompt ausführen; laufendes Claude vorher mit /exit beenden.');
  });
  return vscode.Disposable.from(command, copy, closed, ended);
}
