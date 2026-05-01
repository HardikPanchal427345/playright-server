## HTML Screenshot Service (Railway)

This is a small HTTP service that accepts **raw HTML** and returns a **rendered screenshot** using Playwright (Chromium) in headless mode.

### Endpoints

- `GET /health` → `{ ok: true }`
- `POST /screenshot` → returns `image/png` (default) or `image/jpeg`

### Request body

```json
{
  "html": "<!doctype html><html>...</html>",
  "width": 1280,
  "height": 720,
  "autoSize": false,
  "deviceScaleFactor": 1,
  "fullPage": true,
  "type": "png",
  "quality": 85,
  "timeoutMs": 25000,
  "waitAfterMs": 0,
  "background": "transparent"
}
```

Notes:
- `html` is required.
- **Width / height**
  - Omit both `width` and `height`: the server **measures the rendered document** (scroll size), clamps it, resizes the viewport, and screenshots with **`fullPage: false`** so the image matches the HTML layout size.
  - Send **only `width`**: height is measured at that width.
  - Send **only `height`**: width is measured at that height.
  - Send **both**: fixed viewport; `fullPage` defaults to **`true`** (scroll capture) unless you set `fullPage: false`.
  - **`autoSize: true`**: always fit to content; any `width` / `height` in the body are ignored.
- `background`:
  - `"transparent"` (default): PNG with transparent background (`omitBackground: true`)
  - `"white"`: forces a white background (useful for JPEG or when you want no transparency)

### Local run

```bash
cd tempserver
npm install
npm start
```

Test:

```bash
curl -sS -X POST "http://localhost:3000/screenshot" \
  -H "content-type: application/json" \
  -d '{"html":"<!doctype html><html><body style=\"margin:0\"><div style=\"display:inline-block;padding:24px;background:#111;color:#fff;font:600 48px/1 system-ui\">Hello</div></body></html>","type":"png"}' \
  --output out.png
```

### Deploy on Railway

Create a **new Railway service** from this repo and set:

- **Root Directory**: `tempserver`
- **Builder**: Docker (Railway will use `tempserver/Dockerfile`)

Railway will set `PORT` automatically; the server listens on `process.env.PORT`.

### Environment variables

- `MAX_HTML_BYTES` (default `1000000`)
- `DEFAULT_TIMEOUT_MS` (default `25000`)
- `DEFAULT_WAIT_AFTER_MS` (default `0`)
- `DEFAULT_VIEWPORT_WIDTH` (default `1280`)
- `DEFAULT_VIEWPORT_HEIGHT` (default `720`)
- `MEASURE_VIEWPORT_WIDTH` / `MEASURE_VIEWPORT_HEIGHT` (defaults `4096`): viewport used before measuring intrinsic size
- `MAX_AUTO_DIMENSION` (default `4096`), `MIN_AUTO_DIMENSION` (default `1`)

