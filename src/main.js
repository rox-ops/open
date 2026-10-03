import { Actor } from 'apify';
import { chromium } from 'playwright';
import { open, unlink } from 'node:fs/promises';

const DEFAULT_MAX_ITEMS = 5;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_REQUESTS_PER_SECOND = 1;
const DEFAULT_TOTAL_RUNTIME_MS = 10 * 60 * 1_000;
const MAX_ITEMS_LIMIT = 100;
const MAX_CONCURRENCY_LIMIT = 4;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RUNTIME_MS = 30 * 60 * 1_000;
const MAX_RETRIES = 2;
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function boundedInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function nextUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function normaliseInput(input = {}) {
    return {
        startUrl: String(input.startUrl || 'https://example.com/'),
        maxItems: boundedInteger(input.maxItems, DEFAULT_MAX_ITEMS, 1, MAX_ITEMS_LIMIT),
        concurrency: boundedInteger(input.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY_LIMIT),
        timeout: boundedInteger(input.timeout, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS),
        rateLimit: boundedInteger(input.rateLimit, DEFAULT_REQUESTS_PER_SECOND, 1, 2),
        totalRuntime: boundedInteger(input.totalRuntime, DEFAULT_TOTAL_RUNTIME_MS, 30_000, MAX_RUNTIME_MS),
    };
}

function isLikelyVideoUrl(url) {
    const pathname = new URL(url).pathname.toLowerCase();
    return /\.(html?|php|asp|aspx)$/.test(pathname) || pathname.includes('/video') || pathname.includes('/watch');
}

function isExcludedMediaUrl(url) {
    return /thumbnail|poster|trailer|teaser|advert|ads?|promo|promotional|banner|logo/i.test(url);
}

function extractUrl(value) {
    if (!value || typeof value !== 'string') return null;
    try {
        return new URL(value).href;
    } catch {
        return null;
    }
}

function chooseMediaUrl(urls, extensionPattern) {
    return [...urls].find((url) => extensionPattern.test(url) && !isExcludedMediaUrl(url)) || null;
}

async function detectAndHandleAgeVerification(page) {
    const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    if (!/age verification|are you 18|older than 18|over 18|confirm your age/i.test(bodyText)) return 'none';

    const selectors = [
        'button:has-text("I am older than 18")',
        'button:has-text("I am over 18")',
        'button:has-text("Enter")',
        'a:has-text("I am older than 18")',
        'input[type="button"][value*="18"]',
    ];
    for (const selector of selectors) {
        const control = page.locator(selector).first();
        if (await control.isVisible().catch(() => false)) {
            await control.click({ timeout: 5_000 });
            await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
            return 'handled';
        }
    }
    return 'blocked';
}

async function extractRecord(page, url, timeout) {
    const inlineState = await page.evaluate(() => {
        const state = {};
        for (const script of document.querySelectorAll('script:not([src])')) {
            const text = script.textContent?.trim();
            if (!text || text.length > 1_000_000) continue;
            try {
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object') Object.assign(state, parsed);
            } catch {
                // Only inspect inline scripts that are valid JSON.
            }
        }
        return state;
    }).catch(() => ({}));

    const metadata = await page.evaluate(() => {
        const read = (selector, attribute = 'content') => document.querySelector(selector)?.getAttribute(attribute) || null;
        const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
            .flatMap((node) => { try { return [JSON.parse(node.textContent)]; } catch { return []; } });
        const media = [...document.querySelectorAll('video, source')]
            .map((node) => node.currentSrc || node.src || node.getAttribute('src'))
            .filter(Boolean);
        return {
            title: read('meta[property="og:title"]') || read('meta[name="twitter:title"]') || document.title,
            description: read('meta[property="og:description"]') || read('meta[name="description"]'),
            thumbnail: read('meta[property="og:image"]') || read('meta[name="twitter:image"]'),
            media,
            jsonLd,
        };
    });

    const networkUrls = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name));
    const jsonLdValues = metadata.jsonLd.flatMap((item) => Array.isArray(item) ? item : [item]);
    const allCandidateUrls = [
        ...metadata.media,
        ...networkUrls,
        inlineState.contentUrl,
        inlineState.video?.url,
        ...jsonLdValues.flatMap((item) => [item?.contentUrl, item?.embedUrl, item?.url, item?.video?.contentUrl]),
    ].map(extractUrl).filter(Boolean);

    return {
        status: 'succeeded',
        url,
        title: metadata.title || null,
        description: metadata.description || null,
        thumbnail: extractUrl(metadata.thumbnail),
        mp4Url: chooseMediaUrl(allCandidateUrls, /\.mp4(?:$|[?#])/i),
        hlsUrl: chooseMediaUrl(allCandidateUrls, /\.m3u8(?:$|[?#])/i),
        extractedAt: new Date().toISOString(),
        timeout,
    };
}

async function saveFailure(url, status, error) {
    await Actor.pushData({ status, url, error: String(error?.message || error), extractedAt: new Date().toISOString() });
}

async function main() {
    const input = normaliseInput(await Actor.getInput());
    const abortController = new AbortController();
    const stop = () => abortController.abort();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    Actor.on('aborting', stop);

    let browser;
    try {
        const proxyConfiguration = await Actor.createProxyConfiguration();
        const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
        browser = await chromium.launch({ headless: true, proxy: proxyUrl ? { server: proxyUrl } : undefined });
        const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
        const page = await context.newPage();
        page.setDefaultTimeout(input.timeout);
        page.setDefaultNavigationTimeout(input.timeout);
        const deadline = Date.now() + input.totalRuntime;
        const requestInterval = 1_000 / input.rateLimit;
        let nextRequestAt = 0;
        let requestGate = Promise.resolve();
        const beforeRequest = async (requestPage) => {
            const turn = requestGate.then(async () => {
                const wait = Math.max(0, nextRequestAt - Date.now());
                if (wait > 0) await sleep(wait);
                nextRequestAt = Date.now() + requestInterval;
                await requestPage.setExtraHTTPHeaders({ 'User-Agent': nextUserAgent() });
            });
            requestGate = turn.catch(() => {});
            await turn;
        };
        const discoveredUrls = new Set([input.startUrl]);
        let startBlocked = false;
        let startFailed = false;

        try {
            let loaded = false;
            let lastError;
            for (let attempt = 0; attempt <= MAX_RETRIES && !loaded; attempt += 1) {
                if (attempt > 0) await sleep(Math.min(input.timeout, 1_000 * 2 ** attempt));
                try {
                    await beforeRequest(page);
                    await page.goto(input.startUrl, { waitUntil: 'domcontentloaded', timeout: input.timeout });
                    loaded = true;
                } catch (error) {
                    lastError = error;
                }
            }
            if (!loaded) throw lastError;
            const ageStatus = await detectAndHandleAgeVerification(page);
            if (ageStatus === 'blocked') {
                startBlocked = true;
                await saveFailure(input.startUrl, 'blocked', new Error('Age verification requires an unavailable continuation control.'));
            } else {
                const links = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) => anchor.href));
                for (const link of links) {
                    if (discoveredUrls.size >= input.maxItems) break;
                    if (isLikelyVideoUrl(link) && new URL(link).origin === new URL(input.startUrl).origin) discoveredUrls.add(link);
                }
            }
        } catch (error) {
            startFailed = true;
            await saveFailure(input.startUrl, error.status || 'failed', error);
        } finally {
            await page.close().catch(() => {});
        }

        const urls = startBlocked || startFailed ? [] : [...discoveredUrls].slice(0, input.maxItems);
        let nextIndex = 0;
        const worker = async () => {
            while (!abortController.signal.aborted && Date.now() < deadline) {
                const index = nextIndex++;
                if (index >= urls.length) return;
                const url = urls[index];
                let completed = false;
                for (let attempt = 0; attempt <= MAX_RETRIES && !completed; attempt += 1) {
                    if (attempt > 0) await sleep(Math.min(input.timeout, 1_000 * 2 ** attempt));
                    const workerPage = await context.newPage();
                    workerPage.setDefaultTimeout(input.timeout);
                    workerPage.setDefaultNavigationTimeout(input.timeout);
                    try {
                        await beforeRequest(workerPage);
                        await workerPage.goto(url, { waitUntil: 'domcontentloaded', timeout: input.timeout });
                        const ageStatus = await detectAndHandleAgeVerification(workerPage);
                        if (ageStatus === 'blocked') {
                            const blockedError = new Error('Age verification requires an unavailable continuation control.');
                            blockedError.status = 'blocked';
                            throw blockedError;
                        }
                        await Actor.pushData(await extractRecord(workerPage, url, input.timeout));
                        completed = true;
                    } catch (error) {
                        if (error.status === 'blocked' || attempt === MAX_RETRIES) {
                            await saveFailure(url, error.status || 'failed', error);
                        }
                    } finally {
                        await workerPage.close().catch(() => {});
                    }
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(input.concurrency, urls.length) }, worker));
        await context.close();
    } finally {
        if (browser) await browser.close().catch(() => {});
        process.removeListener('SIGTERM', stop);
        process.removeListener('SIGINT', stop);
    }
}

await Actor.main(async () => {
    const lockPath = process.env.ACTOR_LOCK_FILE || '/tmp/video-metadata-playwright.lock';
    let lock;
    try {
        lock = await open(lockPath, 'wx');
    } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Another Actor instance is already active.');
        throw error;
    }
    try {
        await main();
    } finally {
        await lock.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
    }
});