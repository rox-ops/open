# Apify Video Metadata Actor: From-Scratch Prompt and Process

यह दस्तावेज़ किसी coding agent की मदद से JavaScript, Playwright और Apify SDK वाला नया Actor बनाने के लिए है।

## 1. Copy-paste निर्माण Prompt

```text
Create a new Apify Actor from scratch using JavaScript, Playwright, and the Apify SDK.
Do not convert, copy, or depend on an existing scraper project.

The Actor must:

1. Run Playwright headless by default.
2. Use one Chromium browser process and one browser context by default.
3. Use Apify Proxy through Actor.createProxyConfiguration().
4. Pass the proxy server, username, and password explicitly to Playwright when credentials are provided.
5. Accept these input fields:
   - startUrl
   - maxItems
   - concurrency
   - timeout
   - rateLimit
   - totalRuntime
6. Use these defaults and bounds:
   - maxItems: 5, maximum 100
   - concurrency: 2, maximum 4
   - timeout: 30000 milliseconds, maximum 120000
   - rateLimit: 5 requests per second, allowed range 1-5
   - totalRuntime: 600000 milliseconds, maximum 1800000
7. Enforce the global rate limit across all workers. Do not let concurrency bypass it.
8. Use bounded retries only. Never create an infinite browser relaunch or retry loop.
9. Set navigation, page-operation, and total-runtime deadlines.
10. Change the User-Agent before every navigation.
11. Use an exclusive single-instance lock so two local Actor instances cannot crawl simultaneously.
12. Save every successful record immediately to the Apify Dataset.
13. Close pages, the browser context, the browser, listeners, and lock resources in finally blocks.
14. Handle SIGTERM, SIGINT, and Apify shutdown gracefully.
15. Prevent unbounded queues, memory growth, and unlimited URL collection.

Start-page behavior:

16. Open startUrl first.
17. If the start page is a search or listing page, collect only same-origin links whose pathname starts with /videos/.
18. Deduplicate links and stop collecting after maxItems.
19. Never save the search/listing page as a successful video record.
20. Reuse the same browser context for detail pages so permitted cookies and session state persist.
21. Log the number of anchors and discovered detail URLs.

Metadata extraction:

22. Extract title in this order:
   - h1.video-title
   - .video-header h1
   - h1
   - meta[property="og:title"]
23. Extract description from:
   - meta[name="description"]
   - .video-description
   - .description-text
24. Extract thumbnail from:
   - meta[property="og:image"]
   - meta[name="twitter:image"]
   - link[rel="image_src"]
25. Collect directly exposed media URLs from video/source DOM elements,
    permitted page state, JSON-LD, inline scripts, and ordinary network
    request/response URLs.
26. Accept directly exposed .mp4 and .m3u8 URLs.
27. Never convert HLS to MP4.
28. Exclude URLs containing thumbnail, poster, trailer, teaser, advert, ad,
    banner, logo, promo, or promotional indicators.
29. Deduplicate media URLs.

Access and failure handling:

30. Detect age-verification pages.
31. If an explicit permitted control says “I am older than 18”, “I am over 18”,
    or equivalent continuation, click it and continue.
32. If no permitted continuation control exists, do not bypass the restriction;
    save a record with status=blocked.
33. Detect and log login/signup walls, cookie/session issues, HTTP errors,
    empty search results, navigation timeouts, and extraction failures.
34. Save failed or blocked URLs with clear status fields and an error message.
35. Never bypass DRM, CAPTCHA, login, age restrictions, paywalls, or other
    access controls.
36. Do not log proxy credentials, cookies, authorization headers, or full page text.

Project files:

37. Include:
   - src/main.js
   - actor.json
   - input_schema.json
   - package.json
   - package-lock.json
   - Dockerfile
   - README.md
38. Add npm scripts for start and check.
39. Before crawling, run:
   - node --check src/main.js
   - JSON parsing/schema validation for input_schema.json
40. Provide exact local install, validation, and run commands.
41. Add focused tests or deterministic helper checks for input normalization,
    same-origin /videos/ filtering, rate-limit bounds, and media URL filtering.
42. Keep the code type-safe where applicable, explicit about errors, and
    consistent with the Apify SDK and Playwright APIs.
```

## 2. Suggested input

```json
{
  "startUrl": "https://example.com/search/videos",
  "maxItems": 5,
  "concurrency": 2,
  "timeout": 30000,
  "rateLimit": 5,
  "totalRuntime": 600000
}
```

### Input fields का अर्थ

| Field | Recommended default | अर्थ |
|---|---:|---|
| `startUrl` | — | Search/listing page या सीधे detail page का URL |
| `maxItems` | `5` | अधिकतम कितने detail pages process करने हैं |
| `concurrency` | `2` | एक समय में कितने detail pages parallel चल सकते हैं |
| `timeout` | `30000` | एक navigation/page operation की अधिकतम अवधि, milliseconds |
| `rateLimit` | `5` | सभी workers के लिए कुल requests per second |
| `totalRuntime` | `600000` | पूरे Actor run की अधिकतम अवधि, milliseconds |

`timeout` एक page पर लागू होता है, जबकि `totalRuntime` पूरे crawl पर। उदाहरण के लिए `timeout=30000` और `totalRuntime=600000` का अर्थ है कि एक page को 30 seconds से अधिक नहीं मिलेगा और पूरा Actor 10 minutes से अधिक नहीं चलेगा।

## 3. Actor का step-by-step process

1. Actor input पढ़ता है और हर numeric value को सुरक्षित सीमा में normalize करता है।
2. Actor exclusive lock लेता है ताकि उसी environment में दूसरा instance न चले।
3. Shutdown handlers register किए जाते हैं ताकि SIGTERM, SIGINT या Apify shutdown पर नए काम रुकें।
4. Apify Proxy configuration बनाई जाती है और Playwright के लिए proxy settings तैयार की जाती हैं।
5. Headless Chromium का एक browser और एक browser context launch किया जाता है।
6. Start page खोला जाता है। Navigation timeout और total-runtime deadline दोनों लागू रहते हैं।
7. Start page पर age verification, login wall, HTTP error और session/cookie संकेत log किए जाते हैं।
8. यदि यह listing/search page है, तो anchors पढ़कर केवल same-origin `/videos/` URLs रखे जाते हैं।
9. URLs deduplicate किए जाते हैं और queue को `maxItems` पर सीमित किया जाता है।
10. Search page को dataset में video record के रूप में save नहीं किया जाता।
11. `concurrency` के अनुसार detail-page workers शुरू होते हैं। Default `2` है और maximum `4` है।
12. हर worker shared global rate gate से गुजरता है। `rateLimit=5` पर सभी workers मिलाकर लगभग 5 requests/second से अधिक नहीं जाते।
13. हर detail URL उसी browser context में खोला जाता है, जिससे permitted cookies और session state reuse होती है।
14. Page metadata, DOM media, JSON-LD, page state, inline scripts और सामान्य network URLs inspect किए जाते हैं।
15. सीधे उपलब्ध `.mp4` और `.m3u8` URLs रखे जाते हैं; trailer, poster, thumbnail और promotional URLs हटाए जाते हैं।
16. सफल record तुरंत Dataset में push किया जाता है, इसलिए बाद की failure से पहले का data नहीं खोता।
17. Navigation या extraction failure पर bounded retries किए जाते हैं।
18. Retry समाप्त होने पर URL को `failed`, `blocked`, `http-error` या उपयुक्त status के साथ save किया जाता है।
19. हर detail page और network listener `finally` block में बंद किया जाता है।
20. सभी workers समाप्त होने पर context और browser बंद होते हैं, lock release होता है और Actor cleanly exit करता है।

## 4. Recommended performance settings

पहले यह configuration चलाएँ:

```json
{
  "concurrency": 2,
  "rateLimit": 5,
  "timeout": 30000,
  "totalRuntime": 600000
}
```

यदि CPU, memory, proxy और target site stable रहें, तो `concurrency` को `4` तक बढ़ाया जा सकता है। Concurrency बढ़ाने से pages parallel process होंगे, लेकिन global `rateLimit` फिर भी लागू रहेगा। बहुत अधिक concurrency से CPU/RAM usage, proxy throttling और target-site errors बढ़ सकते हैं।

## 5. Local validation and run

Dependencies install करें:

```sh
npm install
```

Syntax और schema validation चलाएँ:

```sh
npm run check
node -e "JSON.parse(require('fs').readFileSync('input_schema.json', 'utf8')); console.log('schema valid')"
```

Local Actor run:

```sh
APIFY_DEFAULT_DATASET_ID=local-dataset \
APIFY_LOCAL_STORAGE_DIR=./storage \
npm start
```

Actor Console में deploy करने से पहले `input_schema.json`, proxy access, dataset storage और configured branch की जाँच करें।

