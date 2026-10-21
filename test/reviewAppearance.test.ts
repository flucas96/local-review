import type * as vscode from 'vscode';
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { registerReviewAppearance } from '../src/reviewAppearance.js';
import { ColorThemeKind, commands, ConfigurationTarget, extensionContext, FakeMemento,
  resetFakeEditor, resetFakeWindow, settle, window, workspace } from './fakes/vscode.js';

const setting = 'workbench.colorCustomizations';
const themeSetting = 'workbench.colorTheme';
const registrations: vscode.Disposable[] = [];
const dark = {
  'peekViewResult.background': '#2B2F36',
  'editorCommentsWidget.replyInputBackground': '#23262D',
  'editorCommentsWidget.unresolvedBorder': '#69717D',
  'editorCommentsWidget.resolvedBorder': '#545C66',
};

afterEach(() => {
  for (const registration of registrations.splice(0)) registration.dispose();
  resetFakeEditor();
  resetFakeWindow();
});

/** Register actual commands against isolated project settings and durable extension state. */
function register(storage = new FakeMemento()): FakeMemento {
  workspace.configurationValues.set(themeSetting, 'Dark Modern');
  registrations.push(registerReviewAppearance(extensionContext(storage)));
  return storage;
}

/** Exercise the command's real completion boundary, including backup and settings writes. */
async function enhance(): Promise<void> { await commands.executeCommand('localReview.enhanceContrast'); }
async function reset(): Promise<void> { await commands.executeCommand('localReview.resetContrast'); }

test('registering appearance commands changes no settings or extension state', () => {
  const storage = register();
  assert.equal(workspace.configurationWrites.length, 0);
  assert.deepEqual(storage.keys(), []);
  assert.equal(window.information.length, 0);
});

test('enhance creates only a project theme override and never copies global colors', async () => {
  const global = { 'editor.background': '#121212', '[Dark Modern]': { 'peekViewResult.background': '#151515' } };
  workspace.configurationValues.set(setting, global);
  register();
  await enhance();
  assert.deepEqual(workspace.configurationWorkspaceValues.get(setting), { '[Dark Modern]': dark });
  assert.deepEqual(workspace.configurationValues.get(setting), global);
  assert.equal(workspace.configurationWrites[0]?.target, ConfigurationTarget.Workspace);
  assert.equal(window.information[0], 'Kommentarfenster hervorgehoben.');
  await reset();
  assert.equal(workspace.configurationWorkspaceValues.has(setting), false);
  assert.deepEqual(workspace.configurationValues.get(setting), global);
});

test('enhance preserves unrelated workspace values and reset restores exact prior overrides', async () => {
  const original = {
    'editor.foreground': '#EEEEEE',
    '[Other Theme]': { 'peekViewResult.background': '#010101' },
    '[Dark Modern]': { 'editor.background': '#171717', 'peekViewResult.background': '#181818', 'editorCommentsWidget.resolvedBorder': null },
  };
  workspace.configurationWorkspaceValues.set(setting, original);
  register();
  await enhance();
  assert.deepEqual(workspace.configurationWorkspaceValues.get(setting), {
    ...original, '[Dark Modern]': { ...original['[Dark Modern]'], ...dark },
  });
  await reset();
  assert.deepEqual(workspace.configurationWorkspaceValues.get(setting), original);
});

test('reset preserves manual changes to owned colors and unrelated new keys', async () => {
  register();
  await enhance();
  const manual = '#AABBCC';
  workspace.configurationWorkspaceValues.set(setting, {
    '[Dark Modern]': { ...dark, 'peekViewResult.background': manual, 'editor.lineHighlightBackground': '#222222' },
    'editor.foreground': '#EFEFEF',
  });
  await reset();
  assert.deepEqual(workspace.configurationWorkspaceValues.get(setting), {
    '[Dark Modern]': { 'peekViewResult.background': manual, 'editor.lineHighlightBackground': '#222222' },
    'editor.foreground': '#EFEFEF',
  });
});

test('repeated enhance retains originals while explicit reapply can save a newer manual preference', async () => {
  const original = { '[Dark Modern]': { 'peekViewResult.background': '#111111' } };
  workspace.configurationWorkspaceValues.set(setting, original);
  register();
  await enhance();
  await enhance();
  await reset();
  assert.deepEqual(workspace.configurationWorkspaceValues.get(setting), original);

  await enhance();
  workspace.configurationWorkspaceValues.set(setting, { '[Dark Modern]': { ...dark, 'peekViewResult.background': '#AABBCC' } });
  await enhance();
  await reset();
  assert.deepEqual(workspace.configurationWorkspaceValues.get(setting), { '[Dark Modern]': { 'peekViewResult.background': '#AABBCC' } });
});

test('light and dark themes are isolated and reset restores all enhanced themes', async () => {
  register();
  await enhance();
  workspace.configurationValues.set(themeSetting, 'Light Modern');
  window.activeColorTheme.kind = ColorThemeKind.Light;
  await enhance();
  assert.deepEqual(workspace.configurationWorkspaceValues.get(setting), {
    '[Dark Modern]': dark,
    '[Light Modern]': {
      'peekViewResult.background': '#F0F3F7', 'editorCommentsWidget.replyInputBackground': '#FFFFFF',
      'editorCommentsWidget.unresolvedBorder': '#A3ADBA', 'editorCommentsWidget.resolvedBorder': '#B5BDC8',
    },
  });
  await reset();
  assert.equal(workspace.configurationWorkspaceValues.has(setting), false);
});

test('both high contrast variants keep native colors and produce zero writes', async () => {
  const storage = register();
  for (const kind of [ColorThemeKind.HighContrast, ColorThemeKind.HighContrastLight]) {
    window.activeColorTheme.kind = kind;
    await enhance();
  }
  assert.deepEqual(storage.keys(), []);
  assert.equal(workspace.configurationWrites.length, 0);
  assert.equal(window.information.length, 2);
});

test('reset survives extension reload and preserves a preexisting empty customization block', async () => {
  const original = { '[Dark Modern]': {} };
  workspace.configurationWorkspaceValues.set(setting, original);
  const storage = register();
  await enhance();
  registrations.pop()?.dispose();
  register(storage);
  await reset();
  assert.deepEqual(workspace.configurationWorkspaceValues.get(setting), original);
});

test('a replaced theme block is a manual override and reset leaves it untouched', async () => {
  register();
  await enhance();
  const manual = { '[Dark Modern]': 'manually replaced', 'editor.background': '#111111' };
  workspace.configurationWorkspaceValues.set(setting, manual);
  const writes = workspace.configurationWrites.length;
  await reset();
  assert.deepEqual(workspace.configurationWorkspaceValues.get(setting), manual);
  assert.equal(workspace.configurationWrites.length, writes);
});

test('invalid project data is not overwritten', async () => {
  register();
  for (const invalid of ['broken', { '[Dark Modern]': 'broken' }]) {
    workspace.configurationWorkspaceValues.set(setting, invalid);
    await enhance();
    assert.deepEqual(workspace.configurationWorkspaceValues.get(setting), invalid);
  }
  assert.equal(workspace.configurationWrites.length, 0);
  assert.equal(window.errors.length, 2);
});

test('a failed backup prevents settings changes and a failed settings write remains safely recoverable', async () => {
  const storage = new FakeMemento();
  const update = storage.update.bind(storage);
  storage.update = async (): Promise<void> => { throw new Error('Storage unavailable'); };
  register(storage);
  await enhance();
  assert.equal(workspace.configurationWrites.length, 0);
  storage.update = update;
  workspace.beforeConfigurationUpdate = async (): Promise<void> => { throw new Error('Settings unavailable'); };
  await enhance();
  assert.equal(workspace.configurationWorkspaceValues.has(setting), false);
  workspace.beforeConfigurationUpdate = undefined;
  await reset();
  assert.equal(workspace.configurationWorkspaceValues.has(setting), false);
  assert.equal(window.errors.length, 2);
});

test('a project color edit during backup persistence aborts enhancement without overwriting settings', async () => {
  const storage = new FakeMemento();
  const update = storage.update.bind(storage);
  let release = (): void => {};
  const pause = new Promise<void>((resolve) => { release = resolve; });
  storage.update = async (key: string, value: unknown): Promise<void> => {
    await pause;
    await update(key, value);
  };
  const original = { '[Dark Modern]': { 'peekViewResult.background': '#101010' } };
  workspace.configurationWorkspaceValues.set(setting, original);
  register(storage);
  const applying = enhance();
  await settle();
  const edited = { '[Dark Modern]': { 'peekViewResult.background': dark['peekViewResult.background'] }, 'editor.foreground': '#AABBCC' };
  workspace.configurationWorkspaceValues.set(setting, edited);
  release();
  await applying;
  assert.deepEqual(workspace.configurationWorkspaceValues.get(setting), edited);
  assert.equal(workspace.configurationWrites.length, 0);
  assert.equal(window.errors[0], 'Die Projektfarben wurden inzwischen geändert. Bitte erneut versuchen.');
  assert.equal(window.information.length, 0);

  await reset();
  assert.deepEqual(workspace.configurationWorkspaceValues.get(setting), edited);
  assert.equal(workspace.configurationWrites.length, 0);
  await enhance();
  await reset();
  assert.deepEqual(workspace.configurationWorkspaceValues.get(setting), edited);
});

test('an aborted enhancement retains an earlier legitimate backup while leaving the newly edited theme alone', async () => {
  const storage = register();
  await enhance();
  workspace.configurationValues.set(themeSetting, 'Light Modern');
  window.activeColorTheme.kind = ColorThemeKind.Light;
  const update = storage.update.bind(storage);
  let release = (): void => {};
  const pause = new Promise<void>((resolve) => { release = resolve; });
  storage.update = async (key: string, value: unknown): Promise<void> => {
    await pause;
    await update(key, value);
  };
  const applying = enhance();
  await settle();
  const manual = { 'peekViewResult.background': '#F0F3F7' };
  workspace.configurationWorkspaceValues.set(setting, { '[Dark Modern]': dark, '[Light Modern]': manual });
  release();
  await applying;
  assert.equal(workspace.configurationWrites.length, 1);
  await reset();
  assert.deepEqual(workspace.configurationWorkspaceValues.get(setting), { '[Light Modern]': manual });
});

test('rapid enhance and reset commands finish in order rather than reviving a late appearance update', async () => {
  register();
  let release = (): void => {};
  const pause = new Promise<void>((resolve) => { release = resolve; });
  workspace.beforeConfigurationUpdate = async (): Promise<void> => { await pause; };
  const applying = enhance();
  await settle();
  const resetting = reset();
  assert.equal(workspace.configurationWrites.length, 0);
  release();
  await Promise.all([applying, resetting]);
  assert.equal(workspace.configurationWorkspaceValues.has(setting), false);
  assert.equal(workspace.configurationWrites.length, 2);
});
