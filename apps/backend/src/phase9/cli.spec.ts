import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryRoot } from '../phase7/rehearsal-config';
import { candidate } from './fixtures';

describe('compiled Phase 9 command defaults', () => {
  function cli(args: string[]) {
    try {
      return {
        status: 0,
        output: execFileSync(
          process.execPath,
          [join(repositoryRoot, 'apps/backend/dist/phase9/cli.js'), ...args],
          {
            cwd: repositoryRoot,
            env: {
              PATH: process.env.PATH,
              WIZPAY_CUTOVER_CANDIDATE_SHA: candidate,
            },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 5000,
          },
        ),
      };
    } catch (error) {
      const failure = error as {
        status: number;
        stdout: string;
        stderr: string;
      };
      return {
        status: failure.status,
        output: failure.stdout + failure.stderr,
      };
    }
  }
  it('defaults to a preparation-only plan with no production actions', () => {
    const result = cli([]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.output) as unknown).toMatchObject({
      scope: 'PREPARATION_ONLY',
      productionChanges: 0,
      liveAcceptance: 'DEFERRED',
    });
  });
  it('requires live smoke acknowledgement and emits no file contents or secrets', () => {
    const directory = mkdtempSync(join(tmpdir(), 'phase9-input-'));
    const path = join(directory, 'input.json');
    try {
      writeFileSync(
        path,
        JSON.stringify({
          secret: 'postgresql://u:never-print-me@private.invalid/db',
        }),
        { mode: 0o600 },
      );
      for (const command of ['--target-smoke', '--production-smoke']) {
        const result = cli([command, path]);
        expect(result.status).toBe(1);
        expect(result.output).not.toContain('never-print-me');
        expect(result.output).toContain('CUTOVER_INPUT_OR_GATE_INVALID');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('does not expose a production switch, deploy, import or signing command', () => {
    for (const command of ['--switch', '--deploy', '--import', '--sign'])
      expect(cli([command, '/dev/null']).status).toBe(1);
  });
});
