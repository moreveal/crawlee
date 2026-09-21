import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import {
    createPlaywrightRouter,
    Dataset,
    MemoryStorageBackend,
    PlaywrightCrawler,
    playwrightBrowserPool,
    serviceLocator,
    SessionPool,
} from 'crawlee';
import type { Page } from 'playwright';

const defaultMimicPath = resolve(import.meta.dirname, '../../../mimic/.build/mimic-crawlee-fixed.exe');
const mimicPath = process.env.MIMIC_PATH ?? defaultMimicPath;

interface FixtureState {
    requests: { path: string; hookHeader?: string; cookie?: string }[];
    retryHits: number;
    permanentFailureHits: number;
}

const state: FixtureState = { requests: [], retryHits: 0, permanentFailureHits: 0 };
let server: Server;
let origin: string;

function html(body: string, title = 'Mimic fixture'): string {
    return `<!doctype html>
        <html>
            <head><title>${title}</title><script src="/fixture.js"></script></head>
            <body>${body}</body>
        </html>`;
}

beforeAll(async () => {
    server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://fixture.test');
        state.requests.push({
            path: url.pathname,
            hookHeader: request.headers['x-mimic-suite'] as string | undefined,
            cookie: request.headers.cookie,
        });

        const send = (status: number, body: string, headers: Record<string, string> = {}) => {
            response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
            response.end(body);
        };

        if (url.pathname === '/fixture.js') {
            send(200, 'window.fixtureScriptLoaded = true;', { 'content-type': 'text/javascript' });
            return;
        }
        if (url.pathname === '/api/json') {
            send(
                200,
                JSON.stringify({
                    ok: true,
                    hookHeader: request.headers['x-mimic-suite'],
                    cookie: request.headers.cookie,
                }),
                { 'content-type': 'application/json', 'x-fixture-response': 'json' },
            );
            return;
        }
        if (url.pathname === '/cookie/set') {
            send(200, html('<h1>cookie set</h1>'), {
                'set-cookie': 'response_cookie=from-server; Path=/; SameSite=Lax',
            });
            return;
        }
        if (url.pathname === '/cookie/echo') {
            send(200, html(`<h1 id="cookie">${request.headers.cookie ?? ''}</h1>`));
            return;
        }
        if (url.pathname === '/download-page') {
            send(200, html('<a id="download" href="/download-file" download="fixture.txt">download</a>'));
            return;
        }
        if (url.pathname === '/download-file') {
            send(200, 'download contents', {
                'content-type': 'text/plain',
                'content-disposition': 'attachment; filename="fixture.txt"',
            });
            return;
        }
        if (url.pathname === '/redirect') {
            response.writeHead(302, { location: '/final?redirected=yes' });
            response.end();
            return;
        }
        if (url.pathname === '/retry') {
            state.retryHits++;
            if (state.retryHits === 1) {
                send(503, 'retry me');
            } else {
                send(200, html('<h1 id="retry-success">retry succeeded</h1>', 'Retry succeeded'));
            }
            return;
        }
        if (url.pathname === '/always-fail') {
            state.permanentFailureHits++;
            send(500, 'permanent failure');
            return;
        }
        if (url.pathname.startsWith('/slow/')) {
            const id = url.pathname.split('/').at(-1)!;
            setTimeout(() => send(200, html(`<h1 data-id="${id}">slow ${id}</h1>`, `Slow ${id}`)), 100);
            return;
        }
        if (url.pathname.startsWith('/detail/')) {
            const id = url.pathname.split('/').at(-1)!;
            send(
                200,
                html(
                    `<h1 data-id="${id}">Detail ${id}</h1>
                     <button id="mutate" onclick="this.dataset.clicked = 'yes'; this.textContent = 'clicked'">mutate</button>`,
                    `Detail ${id}`,
                ),
            );
            return;
        }
        if (url.pathname === '/final') {
            send(200, html('<h1 id="redirect-target">redirect target</h1>', 'Redirect target'));
            return;
        }
        if (url.pathname === '/seed') {
            send(
                200,
                html(
                    `<h1 id="seed">seed</h1>
                     <a class="detail" href="/detail/1">one</a>
                     <a class="detail" href="/detail/1">duplicate one</a>
                     <a class="detail" href="/detail/2">two</a>
                     <a class="redirect" href="/redirect">redirect</a>
                     <a class="retry" href="/retry">retry</a>
                     <a class="external" href="https://example.invalid/outside">outside</a>`,
                    'Seed',
                ),
            );
            return;
        }

        send(404, 'not found');
    });
    await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
    );
});

beforeEach(() => {
    serviceLocator.setStorageBackend(new MemoryStorageBackend());
    state.requests.length = 0;
    state.retryHits = 0;
    state.permanentFailureHits = 0;
});

describe.skipIf(!existsSync(mimicPath))('PlaywrightCrawler with local Mimic', () => {
    test('covers routing, enqueueing, hooks, DOM, browser state, network interception, redirects and storage', async () => {
        const handled: string[] = [];
        const retryErrors: string[] = [];
        const postNavigationStatuses: number[] = [];
        const router = createPlaywrightRouter();

        router.addHandler('DETAIL', async ({ page, request, pushData, useState }) => {
            const id = await page.locator('h1').getAttribute('data-id');
            expect(id).toMatch(/^[12]$/);
            expect(await page.title()).toBe(`Detail ${id}`);
            expect(await page.evaluate(() => Reflect.get(window, 'fixtureScriptLoaded'))).toBe(true);

            await page.locator('#mutate').click();
            expect(await page.locator('#mutate').textContent()).toBe('clicked');
            expect(await page.locator('#mutate').getAttribute('data-clicked')).toBe('yes');

            const stateObject = await useState<{ visits: number }>({ visits: 0 });
            stateObject.visits++;
            await pushData({ id, url: request.loadedUrl, kind: 'detail' });
            handled.push(`detail-${id}`);
        });

        router.addHandler('REDIRECT', async ({ page, request }) => {
            expect(new URL(request.loadedUrl!).pathname).toBe('/final');
            expect(new URL(request.loadedUrl!).searchParams.get('redirected')).toBe('yes');
            expect(await page.locator('#redirect-target').textContent()).toBe('redirect target');
            handled.push('redirect');
        });

        router.addHandler('RETRY', async ({ page, response }) => {
            expect(response?.status()).toBe(200);
            expect(await page.locator('#retry-success').textContent()).toBe('retry succeeded');
            handled.push('retry');
        });

        router.addDefaultHandler(async ({ page, enqueueLinks, pushData, parseWithCheerio }) => {
            expect(await page.title()).toBe('Seed');
            expect(await page.evaluate(() => Reflect.get(window, 'fixtureScriptLoaded'))).toBe(true);
            const $ = await parseWithCheerio();
            expect($('#seed').text()).toBe('seed');
            expect($('a.detail')).toHaveLength(3);

            await page.evaluate(() => {
                localStorage.setItem('local-key', 'local-value');
                sessionStorage.setItem('session-key', 'session-value');
                document.cookie = 'client_cookie=from-page; Path=/; SameSite=Lax';
            });
            expect(
                await page.evaluate(() => ({
                    local: localStorage.getItem('local-key'),
                    session: sessionStorage.getItem('session-key'),
                    cookie: document.cookie,
                })),
            ).toEqual({
                local: 'local-value',
                session: 'session-value',
                cookie: expect.stringContaining('client_cookie=from-page'),
            });

            const api = await page.evaluate(async () => {
                const response = await fetch('/api/json');
                return {
                    status: response.status,
                    header: response.headers.get('x-fixture-response'),
                    body: await response.json(),
                };
            });
            expect(api).toMatchObject({
                status: 200,
                header: 'json',
                body: { ok: true, hookHeader: 'enabled', cookie: expect.stringContaining('client_cookie=from-page') },
            });

            const xhr = await page.evaluate(
                () =>
                    new Promise<{ status: number; body: { ok: boolean } }>((resolveXHR, rejectXHR) => {
                        const request = new XMLHttpRequest();
                        request.open('GET', '/api/json');
                        request.onload = () =>
                            resolveXHR({ status: request.status, body: JSON.parse(request.responseText) });
                        request.onerror = () => rejectXHR(new Error('XHR failed'));
                        request.send();
                    }),
            );
            expect(xhr).toEqual({ status: 200, body: expect.objectContaining({ ok: true }) });

            await page.route('**/api/intercepted', (route) =>
                route.fulfill({
                    status: 201,
                    contentType: 'application/json',
                    body: JSON.stringify({ intercepted: true }),
                }),
            );
            expect(
                await page.evaluate(async () => {
                    const response = await fetch('/api/intercepted');
                    return { status: response.status, body: await response.json() };
                }),
            ).toEqual({ status: 201, body: { intercepted: true } });
            await page.unroute('**/api/intercepted');

            await pushData({ kind: 'seed' });
            await enqueueLinks({ selector: 'a.detail', label: 'DETAIL', strategy: 'same-origin' });
            await enqueueLinks({ selector: 'a.redirect', label: 'REDIRECT', strategy: 'same-origin' });
            await enqueueLinks({ selector: 'a.retry', label: 'RETRY', strategy: 'same-origin' });
            handled.push('seed');
        });

        const crawler = new PlaywrightCrawler({
            mimicPath,
            minConcurrency: 2,
            maxConcurrency: 4,
            maxRequestRetries: 2,
            requestHandler: router,
            preNavigationHooks: [
                async ({ page, gotoOptions }) => {
                    await page.setExtraHTTPHeaders({ 'x-mimic-suite': 'enabled' });
                    gotoOptions.waitUntil = 'load';
                },
            ],
            postNavigationHooks: [
                async ({ response }) => {
                    if (response) postNavigationStatuses.push(response.status());
                },
            ],
            errorHandler: async ({ request }, error) => {
                retryErrors.push(`${new URL(request.url).pathname}: ${error.message}`);
            },
        });

        const stats = await crawler.run([`${origin}/seed`]);

        expect(stats.requestsSucceeded).toBe(5);
        expect(stats.requestsFailed).toBe(0);
        expect(handled.sort()).toEqual(['detail-1', 'detail-2', 'redirect', 'retry', 'seed']);
        expect(state.retryHits).toBe(2);
        expect(retryErrors).toHaveLength(1);
        expect(retryErrors[0]).toContain('/retry: 503');
        expect(postNavigationStatuses).toContain(503);
        expect(postNavigationStatuses.filter((status) => status === 200)).toHaveLength(5);
        expect(state.requests.filter(({ path }) => path === '/detail/1')).toHaveLength(1);
        expect(state.requests.some(({ path }) => path === '/outside')).toBe(false);
        expect(
            state.requests
                .filter(({ path }) => !['/fixture.js'].includes(path))
                .every(({ hookHeader }) => hookHeader === 'enabled'),
        ).toBe(true);

        const dataset = await Dataset.open();
        const data = await dataset.getData();
        expect(data.items).toHaveLength(3);
        expect(data.items.map(({ kind }) => kind).sort()).toEqual(['detail', 'detail', 'seed']);
    }, 120_000);

    test('runs concurrent isolated contexts in one native BrowserPool slot and tears it down', async () => {
        const controllerIds = new Set<string>();
        const pageControllerIds = new WeakMap<Page, string>();
        const observations: { id: string; cookieBefore: string; localBefore: string | null; ownState: boolean }[] = [];
        let activeHandlers = 0;
        let peakHandlers = 0;

        const browserPool = playwrightBrowserPool({
            launchContext: { mimicPath },
            maxOpenPagesPerBrowser: 4,
            retireBrowserAfterPageCount: 20,
            postPageCreateHooks: [
                async (page, controller) => {
                    controllerIds.add(controller.id);
                    pageControllerIds.set(page, controller.id);
                },
            ],
        });
        const crawler = new PlaywrightCrawler({
            browserPool,
            minConcurrency: 4,
            maxConcurrency: 4,
            async requestHandler({ page, request }) {
                activeHandlers++;
                peakHandlers = Math.max(peakHandlers, activeHandlers);
                try {
                    const id = new URL(request.url).pathname.split('/').at(-1)!;
                    const before = await page.evaluate(() => ({
                        cookie: document.cookie,
                        local: localStorage.getItem('slot'),
                    }));
                    await page.evaluate((value) => {
                        document.cookie = `slot=${value}; Path=/; SameSite=Lax`;
                        localStorage.setItem('slot', value);
                    }, id);
                    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
                    const ownState = await page.evaluate(
                        (value) => document.cookie.includes(`slot=${value}`) && localStorage.getItem('slot') === value,
                        id,
                    );
                    observations.push({ id, cookieBefore: before.cookie, localBefore: before.local, ownState });
                    expect(pageControllerIds.get(page)).toBeDefined();
                } finally {
                    activeHandlers--;
                }
            },
        });

        try {
            const stats = await crawler.run([1, 2, 3, 4].map((id) => `${origin}/slow/${id}`));
            expect(stats.requestsSucceeded).toBe(4);
            expect(stats.requestsFailed).toBe(0);
        } finally {
            await browserPool.destroy();
        }

        expect(controllerIds.size).toBe(1);
        expect(peakHandlers).toBeGreaterThanOrEqual(2);
        expect(observations).toHaveLength(4);
        expect(
            observations.every(
                ({ cookieBefore, localBefore, ownState }) => cookieBefore === '' && localBefore === null && ownState,
            ),
        ).toBe(true);
        expect(browserPool.activeBrowserControllers.size).toBe(0);
    }, 120_000);

    test('hands cookies through SessionPool between isolated pages', async () => {
        const cookiesSeen: string[] = [];
        const pageCookiesSeen: string[] = [];
        const browserCookiesSeen: unknown[][] = [];
        const sessionIds: string[] = [];
        const sessionPool = new SessionPool({ maxPoolSize: 1 });
        const crawler = new PlaywrightCrawler({
            mimicPath,
            sessionPool,
            saveResponseCookies: true,
            maxConcurrency: 1,
            async requestHandler({ page, request, session }) {
                sessionIds.push(session.id);
                cookiesSeen.push(await session.cookieJar.getCookieString(request.url));
                if (new URL(request.url).pathname === '/cookie/set') {
                    await page.context().addCookies([
                        {
                            name: 'handler_cookie',
                            value: 'from-handler',
                            url: origin,
                            expires: Date.now() / 1000 + 3600,
                        },
                    ]);
                    browserCookiesSeen.push(await page.context().cookies());
                } else {
                    const cookieText = await page.locator('#cookie').textContent();
                    pageCookiesSeen.push(cookieText ?? '');
                }
            },
        });

        const stats = await crawler.run([`${origin}/cookie/set`, `${origin}/cookie/echo`]);

        expect(stats.requestsSucceeded).toBe(2);
        expect(stats.requestsFailed).toBe(0);
        expect(new Set(sessionIds).size).toBe(1);
        expect(browserCookiesSeen[0]).toEqual([
            expect.objectContaining({ name: 'response_cookie', value: 'from-server' }),
            expect.objectContaining({ name: 'handler_cookie', value: 'from-handler' }),
        ]);
        expect(cookiesSeen[0]).toContain('response_cookie=from-server');
        expect(cookiesSeen[0]).not.toContain('handler_cookie');
        expect(cookiesSeen[1]).toContain('response_cookie=from-server');
        expect(cookiesSeen[1]).toContain('handler_cookie=from-handler');
        expect(pageCookiesSeen[0]).toContain('response_cookie=from-server');
        expect(pageCookiesSeen[0]).toContain('handler_cookie=from-handler');
    }, 120_000);

    test('applies Playwright launch context environment options through Mimic', async () => {
        const observations: Record<string, unknown>[] = [];
        const browserPool = playwrightBrowserPool({
            launchContext: {
                mimicPath,
                launchOptions: {
                    locale: 'fr-FR',
                    reducedMotion: 'reduce',
                    colorScheme: 'dark',
                    viewport: { width: 1024, height: 640 },
                },
            },
            useFingerprints: false,
        });
        const crawler = new PlaywrightCrawler({
            browserPool,
            async requestHandler({ page }) {
                observations.push(
                    await page.evaluate(() => ({
                        language: navigator.language,
                        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
                        dark: matchMedia('(prefers-color-scheme: dark)').matches,
                        width: innerWidth,
                        height: innerHeight,
                        webdriver: navigator.webdriver,
                    })),
                );
            },
        });

        try {
            const stats = await crawler.run([`${origin}/detail/environment`]);
            expect(stats.requestsSucceeded).toBe(1);
            expect(stats.requestsFailed).toBe(0);
        } finally {
            await browserPool.destroy();
        }

        expect(observations).toEqual([
            {
                language: 'fr-FR',
                reducedMotion: true,
                dark: true,
                width: 1024,
                height: 640,
                webdriver: false,
            },
        ]);
    }, 120_000);

    test('reports permanent HTTP failures after the configured retry count', async () => {
        const retryErrors: string[] = [];
        const finalErrors: string[] = [];
        let handlerCalls = 0;
        const crawler = new PlaywrightCrawler({
            mimicPath,
            maxRequestRetries: 1,
            requestHandler: async () => {
                handlerCalls++;
            },
            errorHandler: async (_context, error) => {
                retryErrors.push(error.message);
            },
            failedRequestHandler: async ({ request }, error) => {
                finalErrors.push(`${request.errorMessages.length}: ${error.message}`);
            },
        });

        const stats = await crawler.run([`${origin}/always-fail`]);

        expect(stats.requestsSucceeded).toBe(0);
        expect(stats.requestsFailed).toBe(1);
        expect(handlerCalls).toBe(0);
        expect(state.permanentFailureHits).toBe(2);
        expect(retryErrors).toHaveLength(1);
        expect(retryErrors[0]).toContain('500');
        expect(finalErrors).toHaveLength(1);
        expect(finalErrors[0]).toContain('2: 500');
    }, 120_000);

    test.fails('TODO compatibility: returns coherent PNG, JPEG, clipped and state-sensitive screenshot bytes', async () => {
        const crawler = new PlaywrightCrawler({
            mimicPath,
            maxConcurrency: 1,
            maxRequestRetries: 0,
            async requestHandler({ page }) {
                const png = await page.screenshot({ type: 'png' });
                const repeated = await page.screenshot({ type: 'png' });
                expect(png.length).toBeGreaterThan(64);
                expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
                expect(repeated).toEqual(png);

                await page.locator('#mutate').click();
                const changed = await page.screenshot({ type: 'png' });
                expect(changed).not.toEqual(png);

                const clipped = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 64, height: 32 } });
                expect(clipped.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
                expect(clipped).not.toEqual(changed);

                const jpeg = await page.screenshot({ type: 'jpeg', quality: 80 });
                expect(jpeg.length).toBeGreaterThan(32);
                expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
            },
        });

        const stats = await crawler.run([`${origin}/detail/screenshot`]);
        expect(stats.requestsSucceeded).toBe(1);
        expect(stats.requestsFailed).toBe(0);
    }, 120_000);

    test.fails('TODO compatibility: exposes attachment downloads through listDownloads()', async () => {
        const crawler = new PlaywrightCrawler({
            mimicPath,
            maxConcurrency: 1,
            maxRequestRetries: 0,
            async requestHandler({ page, listDownloads }) {
                expect(await listDownloads()).toHaveLength(0);
                const downloadStarted = page.waitForEvent('download', { timeout: 5_000 });
                await page.locator('#download').click();
                await downloadStarted;
                const downloads = await listDownloads();
                expect(downloads).toHaveLength(1);
                expect(downloads[0].suggestedFilename()).toBe('fixture.txt');
                expect((await downloads[0].createReadStream())?.readable).toBe(true);
            },
        });

        const stats = await crawler.run([`${origin}/download-page`]);
        expect(stats.requestsSucceeded).toBe(1);
        expect(stats.requestsFailed).toBe(0);
    }, 120_000);

    test.fails('TODO compatibility: applies timezoneId through Emulation.setTimezoneOverride', async () => {
        const browserPool = playwrightBrowserPool({
            launchContext: { mimicPath, launchOptions: { timezoneId: 'Pacific/Tahiti' } },
            useFingerprints: false,
        });
        const crawler = new PlaywrightCrawler({
            browserPool,
            maxRequestRetries: 0,
            async requestHandler({ page }) {
                expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(
                    'Pacific/Tahiti',
                );
            },
        });

        try {
            const stats = await crawler.run([`${origin}/detail/timezone`]);
            expect(stats.requestsSucceeded).toBe(1);
            expect(stats.requestsFailed).toBe(0);
        } finally {
            await browserPool.destroy();
        }
    }, 120_000);
});
