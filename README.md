# Video Metadata Playwright Actor

This is a new JavaScript Actor using Playwright and the Apify SDK. It runs headless with one Chromium process, one context, and sequential processing by default. It uses Apify Proxy, bounded retries, a bounded URL list, a total-runtime deadline, and immediate Dataset writes.

It extracts title, description, thumbnail, directly exposed MP4 URLs, and HLS URLs from permitted DOM metadata, JSON-LD, valid inline JSON state, and ordinary resource entries. It excludes obvious thumbnail, trailer, advertising, and promotional URLs. It never converts HLS to MP4 and does not bypass DRM, CAPTCHA, login, age restrictions, paywalls, or other access controls. A detected age-verification prompt is handled only by clicking an explicit older-than-18, over-18, or Enter control; an unhandled prompt is recorded as a normal failure.

## Local test

Install dependencies and run a syntax check without crawling:

```sh
npm install
npm run check
```

The exact command to start a local Actor run is:

```sh
APIFY_DEFAULT_DATASET_ID=local-dataset APIFY_LOCAL_STORAGE_DIR=./storage npm start
```

Provide input through Apify local storage or the Apify Console. The default crawl is limited to five pages and waits 3 seconds between requests. `npm start` starts crawling; `npm run check` does not.