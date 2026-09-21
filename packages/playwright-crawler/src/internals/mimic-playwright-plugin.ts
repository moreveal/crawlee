import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import type { BrowserPluginOptions, LaunchContext } from '@crawlee/browser-pool';
import { PlaywrightPlugin } from '@crawlee/browser-pool';
import type { Browser, BrowserType, LaunchOptions } from 'playwright';

export interface MimicPlaywrightPluginOptions extends BrowserPluginOptions<LaunchOptions> {
    mimicPath: string;
    mimicArgs?: string[];
    mimicStartupTimeoutMillis?: number;
    mimicShutdownTimeoutMillis?: number;
}

/** Playwright plugin that fills a normal BrowserPool slot with a local Mimic process. */
export class MimicPlaywrightPlugin extends PlaywrightPlugin {
    readonly #mimicPath: string;
    readonly #mimicArgs: string[];
    readonly #startupTimeoutMillis: number;
    readonly #shutdownTimeoutMillis: number;

    constructor(library: BrowserType, options: MimicPlaywrightPluginOptions) {
        if (!options.mimicPath) throw new Error('mimicPath must not be empty.');
        if (options.mimicArgs?.some((arg) => arg === '--listen' || arg.startsWith('--listen='))) {
            throw new Error('MimicPlaywrightPlugin owns the --listen argument.');
        }
        super(library, { ...options, useIncognitoPages: true });
        this.#mimicPath = options.mimicPath;
        this.#mimicArgs = options.mimicArgs ?? [];
        this.#startupTimeoutMillis = options.mimicStartupTimeoutMillis ?? 15_000;
        this.#shutdownTimeoutMillis = options.mimicShutdownTimeoutMillis ?? 5_000;
    }

    protected override async _launch(launchContext: LaunchContext<BrowserType>): Promise<Browser> {
        if (this.library.name() !== 'chromium') {
            throw new Error('Mimic can only be used with Playwright Chromium.');
        }
        if (launchContext.proxyUrl) {
            throw new Error('Mimic does not yet support Crawlee proxyConfiguration.');
        }

        const child = spawn(this.#mimicPath, [...this.#mimicArgs, '--listen', '127.0.0.1:0'], {
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        try {
            const endpoint = await this.#waitForEndpoint(child);
            const browser = await this.library.connectOverCDP(endpoint);
            browser.once('disconnected', () => void this.#stop(child));
            return browser;
        } catch (error) {
            await this.#stop(child);
            throw error;
        }
    }

    async #waitForEndpoint(child: ChildProcess): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let settled = false;

            const finish = (error?: Error, endpoint?: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                child.off('error', onError);
                child.off('exit', onExit);
                child.stdout?.off('data', onStdout);
                child.stderr?.off('data', onStderr);
                if (error) reject(error);
                else {
                    child.stdout?.resume();
                    child.stderr?.resume();
                    resolve(endpoint!);
                }
            };
            const onError = (error: Error) => finish(error);
            const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
                const detail = stderr.trim();
                finish(
                    new Error(
                        `Mimic exited before publishing its CDP endpoint (code ${code}, signal ${signal})${
                            detail ? `: ${detail}` : ''
                        }`,
                    ),
                );
            };
            const onStderr = (chunk: Buffer | string) => {
                stderr = `${stderr}${chunk}`.slice(-8_192);
            };
            const onStdout = (chunk: Buffer | string) => {
                stdout += chunk;
                const lines = stdout.split(/\r?\n/);
                stdout = lines.pop() ?? '';
                for (const line of lines) {
                    const match = /^Mimic listening on (http:\/\/127\.0\.0\.1:\d+)$/.exec(line.trim());
                    if (match) {
                        finish(undefined, match[1]);
                        return;
                    }
                }
            };

            const timer = setTimeout(() => {
                const detail = stderr.trim();
                finish(
                    new Error(
                        `Mimic did not publish a CDP endpoint within ${this.#startupTimeoutMillis} ms${
                            detail ? `: ${detail}` : ''
                        }`,
                    ),
                );
            }, this.#startupTimeoutMillis);

            child.on('error', onError);
            child.on('exit', onExit);
            child.stdout?.on('data', onStdout);
            child.stderr?.on('data', onStderr);
        });
    }

    async #stop(child: ChildProcess): Promise<void> {
        if (child.exitCode !== null || child.signalCode !== null) return;

        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill();
        const graceful = await Promise.race([
            exited.then(() => true),
            new Promise<false>((resolve) => setTimeout(resolve, this.#shutdownTimeoutMillis, false)),
        ]);
        if (!graceful && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await exited;
        }
    }
}
