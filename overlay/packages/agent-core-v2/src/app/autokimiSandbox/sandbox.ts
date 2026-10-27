import { randomBytes } from 'node:crypto';
import { lstatSync, readlinkSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';
import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { ApprovalReviewConfigSchema } from '#/agent/approvalReview/config';
import type { PermissionConfig } from '#/agent/permissionRules/configSection';

let initialization: Promise<void> | undefined;
let users = 0;
let teardown = Promise.resolve();
const names = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'KIMI.md',
  '.agents',
  '.kimi',
  '.kimi-code',
]);
const literal = (path: string) => ({ path, literal: true as const });

export function protectedShellPaths(
  workDir: string,
  home: string,
  runtimeTargets = new Set<string>(),
): string[] {
  const root = realpathSync(home);
  const paths = new Set([root]);
  runtimeTargets.add(root);
  const inspect = (root: string, instructions: boolean) => {
    const pending = [root];
    const seen = new Set<string>();
    let count = 0;
    while (pending.length > 0) {
      const directory = pending.pop()!;
      if (seen.has(directory)) continue;
      seen.add(directory);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (++count > 100000)
          throw new Error('Protected path scan exceeds its budget');
        const path = join(directory, entry.name);
        if (!instructions && entry.isFile() && lstatSync(path).nlink !== 1)
          throw new Error(
            'Protected runtime storage contains hard links; remove the aliases before running shell commands',
          );
        if (!instructions && entry.isSymbolicLink()) {
          let target: string;
          try {
            target = realpathSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            target = resolve(dirname(path), readlinkSync(path));
          }
          const outside = relative(root, target);
          if (
            isAbsolute(outside) ||
            outside === '..' ||
            outside.startsWith('../')
          ) {
            paths.add(target);
            runtimeTargets.add(target);
          }
          try {
            const stat = lstatSync(target);
            if (stat.isFile() && stat.nlink !== 1)
              throw new Error('Protected runtime target contains hard links');
            if (stat.isDirectory()) pending.push(target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          continue;
        }
        if (instructions && names.has(entry.name)) {
          paths.add(path);
          try {
            const target = realpathSync(path);
            paths.add(target);
            if (lstatSync(target).isFile() && lstatSync(target).nlink !== 1)
              throw new Error(
                'Protected instruction file has hard-link aliases',
              );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          continue;
        }
        if (
          entry.isDirectory() &&
          (!instructions ||
            !['node_modules', '.git', '.cache', '.artifacts'].includes(
              entry.name,
            ))
        )
          pending.push(path);
      }
    }
  };
  inspect(realpathSync(home), false);
  inspect(workDir, true);
  for (let directory = workDir; ; directory = dirname(directory)) {
    for (const name of names) {
      const path = join(directory, name);
      if (directory === workDir) paths.add(path);
      try {
        paths.add(realpathSync(path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (dirname(directory) === directory) break;
  }
  return [...paths];
}

export async function waitForShellSandboxShutdown(): Promise<void> {
  await teardown;
}

export type IAutoKimiSandbox = AutoKimiSandbox;
export const IAutoKimiSandbox =
  createDecorator<AutoKimiSandbox>('autokimiSandbox');

export class AutoKimiSandbox extends Disposable {
  declare readonly _serviceBrand: undefined;
  private registered = false;
  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
    this._register({
      dispose: () => {
        if (this.registered && --users === 0) {
          const pending = initialization;
          initialization = undefined;
          teardown = teardown
            .catch(() => {})
            .then(async () => {
              await pending?.catch(() => {});
              await SandboxManager.reset();
            });
          void teardown.catch(() => {});
        }
      },
    });
  }

  async wrap(
    command: string,
    cwd: string,
    shell: string,
    signal: AbortSignal,
    networkGranted: boolean,
    required = false,
  ) {
    const permission = this.config.get('permission') as
      PermissionConfig | undefined;
    const settings = ApprovalReviewConfigSchema.parse(permission?.review ?? {});
    if (!settings.shellSandbox) {
      if (required)
        throw new Error(
          'AutoKimi sandbox is required for headless shell execution',
        );
      return undefined;
    }
    signal.throwIfAborted();
    if (!['darwin', 'linux'].includes(process.platform))
      throw new Error(
        'AutoKimi sandbox: unsupported platform; shell was not started',
      );
    const home = realpathSync(this.bootstrap.homeDir);
    const workDir = realpathSync(cwd);
    const runtimeTargets = new Set<string>();
    const sandboxRoot = dirname(
      dirname(
        fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime')),
      ),
    );
    const denyWrite = [
      ...protectedShellPaths(workDir, home, runtimeTargets),
      dirname(
        dirname(
          fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime')),
        ),
      ),
      fileURLToPath(import.meta.url),
      process.execPath,
    ];
    const readableTools = [
      join(home, 'bin', 'autokimi'),
      process.execPath,
      sandboxRoot,
    ];
    const nodeRoot = dirname(dirname(process.execPath));
    const managedNode = relative(join(home, 'autokimi', 'tools'), nodeRoot);
    if (
      /^node-v[0-9]+\.[0-9]+\.[0-9]+-(?:darwin|linux)-(?:arm64|x64)$/.test(
        managedNode,
      )
    )
      readableTools.push(join(nodeRoot, 'lib', 'node_modules', 'npm'));
    const identifier = randomBytes(16).toString('base64url');
    if (!this.registered) {
      users++;
      this.registered = true;
    }
    initialization ??= teardown
      .then(() =>
        SandboxManager.initialize(
          {
            network: { allowedDomains: [], deniedDomains: [] },
            filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
            bwrapPath:
              process.platform === 'linux' ? '/usr/bin/bwrap' : undefined,
            socatPath:
              process.platform === 'linux' ? '/usr/bin/socat' : undefined,
            ripgrep: {
              command:
                process.platform === 'linux' ? '/usr/bin/rg' : '/usr/bin/false',
            },
            enableWeakerNestedSandbox: false,
            allowNestedUserNamespaces: false,
          },
          undefined,
          false,
        ),
      )
      .catch(async (error) => {
        initialization = undefined;
        await SandboxManager.reset();
        throw error;
      });
    try {
      await initialization;
    } catch (error) {
      throw new Error(
        'AutoKimi sandbox unavailable; shell was not started. Linux needs bubblewrap, socat and ripgrep. ' +
          String(error),
      );
    }
    signal.throwIfAborted();
    const config: SandboxRuntimeConfig = {
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowUnixSockets: [],
        allowLocalBinding: false,
      },
      filesystem: {
        allowWrite: [literal(workDir), literal(tmpdir())],
        denyWrite: denyWrite.map(literal),
        denyRead: [
          ...runtimeTargets,
          join(homedir(), '.ssh'),
          join(homedir(), '.aws'),
          join(homedir(), '.gnupg'),
        ].map(literal),
        allowRead: readableTools.map(literal),
      },
      enableWeakerNestedSandbox: false,
      allowNestedUserNamespaces: false,
    };
    const grant = () =>
      SandboxManager.registerCommandNetworkLists(identifier, {
        allowedDomains: networkGranted ? settings.shellAllowedDomains : [],
      });
    try {
      const wrapped = await SandboxManager.wrapWithSandboxArgv(
        command,
        shell,
        config,
        signal,
        workDir,
        { commandId: identifier },
      );
      grant();
      const env: Record<string, string> = {};
      for (const key of new Set([
        ...Object.keys(process.env),
        ...Object.keys(wrapped.env),
      ]))
        env[key] =
          /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ACCESS_KEY)/i.test(
            key,
          ) && wrapped.env[key] === process.env[key]
            ? ''
            : (wrapped.env[key] ?? '');
      for (const key of [
        'BASH_ENV',
        'ENV',
        'NODE_OPTIONS',
        'LD_PRELOAD',
        'LD_LIBRARY_PATH',
        'DYLD_LIBRARY_PATH',
        'DYLD_FALLBACK_LIBRARY_PATH',
        'DYLD_INSERT_LIBRARIES',
      ])
        env[key] = '';
      return {
        argv: wrapped.argv,
        env,
        cleanup: () => SandboxManager.unregisterCommandNetworkLists(identifier),
      };
    } catch (error) {
      SandboxManager.unregisterCommandNetworkLists(identifier);
      throw error;
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IAutoKimiSandbox,
  AutoKimiSandbox,
  ScopeActivation.OnDemand,
  'autokimiSandbox',
);
