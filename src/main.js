import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { open, unlink } from 'node:fs/promises';

const DEFAULT_MAX_ITEMS = 5;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_REQUESTS_PER_SECOND = 5;
const MAX_REQUESTS_PER_SECOND = 5;
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
        startUrl: String(input.startUrl || 'https://xhamster19.com/search/hot+milf'),
        maxItems: boundedInteger(input.maxItems, DEFAULT_MAX_ITEMS, 1, MAX_ITEMS_LIMIT),
        concurrency: boundedInteger(input.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY_LIMIT),
        timeout: boundedInteger(input.timeout, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS),
        rateLimit: boundedInteger(input.rateLimit, DEFAULT_REQUESTS_PER_SECOND, 1, MAX_REQUESTS_PER_SECOND),
        totalRuntime: boundedInteger(input.totalRuntime, DEFAULT_TOTAL_RUNTIME_MS, 30_000, MAX_RUNTIME_MS),
    };
}

function isLikelyVideoUrl(url) {
    return new URL(url).pathname.toLowerCase().startsWith('/videos/');
}

function sameOriginVideoUrl(href, startUrl) {
    try {
        const url = new URL(href, startUrl);
        return url.origin === new URL(startUrl).origin && isLikelyVideoUrl(url.href) ? url.href : null;
    } catch {
        return null;
    }
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

function collectMediaUrls(value, urls = new Set(), depth = 0) {
    if (depth > 6 || urls.size >= 200) return urls;
    if (typeof value === 'string') {
        const url = extractUrl(value);
        if (url && /\.(?:mp4|m3u8)(?:[?#]|$)/i.test(url)) urls.add(url);
        return urls;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectMediaUrls(item, urls, depth + 1);
    } else if (value && typeof value === 'object') {
        for (const item of Object.values(value)) collectMediaUrls(item, urls, depth + 1);
    }
    return urls;
}

function toPlaywrightProxy(proxyUrl) {
    if (!proxyUrl) return undefined;
    const parsed = new URL(proxyUrl);
    const proxy = { server: `${parsed.protocol}//${parsed.host}` };
    if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
    if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
    return proxy;
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

async function extractRecord(page, url, timeout, networkUrls) {
    const pageData = await page.evaluate(() => {
        const stateMediaUrls = new Set();
        const collectStateMedia = (value, depth = 0) => {
            if (depth > 6 || stateMediaUrls.size >= 200) return;
            if (typeof value === 'string') {
                for (const match of value.matchAll(/https?:[^"'\s]+\.(?:mp4|m3u8)(?:[?#][^"'\s]*)?/gi)) stateMediaUrls.add(match[0]);
                return;
            }
            if (Array.isArray(value)) {
                for (const item of value) collectStateMedia(item, depth + 1);
            } else if (value && typeof value === 'object') {
                for (const item of Object.values(value)) collectStateMedia(item, depth + 1);
            }
        };
        for (const name of ['initials', 'initialState', 'videoModel']) {
            if (globalThis[name]) collectStateMedia(globalThis[name]);
        }
        for (const script of document.querySelectorAll('script')) {
            const text = script.textContent?.trim();
            if (!text || text.length > 1_000_000) continue;
            try {
                collectStateMedia(JSON.parse(text));
            } catch {
                collectStateMedia(text);
            }
        }
        const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
            .flatMap((node) => { try { return [JSON.parse(node.textContent)]; } catch { return []; } });
        const readText = (selector) => document.querySelector(selector)?.innerText?.trim() || null;
        const readAttribute = (selector, attribute) => document.querySelector(selector)?.getAttribute(attribute) || null;
        const media = [...document.querySelectorAll('video, video source, source')]
            .map((node) => node.currentSrc || node.src || node.getAttribute('src'))
            .filter(Boolean);
        return {
            title: readText('h1.video-title') || readText('.video-header h1') || readText('h1')
                || readAttribute('meta[property="og:title"]', 'content') || document.title || null,
            description: readAttribute('meta[name="description"]', 'content')
                || readText('.video-description') || readText('.description-text') || null,
            thumbnail: readAttribute('meta[property="og:image"]', 'content')
                || readAttribute('meta[name="twitter:image"]', 'content')
                || readAttribute('link[rel="image_src"]', 'href') || null,
            media,
            stateMediaUrls: [...stateMediaUrls],
            jsonLd,
        };
    });

    const stateMediaUrls = pageData.stateMediaUrls;
    const jsonLdMediaUrls = collectMediaUrls(pageData.jsonLd);
    const allCandidateUrls = [
        ...pageData.media,
        ...networkUrls,
        ...stateMediaUrls,
        ...jsonLdMediaUrls,
    ].map(extractUrl).filter(Boolean);

    return {
        status: 'succeeded',
        url,
        title: pageData.title,
        description: pageData.description,
        thumbnail: extractUrl(pageData.thumbnail),
        mp4Url: chooseMediaUrl(allCandidateUrls, /\.mp4(?:$|[?#])/i),
        hlsUrl: chooseMediaUrl(allCandidateUrls, /\.m3u8(?:$|[?#])/i),
        extractedAt: new Date().toISOString(),
        timeout,
    };
}

async function addNetworkCapture(page) {
    const networkUrls = new Set();
    const httpErrors = [];
    const capture = (request) => networkUrls.add(request.url());
    const captureResponse = (response) => {
        networkUrls.add(response.url());
        if (response.status() >= 400) httpErrors.push({ url: response.url(), status: response.status() });
    };
    page.on('request', capture);
    page.on('response', captureResponse);
    return { networkUrls, httpErrors, dispose: () => { page.off('request', capture); page.off('response', captureResponse); } };
}

/*
 * Kept below only as a compatibility marker for older generated builds.
 * The active extraction path is extractRecord above.
 */
async function extractRecordLegacy(page, url, timeout) {
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
    log.warning(`[${status}] ${url}: ${String(error?.message || error).split('\n')[0]}`);
    await Actor.pushData({ status, url, error: String(error?.message || error), extractedAt: new Date().toISOString() });
}

async function logPageDiagnostics(page, url, phase, capture) {
    const diagnostics = await page.evaluate(() => {
        const text = document.body?.innerText || '';
        const lowerText = text.toLowerCase();
        return {
            title: document.title || null,
            anchors: document.querySelectorAll('a[href]').length,
            videoLinks: [...document.querySelectorAll('a[href]')]
                .filter((anchor) => new URL(anchor.href, location.href).pathname.startsWith('/videos/')).length,
            ageVerification: /age verification|are you 18|older than 18|over 18|confirm your age/i.test(text),
            loginWall: /log in|login|sign in|signin|sign up|signup|create account|register/i.test(lowerText),
            sessionIssue: /session expired|session lost|enable cookies|cookies required|verification required/i.test(lowerText),
        };
    }).catch((error) => ({ diagnosticError: error.message }));
    const httpErrors = capture.httpErrors.slice(-10);
    const issueLabels = [];
    if (diagnostics.ageVerification) issueLabels.push('age-verification');
    if (diagnostics.loginWall) issueLabels.push('login-or-signup-wall');
    if (diagnostics.sessionIssue) issueLabels.push('session-or-cookie-issue');
    if (httpErrors.length) issueLabels.push('http-errors');
    const message = `[${phase}] ${url} title=${JSON.stringify(diagnostics.title)} anchors=${diagnostics.anchors ?? 'unknown'} videoLinks=${diagnostics.videoLinks ?? 'unknown'} issues=${issueLabels.join(',') || 'none'}`;
    if (issueLabels.length) log.warning(message, { httpErrors });
    else log.info(message);
    if (diagnostics.diagnosticError) log.warning(`[${phase}] page diagnostics failed for ${url}: ${diagnostics.diagnosticError}`);
    return diagnostics;
}

async function navigatePage(page, url, timeout) {
    await page.goto(url, { waitUntil: 'commit', timeout });
    await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeout, 10_000) }).catch(() => {});
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
        browser = await chromium.launch({ headless: true, proxy: toPlaywrightProxy(proxyUrl) });
        const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
        const page = await context.newPage();
        const startCapture = await addNetworkCapture(page);
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
        const discoveredUrls = new Set();
        let startBlocked = false;
        let startFailed = false;
        let anchorCount = 0;

        try {
            let loaded = false;
            let lastError;
            for (let attempt = 0; attempt <= MAX_RETRIES && !loaded; attempt += 1) {
                if (attempt > 0) await sleep(Math.min(input.timeout, 1_000 * 2 ** attempt));
                try {
                    await beforeRequest(page);
                    await navigatePage(page, input.startUrl, input.timeout);
                    loaded = true;
                } catch (error) {
                    lastError = error;
                }
            }
            if (!loaded) throw lastError;
            const startDiagnostics = await logPageDiagnostics(page, input.startUrl, 'start-page', startCapture);
            const ageStatus = await detectAndHandleAgeVerification(page);
            if (startDiagnostics.ageVerification) log.info(`[age-verification] detected on start page; action=${ageStatus}`);
            if (ageStatus === 'blocked') {
                startBlocked = true;
                await saveFailure(input.startUrl, 'blocked', new Error('Age verification requires an unavailable continuation control.'));
            } else {
                await page.waitForSelector('a[href*="/videos/"]', { state: 'attached', timeout: Math.min(input.timeout, 15_000) }).catch(() => {});
                const links = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) => anchor.href));
                anchorCount = links.length;
                for (const link of links) {
                    if (discoveredUrls.size >= input.maxItems) break;
                    const detailUrl = sameOriginVideoUrl(link, input.startUrl);
                    if (detailUrl) discoveredUrls.add(detailUrl);
                }
            }
        } catch (error) {
            startFailed = true;
            await saveFailure(input.startUrl, error.status || 'failed', error);
        } finally {
            startCapture.dispose();
            await page.close().catch(() => {});
        }

        const urls = startBlocked || startFailed ? [] : [...discoveredUrls].slice(0, input.maxItems);
        if (urls.length === 0 && !startBlocked && !startFailed) {
            await saveFailure(input.startUrl, 'no_video_pages', new Error(`No /videos/ detail pages were discovered from the start URL; found ${anchorCount} anchors.`));
        }
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
                    const workerCapture = await addNetworkCapture(workerPage);
                    workerPage.setDefaultTimeout(input.timeout);
                    workerPage.setDefaultNavigationTimeout(input.timeout);
                    try {
                        await beforeRequest(workerPage);
                        await navigatePage(workerPage, url, input.timeout);
                        const detailDiagnostics = await logPageDiagnostics(workerPage, url, 'detail-page', workerCapture);
                        const ageStatus = await detectAndHandleAgeVerification(workerPage);
                        if (detailDiagnostics.ageVerification) log.info(`[age-verification] detected on detail page; url=${url} action=${ageStatus}`);
                        if (ageStatus === 'blocked') {
                            const blockedError = new Error('Age verification requires an unavailable continuation control.');
                            blockedError.status = 'blocked';
                            throw blockedError;
                        }
                        await Actor.pushData(await extractRecord(workerPage, url, input.timeout, workerCapture.networkUrls));
                        completed = true;
                    } catch (error) {
                        if (error.status === 'blocked' || attempt === MAX_RETRIES) {
                            await saveFailure(url, error.status || 'failed', error);
                        }
                    } finally {
                        workerCapture.dispose();
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