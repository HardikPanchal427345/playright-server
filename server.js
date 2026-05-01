const express = require("express");
const { chromium } = require("playwright");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MAX_HTML_BYTES = Number(process.env.MAX_HTML_BYTES || 1_000_000); // 1MB default
const DEFAULT_VIEWPORT_WIDTH = Number(process.env.DEFAULT_VIEWPORT_WIDTH || 1280);
const DEFAULT_VIEWPORT_HEIGHT = Number(process.env.DEFAULT_VIEWPORT_HEIGHT || 720);
const DEFAULT_TIMEOUT_MS = Number(process.env.DEFAULT_TIMEOUT_MS || 25_000);
const DEFAULT_WAIT_AFTER_MS = Number(process.env.DEFAULT_WAIT_AFTER_MS || 0);
/** Large viewport used only to measure intrinsic document size (auto width/height). */
const MEASURE_VIEWPORT_WIDTH = Number(process.env.MEASURE_VIEWPORT_WIDTH || 4096);
const MEASURE_VIEWPORT_HEIGHT = Number(process.env.MEASURE_VIEWPORT_HEIGHT || 4096);
const MAX_AUTO_DIMENSION = Number(process.env.MAX_AUTO_DIMENSION || 4096);
const MIN_AUTO_DIMENSION = Number(process.env.MIN_AUTO_DIMENSION || 1);

app.disable("x-powered-by");

/** Allow browser clients (e.g. Angular) to POST JSON. */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use(
  express.json({
    limit: MAX_HTML_BYTES,
    type: ["application/json", "application/*+json"],
  }),
);

/**
 * POST /screenshot
 * Body:
 *  - html (string, required)
 *  - width (number, optional)
 *  - height (number, optional)
 *  - autoSize (boolean, optional): when true, ignore width/height and fit viewport to content
 *  - deviceScaleFactor (number, optional)
 *  - fullPage (boolean, optional): ignored when viewport is fitted to content; default true when both width and height are fixed)
 *  - type ("png" | "jpeg", optional, default "png")
 *  - quality (number 0-100, optional, jpeg only)
 *  - timeoutMs (number, optional)
 *  - waitAfterMs (number, optional) additional delay after render
 *  - background ("transparent" | "white", optional, default "transparent")
 *
 * Response: image bytes (Content-Type image/png or image/jpeg)
 */
app.post("/screenshot", async (req, res) => {
  const {
    html,
    width,
    height,
    autoSize,
    deviceScaleFactor,
    fullPage,
    type = "png",
    quality,
    timeoutMs,
    waitAfterMs,
    background = "transparent",
  } = req.body || {};

  if (typeof html !== "string" || html.trim().length === 0) {
    return res.status(400).json({ error: "`html` (string) is required" });
  }

  const htmlBytes = Buffer.byteLength(html, "utf8");
  if (htmlBytes > MAX_HTML_BYTES) {
    return res.status(413).json({
      error: "`html` too large",
      maxBytes: MAX_HTML_BYTES,
      gotBytes: htmlBytes,
    });
  }

  const widthProvided = Number.isFinite(Number(width)) && Number(width) > 0;
  const heightProvided = Number.isFinite(Number(height)) && Number(height) > 0;
  const useAutoSize = Boolean(autoSize) || (!widthProvided && !heightProvided);

  const clampDimension = (n) =>
    Math.min(Math.max(Math.round(Number(n)) || 0, MIN_AUTO_DIMENSION), MAX_AUTO_DIMENSION);

  const deviceScale =
    Number.isFinite(Number(deviceScaleFactor)) && Number(deviceScaleFactor) > 0
      ? Math.min(Number(deviceScaleFactor), 3)
      : 1;

  const effectiveTimeoutMs =
    Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.min(Number(timeoutMs), 120_000)
      : DEFAULT_TIMEOUT_MS;

  const effectiveWaitAfterMs =
    Number.isFinite(Number(waitAfterMs)) && Number(waitAfterMs) >= 0
      ? Math.min(Number(waitAfterMs), 30_000)
      : DEFAULT_WAIT_AFTER_MS;

  const imageType = type === "jpeg" ? "jpeg" : "png";

  let browser;
  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const initialViewport = useAutoSize
      ? {
          width: clampDimension(MEASURE_VIEWPORT_WIDTH),
          height: clampDimension(MEASURE_VIEWPORT_HEIGHT),
          deviceScaleFactor: deviceScale,
        }
      : widthProvided && heightProvided
        ? {
            width: clampDimension(width),
            height: clampDimension(height),
            deviceScaleFactor: deviceScale,
          }
        : {
            width: widthProvided ? clampDimension(width) : clampDimension(MEASURE_VIEWPORT_WIDTH),
            height: heightProvided ? clampDimension(height) : clampDimension(MEASURE_VIEWPORT_HEIGHT),
            deviceScaleFactor: deviceScale,
          };

    const context = await browser.newContext({
      viewport: { width: initialViewport.width, height: initialViewport.height },
      deviceScaleFactor: initialViewport.deviceScaleFactor,
    });

    const page = await context.newPage();

    page.setDefaultTimeout(effectiveTimeoutMs);
    page.setDefaultNavigationTimeout(effectiveTimeoutMs);

    // Render HTML. Use a data URL to avoid accidental network navigation.
    // We intentionally allow external resources referenced by the HTML (images/fonts),
    // but the caller can inline everything if they want fully offline rendering.
    const bgStyle =
      background === "white"
        ? "html,body{background:#fff !important;}"
        : "html,body{background:transparent !important;}";

    const useTightLayout = useAutoSize || !widthProvided || !heightProvided;
    const tightLayoutCss = useTightLayout
      ? "html,body{margin:0!important;width:max-content!important;height:max-content!important;min-width:0!important;min-height:0!important;box-sizing:border-box!important;}"
      : "";

    const htmlWithBase = injectHeadStyle(html, bgStyle, tightLayoutCss);

    await page.setContent(htmlWithBase, { waitUntil: "load" });

    if (effectiveWaitAfterMs > 0) {
      await sleep(effectiveWaitAfterMs);
    }

    await waitForFonts(page);

    let finalFullPage = fullPage !== undefined ? Boolean(fullPage) : true;
    const preferBodyMeasure = useTightLayout;

    if (useAutoSize) {
      let w = await measureDocumentSize(page, preferBodyMeasure);
      if (w.width < MIN_AUTO_DIMENSION || w.height < MIN_AUTO_DIMENSION) {
        w = { width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT };
      }

      // Explicit autoSize: always fit both axes from the document.
      // Implicit auto (no width/height): allow fixing one axis if the client sent it.
      if (!autoSize && widthProvided && !heightProvided) {
        w = {
          width: clampDimension(width),
          height: clampDimension(w.height),
        };
      } else if (!autoSize && !widthProvided && heightProvided) {
        w = {
          width: clampDimension(w.width),
          height: clampDimension(height),
        };
      } else {
        w = { width: clampDimension(w.width), height: clampDimension(w.height) };
      }

      await page.setViewportSize({ width: w.width, height: w.height });
      await sleep(50);
      await waitForFonts(page);

      const w2 = await measureDocumentSize(page, preferBodyMeasure);
      w = {
        width: clampDimension(Math.max(w.width, w2.width)),
        height: clampDimension(Math.max(w.height, w2.height)),
      };
      await page.setViewportSize({ width: w.width, height: w.height });
      finalFullPage = false;
    } else if (!widthProvided || !heightProvided) {
      const measured = await measureDocumentSize(page, preferBodyMeasure);
      let outW = clampDimension(widthProvided ? width : measured.width);
      let outH = clampDimension(heightProvided ? height : measured.height);
      if (outW < MIN_AUTO_DIMENSION) outW = DEFAULT_VIEWPORT_WIDTH;
      if (outH < MIN_AUTO_DIMENSION) outH = DEFAULT_VIEWPORT_HEIGHT;
      await page.setViewportSize({ width: outW, height: outH });
      await sleep(50);
      await waitForFonts(page);
      const w2 = await measureDocumentSize(page, preferBodyMeasure);
      outW = clampDimension(widthProvided ? width : Math.max(outW, w2.width));
      outH = clampDimension(heightProvided ? height : Math.max(outH, w2.height));
      await page.setViewportSize({ width: outW, height: outH });
      finalFullPage = false;
    }

    const screenshotOptions =
      imageType === "jpeg"
        ? {
            type: "jpeg",
            fullPage: finalFullPage,
            quality:
              Number.isFinite(Number(quality)) && Number(quality) >= 0 && Number(quality) <= 100
                ? Math.round(Number(quality))
                : 85,
          }
        : {
            type: "png",
            fullPage: finalFullPage,
            omitBackground: background !== "white",
          };

    const buf = await page.screenshot(screenshotOptions);

    res.setHeader("Content-Type", imageType === "jpeg" ? "image/jpeg" : "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(buf);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: "screenshot_failed", message });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFonts(page) {
  try {
    await page.evaluate(() => {
      if (document.fonts && document.fonts.ready) {
        return document.fonts.ready;
      }
      return undefined;
    });
  } catch {
    // ignore
  }
}

async function measureDocumentSize(page, preferBody) {
  return page.evaluate((preferBodyInner) => {
    const body = document.body;
    const root = document.documentElement;

    if (preferBodyInner && body) {
      const br = body.getBoundingClientRect();
      const w = Math.max(body.scrollWidth, body.offsetWidth, body.clientWidth, br.width);
      const h = Math.max(body.scrollHeight, body.offsetHeight, body.clientHeight, br.height);
      return { width: Math.ceil(w), height: Math.ceil(h) };
    }

    const w = Math.max(
      body ? body.scrollWidth : 0,
      body ? body.offsetWidth : 0,
      root.scrollWidth,
      root.clientWidth,
      root.offsetWidth,
    );
    const h = Math.max(
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      root.scrollHeight,
      root.clientHeight,
      root.offsetHeight,
    );
    return { width: Math.ceil(w), height: Math.ceil(h) };
  }, preferBody);
}

function injectHeadStyle(html, cssText, extraCss = "") {
  const styleTag = `<style>${cssText}${extraCss ? `\n${extraCss}` : ""}</style>`;
  const headOpen = /<head\b[^>]*>/i;
  const headClose = /<\/head>/i;

  if (headOpen.test(html)) {
    return html.replace(headOpen, (m) => `${m}\n${styleTag}\n`);
  }
  if (headClose.test(html)) {
    return html.replace(headClose, `${styleTag}\n</head>`);
  }

  // No head tag; best-effort injection near top.
  return `<!doctype html><html><head>${styleTag}</head><body>${html}</body></html>`;
}

app.listen(PORT, "0.0.0.0", () => {
  // Intentionally minimal logging for Railway; use logs if needed.
  // eslint-disable-next-line no-console
  console.log(`html-screenshot server listening on :${PORT}`);
});

