# Apify Video Metadata Actor

यह दस्तावेज़ इस Actor को दोबारा बनाने और Apify पर चलाने के लिए है। Actor केवल publicly exposed metadata और normal browser/network responses inspect करता है। यह DRM, CAPTCHA, login, age restrictions, paywalls या किसी अन्य access control को bypass नहीं करता।

## 1. निर्माण Prompt

नीचे वाला prompt किसी coding agent को देकर इसी प्रकार का नया Actor बनाया जा सकता है:

```text
Create a new Apify Actor from scratch using JavaScript, Playwright, and the Apify SDK. Do not convert or reuse an existing scraper project.

Requirements:

- Run Playwright headless by default.
- Use Apify Proxy through Actor.createProxyConfiguration().
- Pass proxy server, username, and password explicitly to Playwright.
- Accept startUrl, maxItems, concurrency, timeout, rateLimit, and totalRuntime as Actor input.
- Use one browser process and one browser context by default.
- Use sequential concurrency = 1 by default.
- Add an exclusive single-instance lock.
- Use bounded retries only. Never use an infinite browser relaunch loop.
- Set navigation, page, and total-runtime timeouts.
- Limit the default crawl to 5 video pages.
- Interpret rateLimit as 1 or 2 requests per second and enforce it globally.
- Change the User-Agent before every navigation.
- Save every successful record immediately to the Apify Dataset.
- Handle a search/listing start page by collecting only same-origin links whose pathname starts with /videos/.
- Do not save the search page itself as a successful video record.
- Reuse the same browser context for detail pages so cookies and verification session persist.
- Extract title using h1.video-title, .video-header h1, h1, then og:title.
- Extract description using meta[name="description"], .video-description, and .description-text.
- Extract thumbnail using og:image, twitter:image, and link[rel="image_src"].
- Inspect video/source DOM elements, window.initials, window.initialState, window.videoModel, JSON-LD, inline scripts, and normal request/response URLs for MP4 and HLS URLs.
- Accept directly exposed .mp4 URLs and .m3u8 URLs. Never convert HLS to MP4.
- Exclude thumbnail, poster, trailer, teaser, advertisement, banner, logo, and promotional media URLs.
- Detect age-verification pages. If an explicit permitted “I am older than 18”, “I am over 18”, or equivalent continuation control exists, click it; otherwise record status=blocked. Do not bypass access restrictions.
- Detect and log login/signup walls, session/cookie issues, HTTP errors, empty search results, navigation timeouts, and extraction errors.
- Save failures and blocked URLs with clear status fields.
- Close pages, contexts, and the browser in finally blocks.
- Handle SIGTERM, SIGINT, and Apify shutdown gracefully.
- Prevent unbounded memory growth and unlimited queues.
- Include actor.json, input_schema.json, package.json, package-lock.json, Dockerfile, README.md, and local test instructions.
- Before crawling, run a JavaScript syntax check and JSON schema validation. Provide the exact run command.
```

## 2. Repository तैयार करना

1. GitHub repository में Actor files रखें:

   - `src/main.js`
   - `actor.json`
   - `input_schema.json`
   - `package.json`
   - `package-lock.json`
   - `Dockerfile`
   - `README.md`

2. `package.json` में dependencies install करें:

   ```sh
   npm install
   ```

3. Local validation चलाएं:

   ```sh
   npm run check
   node -e "JSON.parse(require('fs').readFileSync('input_schema.json', 'utf8')); console.log('schema valid')"
   ```

4. Changes commit करके GitHub की configured branch, सामान्यतः `main`, पर push करें।

## 3. Apify Actor बनाना

1. Apify Console खोलें।
2. **Actors** में जाकर **Create new Actor** चुनें।
3. GitHub repository connect करें।
4. Repository और branch `main` चुनें।
5. Build/deploy शुरू करें। Apify `actor.json`, `Dockerfile` और `input_schema.json` पढ़ेगा।
6. Build सफल होने के बाद **Input** tab खोलें।

## 4. Input भरना

उदाहरण input:

```json
{
  "startUrl": "https://xhamster19.com/search/hot+milf",
  "maxItems": 5,
  "concurrency": 1,
  "timeout": 60000,
  "rateLimit": 1,
  "totalRuntime": 600000
}
```

Input fields:

| Field | Default | काम |
|---|---:|---|
| `startUrl` | xHamster search URL | Search/listing page जहां से `/videos/` links मिलते हैं |
| `maxItems` | `5` | अधिकतम detail pages |
| `concurrency` | `1` | एक समय में चलने वाले detail pages |
| `timeout` | `30000` | Navigation/page timeout, milliseconds में |
| `rateLimit` | `1` | Global rate: केवल `1` या `2` requests per second |
| `totalRuntime` | `600000` | कुल runtime limit, milliseconds में |

`startUrl` को Input tab के Start URL box में डालना होता है। Input में दिया हुआ URL code के default URL को override करता है।

## 5. Proxy setup

1. Actor run के लिए Apify Proxy access enabled रखें।
2. Actor में `Actor.createProxyConfiguration()` से configuration बनाई जाती है।
3. Proxy URL को Playwright के `server`, `username`, और `password` fields में अलग-अलग pass किया जाता है।
4. हर navigation से पहले User-Agent बदला जाता है।
5. Proxy credentials को logs या Dataset में लिखना नहीं चाहिए।

अगर log में यह आए:

```text
407 Proxy Authentication Required
```

तो Apify account/Actor में Proxy access, available proxy group, और proxy credentials की जांच करें। यह target page का metadata error नहीं, proxy authentication error है।

## 6. Actor का runtime flow

1. Actor SDK initialize होता है और exclusive lock लिया जाता है।
2. Headless Chromium का एक browser process launch होता है।
3. एक browser context बनाया जाता है।
4. Apify Proxy configuration और rotating proxy URL तैयार होता है।
5. Start page पर User-Agent लगाया जाता है।
6. Search page navigate होती है। Navigation `commit` पर आगे बढ़ती है और DOM के लिए bounded wait होता है।
7. Age-verification prompt detect होता है। Explicit permitted continuation control मिलने पर click होता है; अन्यथा `blocked` record बनता है।
8. Search page से anchors पढ़े जाते हैं। केवल same-origin pathname `/videos/` से शुरू होने वाले URLs रखे जाते हैं।
9. Search page को video result के रूप में save नहीं किया जाता।
10. हर detail URL उसी browser context में खोला जाता है, इसलिए cookies/session reuse होते हैं।
11. Detail page पर title, description और thumbnail selectors से metadata निकाला जाता है।
12. DOM media, page state, JSON-LD, inline scripts और network request/response URLs से `.mp4` और `.m3u8` URLs collect होते हैं।
13. Trailer, thumbnail, poster, advertisement और promotional URLs हटाए जाते हैं।
14. Successful record तुरंत Dataset में push होता है।
15. Retry count bounded रहता है और हर page finally block में बंद होता है।
16. Shutdown signal मिलने पर new work रोककर browser/context cleanup होता है।

## 7. Output उदाहरण

Successful record:

```json
{
  "status": "succeeded",
  "url": "https://example.com/videos/example",
  "title": "Example title",
  "description": "Example description",
  "thumbnail": "https://cdn.example.com/image.jpg",
  "mp4Url": "https://cdn.example.com/video.mp4",
  "hlsUrl": "https://cdn.example.com/video.m3u8",
  "extractedAt": "2026-10-03T00:00:00.000Z",
  "timeout": 60000
}
```

Failure or blocked record:

```json
{
  "status": "blocked",
  "url": "https://example.com/videos/example",
  "error": "Age verification requires an unavailable continuation control.",
  "extractedAt": "2026-10-03T00:00:00.000Z"
}
```

## 8. Logs समझना

Useful diagnostic log labels:

- `start-page`: search page title, anchor count और discovered video-link count।
- `detail-page`: detail page का title और HTTP issues।
- `age-verification`: age prompt detected और action।
- `login-or-signup-wall`: login/signup wall detected।
- `session-or-cookie-issue`: session या cookies से जुड़ा संकेत।
- `http-errors`: page/network response में HTTP error status।
- `no_video_pages`: search page से कोई `/videos/` link नहीं मिला।
- `failed`: bounded retries के बाद navigation या extraction failure।

उदाहरण:

```text
[start-page] ... anchors=226 videoLinks=54 issues=none
```

अगर यह दिखे:

```text
anchors=0 videoLinks=0
```

तो browser को results वाला HTML नहीं मिला। Proxy block, age wall, login wall, anti-bot response या delayed rendering check करें।

## 9. Local commands

Syntax check, crawl शुरू नहीं करता:

```sh
npm run check
```

Local Actor run:

```sh
APIFY_DEFAULT_DATASET_ID=local-dataset APIFY_LOCAL_STORAGE_DIR=./storage npm start
```

`npm start` वास्तविक crawl शुरू करता है। पहले `npm run check` चलाना recommended है।