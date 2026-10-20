import { execFile } from 'node:child_process';
import { resolveExecutable } from './executables.js';
import { prExportEnd, prExportStart, readManagedPrContent, replaceManagedPrContent } from './prExport.js';

/** Open PR selected by GitHub CLI from the current workspace branch. */
export interface GitHubPullRequest {
  readonly host: string;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly branch: string;
}

/** Managed PR conversation comment belonging to the authenticated GitHub user. */
export interface GitHubHandoffComment {
  readonly id: number;
  readonly body: string;
  readonly url: string;
}

/** Remote state captured when the human opens the handoff preview. */
export interface GitHubHandoffTarget {
  readonly pullRequest: GitHubPullRequest;
  readonly viewerLogin: string;
  readonly comment?: GitHubHandoffComment;
}

/** Successful publication and the resulting target for subsequent updates. */
export interface GitHubHandoffResult {
  readonly target: GitHubHandoffTarget;
  readonly comment: GitHubHandoffComment;
  readonly changed: boolean;
}

/** Use the user's existing GitHub CLI login without collecting account credentials. */
export class GitHubReviewClient {
  private constructor(private readonly executable: string, private readonly workspaceRoot: string) {}

  /** Locate GitHub CLI even when a desktop editor has a minimal executable search path. */
  static async connect(workspaceRoot: string): Promise<GitHubReviewClient> {
    for (const executable of ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
      try {
        return new GitHubReviewClient(await resolveExecutable(executable, workspaceRoot), workspaceRoot);
      } catch {
        // A standard installation path may still provide GitHub CLI.
      }
    }
    throw new Error('GitHub CLI wurde nicht gefunden. Installiere gh über cli.github.com und melde dich einmal mit „gh auth login“ an.');
  }

  /** Detect one open PR and the current user's existing managed handoff comment. */
  async readTarget(): Promise<GitHubHandoffTarget> {
    const pullRequest = parsePullRequest(await this.#json(['pr', 'view', '--json', 'number,url,title,state,headRefName']));
    const user = object(await this.#api(pullRequest.host, ['user']));
    const viewerLogin = text(user['login'], 'GitHub-Konto');
    const pages = await this.#api(pullRequest.host, [
      '--paginate', '--slurp', `repos/${pullRequest.owner}/${pullRequest.repository}/issues/${pullRequest.number}/comments?per_page=100`,
    ]);
    if (!Array.isArray(pages)) throw new Error('GitHub hat keine gültige Kommentarliste geliefert.');
    const matches: GitHubHandoffComment[] = [];
    for (const page of pages as readonly unknown[]) {
      if (!Array.isArray(page)) throw new Error('GitHub hat eine unvollständige Kommentarliste geliefert.');
      for (const value of page as readonly unknown[]) {
        const record = object(value);
        const author = optionalObject(record['user']);
        if (typeof author?.['login'] !== 'string' || author['login'].toLowerCase() !== viewerLogin.toLowerCase()) continue;
        const body = text(record['body'], 'Kommentartext', true);
        if (!body.includes(prExportStart) && !body.includes(prExportEnd)) continue;
        readManagedPrContent(body);
        matches.push(parseComment(record));
      }
    }
    if (matches.length > 1) {
      throw new Error('Dieser PR enthält mehrere Local-Review-Übergaben von deinem Konto. Kläre die doppelten Kommentare auf GitHub, bevor du aktualisierst.');
    }
    const comment = matches[0];
    return comment === undefined ? { pullRequest, viewerLogin } : { pullRequest, viewerLogin, comment };
  }

  /** Reconcile retries and update only this user's exact managed comment after an explicit publish action. */
  async publish(expected: GitHubHandoffTarget, markdown: string): Promise<GitHubHandoffResult> {
    replaceManagedPrContent(undefined, markdown);
    const current = await this.readTarget();
    if (current.pullRequest.url !== expected.pullRequest.url || current.pullRequest.branch !== expected.pullRequest.branch) {
      throw new Error('Der aktive Branch oder PR hat sich geändert. Schließe die Vorschau und erstelle eine neue Übergabe.');
    }
    if (current.viewerLogin.toLowerCase() !== expected.viewerLogin.toLowerCase()) {
      throw new Error('Das aktive GitHub-Konto hat sich geändert. Erstelle die Vorschau mit dem gewünschten Konto erneut.');
    }
    const existing = current.comment;
    const currentContent = existing === undefined ? undefined : readManagedPrContent(existing.body);
    const wanted = markdown.trim();
    if (existing !== undefined && currentContent?.content === wanted) {
      return { target: current, comment: existing, changed: false };
    }
    const expectedContent = expected.comment === undefined ? undefined : readManagedPrContent(expected.comment.body);
    if (existing?.id !== expected.comment?.id || currentContent?.content !== expectedContent?.content) {
      throw new Error('Die Übergabe wurde inzwischen auf GitHub geändert oder entfernt. Deine Vorschau bleibt erhalten. Erstelle eine neue Vorschau, um den aktuellen Stand zu übernehmen.');
    }
    const body = replaceManagedPrContent(existing?.body, wanted);
    const pr = current.pullRequest;
    const endpoint = existing === undefined
      ? `repos/${pr.owner}/${pr.repository}/issues/${pr.number}/comments`
      : `repos/${pr.owner}/${pr.repository}/issues/comments/${existing.id}`;
    const comment = parseComment(await this.#api(pr.host, [
      '--method', existing === undefined ? 'POST' : 'PATCH', endpoint, '--input', '-',
    ], JSON.stringify({ body })));
    return { target: { ...current, comment }, comment, changed: true };
  }

  /** Read or write one API response while keeping request bodies out of command arguments. */
  #api(host: string, args: readonly string[], input?: string): Promise<unknown> {
    return this.#json(['api', '--hostname', host, ...args], input);
  }

  /** Parse the CLI response as untrusted JSON, retaining actionable network and account errors. */
  async #json(args: readonly string[], input?: string): Promise<unknown> {
    const output = await this.#run(args, input);
    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw new Error('GitHub CLI hat keine gültigen Daten geliefert. Prüfe deine Anmeldung und versuche es erneut.');
    }
  }

  /** Invoke GitHub CLI without a shell, terminal prompts, or repository environment overrides. */
  #run(args: readonly string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const environment: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1' };
      delete environment['GH_REPO'];
      const child = execFile(this.executable, [...args], {
        cwd: this.workspaceRoot, env: environment, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else {
          const detail = stderr.trim().slice(0, 900).replaceAll(/(?:gh[pousr]_[A-Za-z\d_]+|github_pat_[A-Za-z\d_]+)/gu, '[credential]');
          reject(new Error(`GitHub konnte die PR-Übergabe nicht abschließen. Prüfe „gh auth status“ und ob der aktuelle Branch einen offenen PR hat.${detail ? `\n\n${detail}` : ''}${input === undefined ? '' : '\n\nDer Schreibvorgang kann bereits erfolgt sein. „Erneut versuchen“ gleicht den vorhandenen Kommentar ab.'}`));
        }
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
    });
  }
}

/** Validate the CLI's selected PR and derive API routing from its canonical URL. */
function parsePullRequest(value: unknown): GitHubPullRequest {
  const record = object(value);
  if (record['state'] !== 'OPEN') throw new Error('Der aktuelle Branch hat keinen offenen GitHub-PR. Öffne oder erstelle zuerst einen PR für diesen Branch.');
  const url = new URL(text(record['url'], 'PR-Adresse'));
  const parts = url.pathname.split('/').filter(Boolean);
  const [owner, repository, kind, numberText] = parts;
  const number = Number(numberText);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || !/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/iu.test(url.hostname)
    || parts.length !== 4 || owner === undefined || repository === undefined || kind !== 'pull'
    || !/^[a-z\d_.-]+$/iu.test(owner) || !/^[a-z\d_.-]+$/iu.test(repository)
    || owner === '.' || owner === '..' || repository === '.' || repository === '..'
    || !Number.isSafeInteger(number) || number <= 0 || record['number'] !== number) {
    throw new Error('GitHub CLI hat keine eindeutige PR-Adresse geliefert.');
  }
  return {
    host: url.hostname, owner, repository, number, url: url.toString(),
    title: text(record['title'], 'PR-Titel'), branch: text(record['headRefName'], 'PR-Branch'),
  };
}

/** Validate an API comment before using its identifier in an update endpoint. */
function parseComment(value: unknown): GitHubHandoffComment {
  const record = object(value);
  const id = record['id'];
  const url = new URL(text(record['html_url'], 'Kommentaradresse'));
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('GitHub hat keinen gültigen Kommentar geliefert.');
  }
  return { id, body: text(record['body'], 'Kommentartext', true), url: url.toString() };
}

/** Narrow an untrusted GitHub response before inspecting its properties. */
function object(value: unknown): Record<string, unknown> {
  const record = optionalObject(value);
  if (record === undefined) throw new Error('GitHub hat unvollständige Daten geliefert.');
  return record;
}

/** Recognize a JSON object without trusting arrays or null values. */
function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Require textual API fields without coercion. */
function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`GitHub hat kein gültiges Feld „${label}“ geliefert.`);
  return value;
}
