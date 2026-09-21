/** Bounded catalogue crawl using Crawlee's public PlaywrightCrawler API. */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PlaywrightCrawler } from '@crawlee/playwright';

const base = 'https://books.toscrape.com/';
const mimicPath = process.env.MIMIC_PATH;

function positiveInt(name, fallback) {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
}

const maxPages = positiveInt('MAX_PAGES', 2);
const maxBooks = positiveInt('MAX_BOOKS', 20);
const outputDir = resolve(process.env.OUTPUT_DIR ?? './storage/mimic-books');
const booksFile = resolve(outputDir, 'books.jsonl');
const errorsFile = resolve(outputDir, 'errors.jsonl');
await mkdir(outputDir, { recursive: true });
await Promise.all([writeFile(booksFile, ''), writeFile(errorsFile, '')]);

let queuedBooks = 0;
let savedBooks = 0;
let failed = 0;
const allowed = (url) => new URL(url).origin === new URL(base).origin;
const record = (file, value) => appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');

const crawler = new PlaywrightCrawler({
    ...(mimicPath ? { mimicPath } : {}),
    minConcurrency: 1,
    maxConcurrency: 2,
    maxRequestsPerMinute: 30,
    maxRequestRetries: 2,
    navigationTimeoutSecs: 30,
    requestHandlerTimeoutSecs: 45,
    maxRequestsPerCrawl: maxBooks + maxPages,
    async requestHandler({ page, request, addRequests, log }) {
        if (request.userData.kind === 'catalogue') {
            const pageNumber = request.userData.pageNumber;
            await page.locator('article.product_pod').first().waitFor();
            const links = await page.locator('article.product_pod h3 a').evaluateAll((nodes) =>
                nodes.map((node) => node.href),
            );
            const remaining = Math.max(0, maxBooks - queuedBooks);
            const selected = links.filter(allowed).slice(0, remaining);
            queuedBooks += selected.length;
            await addRequests(selected.map((url) => ({ url, userData: { kind: 'book' } })));
            log.info(`Catalogue page ${pageNumber}: queued ${selected.length} books`);

            if (pageNumber < maxPages && queuedBooks < maxBooks) {
                const next = await page.locator('li.next a').getAttribute('href');
                if (next) {
                    const url = new URL(next, request.loadedUrl ?? request.url).href;
                    if (allowed(url)) await addRequests([{ url, userData: { kind: 'catalogue', pageNumber: pageNumber + 1 } }]);
                }
            }
            return;
        }

        await page.locator('.product_main h1').waitFor();
        const data = await page.evaluate(() => {
            const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
            const table = Object.fromEntries([...document.querySelectorAll('table.table tr')].map((row) => [
                row.querySelector('th')?.textContent?.trim(), row.querySelector('td')?.textContent?.trim(),
            ]));
            return {
                title: text('.product_main h1'),
                price: text('.product_main .price_color'),
                availability: text('.product_main .availability')?.replace(/\s+/g, ' '),
                rating: document.querySelector('.product_main .star-rating')?.className.match(/\b(One|Two|Three|Four|Five)\b/)?.[0] ?? null,
                description: text('#product_description + p'),
                category: [...document.querySelectorAll('.breadcrumb li a')].at(-1)?.textContent?.trim() ?? null,
                upc: table.UPC ?? null,
                stock: table.Availability ?? null,
            };
        });
        if (!data.title || !data.price || !data.upc) throw new Error(`Missing required book fields at ${request.url}`);
        await record(booksFile, { url: request.loadedUrl ?? request.url, ...data, crawledAt: new Date().toISOString() });
        savedBooks++;
        log.info(`Saved ${savedBooks}: ${data.title}`);
    },
    async failedRequestHandler({ request, log }) {
        failed++;
        await record(errorsFile, { url: request.url, kind: request.userData.kind, errors: request.errorMessages });
        log.error(`Failed after retries: ${request.url}`);
    },
});

await crawler.run([{ url: base, userData: { kind: 'catalogue', pageNumber: 1 } }]);
console.log(JSON.stringify({ outputDir, queuedBooks, savedBooks, failed, maxPages, maxBooks }));
if (failed) process.exitCode = 1;
