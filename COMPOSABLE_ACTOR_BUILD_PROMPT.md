# Composable Apify Actor Build Prompt

यह prompt इस तरह बनाया गया है कि आप बाद में अपना custom process अलग से जोड़ सकें। पहले मुख्य prompt paste करें, फिर नीचे दिया गया process block उसी chat में अलग user message के रूप में paste करें।

## 1. Main build prompt

```text
Build a new Apify Actor from scratch using JavaScript, Playwright, and the Apify SDK.

This is a new implementation. Do not convert, copy, or depend on an existing
scraper project unless I explicitly provide a file and ask you to reuse a
specific part.

## Objective

Create a reliable headless browser Actor that starts from `startUrl`, discovers
permitted same-origin video detail pages, extracts publicly exposed metadata and
directly exposed media URLs, and saves structured results to an Apify Dataset.

The Actor must not bypass DRM, CAPTCHA, login, age restrictions, paywalls, or
any other access control.

## Required inputs

Create and validate these input fields in `input_schema.json`:

- `startUrl`: required string
- `maxItems`: integer, default 5, range 1-100
- `concurrency`: integer, default 2, range 1-4
- `timeout`: integer milliseconds, default 30000, range 1000-120000
- `rateLimit`: integer requests/second, default 5, range 1-5
- `totalRuntime`: integer milliseconds, default 600000, range 30000-1800000

Normalize runtime input defensively. Never allow an invalid input to create an
unbounded queue, retry loop, or runtime.

## Browser and lifecycle

- Run Playwright headless by default.
- Launch one Chromium process and one browser context by default.
- Use `Actor.createProxyConfiguration()` and pass proxy settings explicitly to
  Playwright when available.
- Change the User-Agent before every navigation.
- Use an exclusive single-instance lock.
- Register SIGTERM, SIGINT, and Apify shutdown handling.
- Close pages, listeners, context, browser, and lock resources in `finally`
  blocks.
- Use bounded retries only; never relaunch or retry forever.

## Rate limit and concurrency

- Enforce one global rate gate shared by every worker.
- `concurrency` may process detail pages in parallel, but it must never bypass
  the global `rateLimit`.
- Use `concurrency=2` and `rateLimit=5` as the normal balanced configuration.
- Stop starting work after the total-runtime deadline.

## Discovery

- Navigate to `startUrl` first.
- If it is a search or listing page, collect only same-origin URLs whose
  pathname starts with `/videos/`.
- Deduplicate URLs and cap the queue at `maxItems`.
- Do not save the search/listing page as a successful video record.
- Reuse the same browser context for detail pages so permitted cookies and
  session state persist.

## Extraction

Extract title in this order:
1. `h1.video-title`
2. `.video-header h1`
3. `h1`
4. `meta[property="og:title"]`

Extract description from:
- `meta[name="description"]`
- `.video-description`
- `.description-text`

Extract thumbnail from:
- `meta[property="og:image"]`
- `meta[name="twitter:image"]`
- `link[rel="image_src"]`

Collect directly exposed `.mp4` and `.m3u8` URLs from video/source DOM
elements, permitted page state, JSON-LD, inline scripts, and ordinary network
request/response URLs. Deduplicate them. Never convert HLS to MP4.

Exclude URLs that are clearly thumbnails, posters, trailers, teasers,
advertisements, banners, logos, or promotional media.

## Access and errors

- Detect age-verification pages.
- Click only an explicit permitted continuation control such as “I am older
  than 18” or “I am over 18”.
- If no permitted continuation exists, save `status=blocked`; do not bypass it.
- Detect and log login/signup walls, cookie/session issues, HTTP errors, empty
  search results, timeouts, and extraction errors.
- Save failed or blocked URLs with a clear status and safe error message.
- Never log passwords, proxy credentials, cookies, authorization headers, or
  full page text.

## Persistence and project files

- Push every successful record immediately to the Apify Dataset.
- Include `src/main.js`, `actor.json`, `input_schema.json`, `package.json`,
  `package-lock.json`, `Dockerfile`, and `README.md`.
- Add `npm start` and `npm run check` scripts.
- Document installation, validation, local execution, inputs, output shape,
  limits, and access-control behavior.
- Add focused deterministic tests or helper checks for input normalization,
  same-origin `/videos/` filtering, rate-limit bounds, and media filtering.

## Validation and implementation rules

Before crawling, run a JavaScript syntax check and JSON/schema validation.
Use explicit error handling, preserve type safety, follow existing project
conventions where applicable, and make precise changes only.

When this prompt is complete, do not start coding until all later optional
process instructions have been read. Later process instructions may add
domain-specific workflow details, but they must not weaken, remove, or
contradict the safety, lifecycle, rate-limit, validation, and persistence
requirements above. If a later instruction conflicts with this prompt, keep
this prompt's requirements and clearly report the conflict before coding.
```

## 2. Optional process block to paste later

इस block को आप अपनी जरूरत के अनुसार बदल सकते हैं। इसे main prompt के बाद
अलग user message के रूप में paste करें।

```text
## Additional actor process

Apply the following process to the Actor while preserving every requirement
from the main build prompt:

### Input and start page

1. Read and normalize the Actor input.
2. [Describe any custom start-page behavior here.]
3. [Describe which links or page types may be discovered here.]

### Detail-page workflow

4. [Describe how each discovered detail URL should be opened.]
5. [Describe any permitted session or cookie reuse.]
6. [Describe any additional page states that must be detected.]

### Data extraction

7. [Describe additional fields, selectors, or public data sources.]
8. [Describe any output field names or required record shape.]
9. [Describe any media inclusion/exclusion rules.]

### Retry and failure behavior

10. [Describe domain-specific retry conditions.]
11. [Describe statuses that should be saved.]
12. [Describe diagnostics that should be logged without exposing secrets.]

### Completion

13. [Describe any final dataset, summary, or shutdown requirements.]

Before implementing, convert these additional process instructions into a
short implementation checklist. Preserve the main prompt's safety boundaries,
global rate limit, bounded retries, total-runtime deadline, cleanup rules,
immediate Dataset writes, and validation requirements. If any placeholder is
left unchanged, ignore it rather than inventing behavior.
```

## 3. How to combine them safely

1. Coding agent को पूरा **Main build prompt** भेजें।
2. उसके बाद **Optional process block** की copy भेजें।
3. Bracket वाले placeholders को अपने वास्तविक process से बदलें।
4. Agent से पहले implementation checklist और conflicts की सूची दिखाने को कहें।
5. Checklist में कोई conflict न हो तो ही coding शुरू करवाएँ।
6. अगर process में कोई नई requirement हो, तो उसे “Additional actor process”
   के अंतर्गत रखें; main prompt के मूल sections को delete न करें।

## 4. Example custom process

नीचे केवल format का उदाहरण है:

```text
## Additional actor process

Apply the following process to the Actor while preserving every requirement
from the main build prompt:

### Input and start page

1. Open the configured search page.
2. Wait for the first batch of result anchors, then collect same-origin
   `/videos/` links until `maxItems` is reached.

### Detail-page workflow

3. Process detail URLs with the configured worker pool.
4. Open each detail URL in the shared browser context.

### Data extraction

5. Save `url`, `title`, `description`, `thumbnail`, `mp4Urls`, and `hlsUrls`.

### Retry and failure behavior

6. Retry navigation failures only within the bounded retry limit.
7. Save blocked pages with `status=blocked` and failed pages with
   `status=failed`.

### Completion

8. Push each record immediately and close all resources before exit.

Before implementing, convert these additional process instructions into a
short implementation checklist. Preserve the main prompt's safety boundaries,
global rate limit, bounded retries, total-runtime deadline, cleanup rules,
immediate Dataset writes, and validation requirements.
```

## 5. Recommended commands

```sh
npm install
npm run check
node -e "JSON.parse(require('fs').readFileSync('input_schema.json', 'utf8')); console.log('schema valid')"
APIFY_DEFAULT_DATASET_ID=local-dataset APIFY_LOCAL_STORAGE_DIR=./storage npm start
```

