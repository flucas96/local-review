import { isDeepStrictEqual } from 'node:util';
import * as vscode from 'vscode';

const storageKey = 'localReview.appearance.v1';
const colorSetting = 'colorCustomizations';
const tokens = ['peekViewResult.background', 'editorCommentsWidget.replyInputBackground',
  'editorCommentsWidget.unresolvedBorder', 'editorCommentsWidget.resolvedBorder'] as const;
const palettes = {
  dark: ['#2B2F36', '#23262D', '#69717D', '#545C66'],
  light: ['#F0F3F7', '#FFFFFF', '#A3ADBA', '#B5BDC8'],
} as const;

interface SavedColor { readonly previous?: unknown; readonly applied: string }
interface SavedTheme { readonly existed: boolean; readonly colors: Record<string, SavedColor> }
interface SavedAppearance { readonly rootAbsent: boolean; readonly themes: Record<string, SavedTheme> }

/** Narrow configuration data without trusting persisted objects or theme names. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Read only our saved ownership metadata; never infer ownership from a matching default color. */
function savedAppearance(storage: vscode.Memento): SavedAppearance | undefined {
  const value = storage.get<unknown>(storageKey);
  if (value === undefined) return undefined;
  const saved = record(value);
  const themes = record(saved?.['themes']);
  if (saved?.['version'] !== 1 || typeof saved['rootAbsent'] !== 'boolean' || themes === undefined) {
    throw new Error('Die gespeicherte Farbsicherung konnte nicht gelesen werden. Deine Farben wurden nicht geändert.');
  }
  const validated: Record<string, SavedTheme> = {};
  for (const [theme, value] of Object.entries(themes)) {
    const entry = record(value);
    const colors = record(entry?.['colors']);
    if (entry === undefined || typeof entry['existed'] !== 'boolean' || colors === undefined) {
      throw new Error('Die gespeicherte Farbsicherung ist unvollständig. Deine Farben wurden nicht geändert.');
    }
    const validatedColors: Record<string, SavedColor> = {};
    for (const token of tokens) {
      const color = record(colors[token]);
      if (color === undefined || typeof color['applied'] !== 'string') {
        throw new Error('Die gespeicherte Farbsicherung ist unvollständig. Deine Farben wurden nicht geändert.');
      }
      validatedColors[token] = { previous: color['previous'], applied: color['applied'] };
    }
    validated[theme] = { existed: entry['existed'], colors: validatedColors };
  }
  return { rootAbsent: saved['rootAbsent'], themes: validated };
}

/** Offer explicit project-only contrast changes with ownership-aware undo. */
export function registerReviewAppearance(context: vscode.ExtensionContext): vscode.Disposable {
  let pending = Promise.resolve();
  const configuration = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('workbench');
  const workspaceColors = (): unknown => configuration().inspect<unknown>(colorSetting)?.workspaceValue;

  /** Serialize our own commands without changing settings when the extension loads. */
  function command(id: string, work: () => Promise<void>): vscode.Disposable {
    return vscode.commands.registerCommand(`localReview.${id}`, () => {
      pending = pending.then(work).catch((error: unknown) => {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Die Kommentarfarben konnten nicht geändert werden.');
      });
      return pending;
    });
  }

  const enhance = command('enhanceContrast', async () => {
    const kind = vscode.window.activeColorTheme.kind;
    if (kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight) {
      void vscode.window.showInformationMessage('Hoher Kontrast bleibt aktiv.');
      return;
    }
    const theme = configuration().get<unknown>('colorTheme');
    if (typeof theme !== 'string' || theme.length === 0) throw new Error('Das aktuelle Farbschema konnte nicht ermittelt werden.');
    const key = `[${theme}]`;
    const original = structuredClone(workspaceColors());
    const root = original === undefined ? {} : record(original);
    const block = root?.[key] === undefined ? {} : record(root[key]);
    if (root === undefined || block === undefined) throw new Error('Prüfe zuerst die Farbwerte in den Projekteinstellungen. Deine Farben wurden nicht geändert.');
    const originalBackup = structuredClone(context.workspaceState.get<unknown>(storageKey));
    const saved = savedAppearance(context.workspaceState) ?? { rootAbsent: original === undefined, themes: {} };
    const previous = saved.themes[key];
    const colors: Record<string, SavedColor> = {};
    const updated = { ...block };
    const palette = kind === vscode.ColorThemeKind.Light ? palettes.light : palettes.dark;
    tokens.forEach((token, index) => {
      const applied = palette[index];
      if (applied === undefined) return;
      const owned = previous?.colors[token];
      colors[token] = { previous: owned !== undefined && block[token] === owned.applied ? owned.previous : block[token], applied };
      updated[token] = applied;
    });
    const next: SavedAppearance = {
      rootAbsent: saved.rootAbsent,
      themes: { ...saved.themes, [key]: { existed: previous?.existed ?? Object.hasOwn(root, key), colors } },
    };
    await context.workspaceState.update(storageKey, { version: 1, ...next });
    if (!isDeepStrictEqual(workspaceColors(), original)) {
      await context.workspaceState.update(storageKey, originalBackup);
      throw new Error('Die Projektfarben wurden inzwischen geändert. Bitte erneut versuchen.');
    }
    await configuration().update(colorSetting, { ...root, [key]: updated }, vscode.ConfigurationTarget.Workspace);
    void vscode.window.showInformationMessage('Kommentarfenster hervorgehoben.');
  });

  const reset = command('resetContrast', async () => {
    const saved = savedAppearance(context.workspaceState);
    if (saved === undefined) return;
    const original = workspaceColors();
    const root = record(original);
    let changed = false;
    const updated = { ...root };
    for (const [theme, backup] of Object.entries(saved.themes)) {
      const block = record(root?.[theme]);
      if (block === undefined) continue;
      const restored = { ...block };
      for (const token of tokens) {
        const color = backup.colors[token];
        if (color === undefined || block[token] !== color.applied) continue;
        if (color.previous === undefined) delete restored[token];
        else restored[token] = color.previous;
        changed = true;
      }
      if (Object.keys(restored).length === 0 && !backup.existed) delete updated[theme];
      else updated[theme] = restored;
    }
    if (changed) {
      await configuration().update(colorSetting, saved.rootAbsent && Object.keys(updated).length === 0 ? undefined : updated,
        vscode.ConfigurationTarget.Workspace);
    }
    await context.workspaceState.update(storageKey, undefined);
    void vscode.window.showInformationMessage('Kommentarfarben wiederhergestellt.');
  });
  return { dispose(): void { enhance.dispose(); reset.dispose(); } };
}
