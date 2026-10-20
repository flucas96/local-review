import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ReviewBridge } from './contracts.js';
import { requireNodeRuntime, resolveExecutable } from './executables.js';

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
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
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
  const waiter = { type: 'command', command: waiterCommand, asyncRewake: true, timeout: 86_400 };
  await writePrivateJson(hooksPath, {
    hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].map(event => [event, [{ hooks: [waiter] }]])),
  });
  return { mcpPath, hooksPath, transport };
}

/** Offer an explicit session start or resume inside VS Code's integrated terminal. */
export function registerClaudeLauncher(
  context: vscode.ExtensionContext,
  bridge: ReviewBridge,
  storagePath: string,
): vscode.Disposable {
  let terminal: vscode.Terminal | undefined;
  let sessionEnded = false;
  let launching = false;
  const closed = vscode.window.onDidCloseTerminal(closedTerminal => {
    if (terminal === closedTerminal) terminal = undefined;
  });
  const ended = vscode.window.onDidEndTerminalShellExecution(event => {
    if (event.terminal === terminal) sessionEnded = true;
  });
  const command = vscode.commands.registerCommand('localReview.startClaude', async () => {
    if (launching) return;
    launching = true;
    let replaceTerminal: vscode.Terminal | undefined;
    try {
      if (process.platform === 'win32') {
        throw new Error('Die automatische Claude-Verbindung dieser ersten Version unterstützt macOS und Linux. Windows folgt nach einer eigenen Prüfung.');
      }
      if (terminal !== undefined) {
        if (sessionEnded) {
          terminal = undefined;
        } else {
          const show = { label: 'Terminal anzeigen', description: 'Die bestehende Unterhaltung öffnen', restart: false };
          const restart = { label: 'Verbindung neu starten', description: 'Die laufende Review-Sitzung beenden und neu verbinden', restart: true };
          const action = await vscode.window.showQuickPick(bridge.state.connected ? [show, restart] : [restart, show], {
            title: bridge.state.connected ? 'Claude Code ist verbunden' : 'Claude-Verbindung wiederherstellen',
          });
          if (action === undefined) return;
          if (!action.restart) {
            terminal.show();
            return;
          }
          replaceTerminal = terminal;
        }
      }
      const selection = await vscode.window.showQuickPick([
        { label: 'Letzte Unterhaltung fortsetzen', description: 'Mit automatischem Review-Feedback', resume: true },
        { label: 'Neue Review-Unterhaltung', description: 'Mit automatischem Review-Feedback', resume: false },
      ], { title: 'Claude Code verbinden', placeHolder: 'Welche Unterhaltung soll deine Kommentare erhalten?' });
      if (selection === undefined) return;
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
      if (selection.resume) args.push('--continue');
      replaceTerminal?.dispose();
      terminal = vscode.window.createTerminal({ name: 'Claude · Local Review', cwd: bridge.descriptor.workspaceRoot });
      sessionEnded = false;
      terminal.show();
      terminal.sendText(terminalCommand(executable, args));
    } catch (error: unknown) {
      await vscode.window.showErrorMessage(`Local Review: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      launching = false;
    }
  });
  return vscode.Disposable.from(command, closed, ended);
}
