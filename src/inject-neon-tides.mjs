import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const endpoint = process.argv[2] ?? "http://127.0.0.1:9229";
const cssPath = process.argv[3];
const mediaPath = process.argv[4];
const outputPath = process.argv[5];
const waitSeconds = Number(process.argv[6] ?? 45);
const operation = process.argv[7] ?? "apply";

if (!cssPath || !mediaPath || !outputPath) {
  throw new Error("usage: inject-neon-tides.mjs <endpoint> <css> <background-mp4> <output-json> [wait-seconds]");
}
if (!Number.isFinite(waitSeconds) || waitSeconds < 5 || waitSeconds > 90) {
  throw new Error("wait-seconds must be between 5 and 90");
}
if (!["apply", "verify"].includes(operation)) {
  throw new Error("operation must be apply or verify");
}

const result = {
  schema: 1,
  theme: "Neon Tides",
  operation,
  classification: "NOT_RUN",
  endpoint_seen: false,
  browser_websocket_connected: false,
  discover_supported: false,
  target_count: 0,
  attached_page_count: 0,
  main_target_found: false,
  page_script_registered: false,
  theme_applied: false,
  style_verified: false,
  background_verified: false,
  css_bytes: 0,
  background_bytes: 0,
  background_sha256: null,
  video_chunk_count: 0,
  video_loop_verified: false,
  video_muted_verified: false,
  video_playback_verified: false,
  restore_ok: false,
  error_stage: null,
  error_type: null,
  finished_at: null,
};

function writeResult() {
  result.finished_at = new Date().toISOString();
  const parent = path.dirname(path.resolve(outputPath));
  if (!fs.existsSync(parent)) throw new Error("OUTPUT_PARENT_MISSING");
  const temporary = `${outputPath}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(result), "utf8");
  fs.renameSync(temporary, outputPath);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function validateLoopbackUrl(value, protocol, expectedPort = null) {
  const url = new URL(value);
  const hostOk = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const portOk = expectedPort == null || url.port === expectedPort;
  if (url.protocol !== protocol || !hostOk || !portOk || url.username || url.password) {
    throw new Error("UNEXPECTED_DEBUG_ENDPOINT");
  }
  return url;
}

async function waitForVersion(baseUrl, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/json/version", baseUrl), {
        signal: AbortSignal.timeout(1200),
      });
      if (response.ok) {
        const version = await response.json();
        if (version?.webSocketDebuggerUrl) return version;
      }
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new Error("DEBUG_ENDPOINT_TIMEOUT");
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.targetInfoById = new Map();
    this.sessionByTargetId = new Map();
    this.listeners = new Set();
    this.socket.addEventListener("message", (event) => this.onMessage(event));
    this.socket.addEventListener("close", () => this.onClose());
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WEBSOCKET_OPEN_TIMEOUT")), 5000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("WEBSOCKET_OPEN_FAILED"));
      }, { once: true });
    });
  }

  onMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (Number.isInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`CDP_ERROR:${pending.method}:${message.error.code}:${message.error.message}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method === "Target.targetCreated" || message.method === "Target.targetInfoChanged") {
      this.recordTarget(message.params?.targetInfo);
    } else if (message.method === "Target.attachedToTarget") {
      const info = message.params?.targetInfo;
      this.recordTarget(info);
      if (info?.targetId && message.params?.sessionId) {
        this.sessionByTargetId.set(info.targetId, message.params.sessionId);
      }
    }
    for (const listener of this.listeners) listener();
  }

  onClose() {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`WEBSOCKET_CLOSED:${pending.method}`));
      this.pending.delete(id);
    }
  }

  recordTarget(info) {
    if (info?.targetId) this.targetInfoById.set(info.targetId, info);
  }

  call(method, params = {}, sessionId = undefined, timeout = 4000) {
    const id = this.nextId++;
    const request = { id, method, params };
    if (sessionId) request.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP_TIMEOUT:${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify(request));
    });
  }

  async refreshTargets() {
    const response = await this.call("Target.getTargets", {});
    for (const info of response.targetInfos ?? []) this.recordTarget(info);
  }

  async attach(info) {
    if (!info?.targetId || info.type !== "page") return null;
    const existing = this.sessionByTargetId.get(info.targetId);
    if (existing) return existing;
    try {
      const response = await this.call("Target.attachToTarget", {
        targetId: info.targetId,
        flatten: true,
      });
      if (response.sessionId) {
        this.sessionByTargetId.set(info.targetId, response.sessionId);
        return response.sessionId;
      }
    } catch {
    }
    return null;
  }

  async waitForEvent(milliseconds) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.listeners.delete(onEvent);
        resolve();
      }, milliseconds);
      const onEvent = () => {
        clearTimeout(timer);
        this.listeners.delete(onEvent);
        resolve();
      };
      this.listeners.add(onEvent);
    });
  }

  close() {
    try { this.socket.close(); } catch { }
  }
}

const fingerprintExpression = String.raw`(() => {
  if (typeof document === 'undefined') return null;
  const all = [...document.querySelectorAll('*')];
  return {
    protocol: location.protocol,
    ready: document.readyState,
    total: all.length,
    hasLeft: !!document.querySelector('.app-shell-left-panel, aside.app-shell-left-panel'),
    roleMain: document.querySelectorAll('[role="main"]').length,
    editable: document.querySelectorAll('[contenteditable="true"], textarea').length,
    mainSurface: !!document.querySelector('[class*="_MainContentSurface_"], .main-surface, .browser-main-surface'),
  };
})()`;

function makeInstallExpression(css) {
  return `(() => {
    const STYLE_ID = 'codex-neon-tides-style';
    const ROOT_CLASS = 'codex-neon-tides-active';
    const CLEANUP_KEY = '__codexNeonTidesCleanup';
    try { globalThis[CLEANUP_KEY]?.(); } catch {}
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById('codex-neon-tides-video-layer')?.remove();
    if (globalThis.__codexNeonVideoUrl) {
      try { URL.revokeObjectURL(globalThis.__codexNeonVideoUrl); } catch {}
      delete globalThis.__codexNeonVideoUrl;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.dataset.theme = 'neon-tides';
    style.textContent = ${JSON.stringify(css)};
    (document.head || document.documentElement).append(style);
    const root = document.documentElement;
    root.classList.add(ROOT_CLASS, 'codex-theme-native');
    root.dataset.codexTheme = 'neon-tides';
    let frame = 0;
    const mark = () => {
      frame = 0;
      document.querySelector('[class*="_MainContentSurface_"], main.main-surface, .browser-main-surface')?.classList.add('codex-neon-main');
      document.querySelector('.app-shell-left-panel, aside.app-shell-left-panel')?.classList.add('codex-neon-sidebar');
      document.querySelector('[class*="_ComposerLayoutRoot_"], .composer-surface-chrome')?.classList.add('codex-neon-composer');
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(mark);
    };
    mark();
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    globalThis[CLEANUP_KEY] = () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      document.getElementById(STYLE_ID)?.remove();
      document.getElementById('codex-neon-tides-video-layer')?.remove();
      if (globalThis.__codexNeonVideoUrl) {
        try { URL.revokeObjectURL(globalThis.__codexNeonVideoUrl); } catch {}
        delete globalThis.__codexNeonVideoUrl;
      }
      root.classList.remove(ROOT_CLASS, 'codex-theme-native');
      delete root.dataset.codexTheme;
      delete globalThis[CLEANUP_KEY];
    };
    return {
      applied: true,
      stylePresent: !!document.getElementById(STYLE_ID),
      mainPresent: !!document.querySelector('.codex-neon-main'),
      sidebarPresent: !!document.querySelector('.codex-neon-sidebar'),
      composerPresent: !!document.querySelector('.codex-neon-composer'),
    };
  })()`;
}

function makeVideoChunkExpression(base64Chunk) {
  return `(() => {
    const raw = atob(${JSON.stringify(base64Chunk)});
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    (globalThis.__codexNeonVideoParts ||= []).push(bytes);
    return { parts: globalThis.__codexNeonVideoParts.length, bytes: bytes.length };
  })()`;
}

function makeVideoInstallExpression() {
  return `(async () => {
    const parts = globalThis.__codexNeonVideoParts;
    if (!Array.isArray(parts) || parts.length === 0) throw new Error('VIDEO_PARTS_MISSING');
    document.getElementById('codex-neon-tides-video-layer')?.remove();
    if (globalThis.__codexNeonVideoUrl) {
      try { URL.revokeObjectURL(globalThis.__codexNeonVideoUrl); } catch {}
    }
    const blob = new Blob(parts, { type: 'video/mp4' });
    globalThis.__codexNeonVideoParts = null;
    const objectUrl = URL.createObjectURL(blob);
    globalThis.__codexNeonVideoUrl = objectUrl;
    const layer = document.createElement('div');
    layer.id = 'codex-neon-tides-video-layer';
    layer.setAttribute('aria-hidden', 'true');
    const video = document.createElement('video');
    video.id = 'codex-neon-tides-video';
    video.autoplay = true;
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.disablePictureInPicture = true;
    video.setAttribute('muted', '');
    video.setAttribute('loop', '');
    video.setAttribute('autoplay', '');
    video.setAttribute('playsinline', '');
    video.src = objectUrl;
    layer.append(video);
    document.body.prepend(layer);
    try { await video.play(); } catch {}
    return {
      installed: layer.isConnected && video.isConnected,
      loop: video.loop,
      muted: video.muted,
      paused: video.paused,
      readyState: video.readyState,
      blobBytes: blob.size,
    };
  })()`;
}

const verificationExpression = `(() => {
  const style = document.getElementById('codex-neon-tides-style');
  const layer = document.getElementById('codex-neon-tides-video-layer');
  const video = document.getElementById('codex-neon-tides-video');
  return {
    style: !!style && style.textContent.includes('--codex-theme-id: "neon-tides"'),
    background: !!layer && !!video && video.src.startsWith('blob:'),
    root: document.documentElement.classList.contains('codex-neon-tides-active'),
    main: !!document.querySelector('.codex-neon-main'),
    sidebar: !!document.querySelector('.codex-neon-sidebar'),
    loop: video?.loop === true,
    muted: video?.muted === true,
    paused: video?.paused !== false,
    readyState: video?.readyState ?? 0,
    layerDisplay: layer ? getComputedStyle(layer).display : 'none',
  };
})()`;

function recordVerification(verifyValue) {
  result.theme_applied = verifyValue?.style === true && verifyValue?.root === true;
  result.style_verified = result.theme_applied && verifyValue?.main === true && verifyValue?.sidebar === true;
  result.background_verified = verifyValue?.background === true && verifyValue?.layerDisplay !== "none";
  result.video_loop_verified = verifyValue?.loop === true;
  result.video_muted_verified = verifyValue?.muted === true;
  result.video_playback_verified = verifyValue?.paused === false && verifyValue?.readyState >= 2;
}

function verificationPassed() {
  return result.theme_applied && result.style_verified && result.background_verified &&
    result.video_loop_verified && result.video_muted_verified && result.video_playback_verified;
}

let client = null;
try {
  result.error_stage = "load_assets";
  let css = null;
  let background = null;
  if (operation === "apply") {
    css = fs.readFileSync(cssPath, "utf8");
    background = fs.readFileSync(mediaPath);
    if (background.length < 1024 || background.length > 64 * 1024 * 1024) throw new Error("VIDEO_SIZE_INVALID");
    if (background.subarray(4, 12).toString("ascii").includes("ftyp") === false) throw new Error("VIDEO_CONTAINER_INVALID");
    const backgroundHash = sha256(background);
    result.css_bytes = Buffer.byteLength(css, "utf8");
    result.background_bytes = background.length;
    result.background_sha256 = backgroundHash;
  }

  result.error_stage = "wait_endpoint";
  const baseUrl = validateLoopbackUrl(endpoint, "http:");
  const version = await waitForVersion(baseUrl, waitSeconds * 1000);
  result.endpoint_seen = true;
  const browserSocket = validateLoopbackUrl(version.webSocketDebuggerUrl, "ws:", baseUrl.port);

  result.error_stage = "connect_browser";
  client = new CdpClient(browserSocket);
  await client.open();
  result.browser_websocket_connected = true;
  await client.call("Target.setDiscoverTargets", { discover: true });
  result.discover_supported = true;

  result.error_stage = "find_main_target";
  const discoveryDeadline = Date.now() + 25_000;
  let match = null;
  while (Date.now() < discoveryDeadline && !match) {
    await client.refreshTargets();
    result.target_count = Math.max(result.target_count, client.targetInfoById.size);
    for (const info of client.targetInfoById.values()) {
      if (info.type !== "page") continue;
      let protocol = "";
      try { protocol = new URL(String(info.url ?? "")).protocol; } catch { }
      if (protocol !== "app:" || !/codex/i.test(String(info.title ?? ""))) continue;
      const sessionId = await client.attach(info);
      if (!sessionId) continue;
      result.attached_page_count = client.sessionByTargetId.size;
      try {
        const response = await client.call("Runtime.evaluate", {
          expression: fingerprintExpression,
          returnByValue: true,
          awaitPromise: true,
        }, sessionId, 2500);
        const fingerprint = response?.result?.value;
        if (
          fingerprint?.protocol === "app:" &&
          fingerprint?.ready === "complete" &&
          fingerprint?.total >= 400 &&
          fingerprint?.hasLeft === true &&
          fingerprint?.mainSurface === true
        ) {
          match = { info, sessionId };
          break;
        }
      } catch {
      }
    }
    if (!match) await client.waitForEvent(300);
  }
  if (!match) throw new Error("MAIN_TARGET_NOT_FOUND");
  result.main_target_found = true;

  if (operation === "verify") {
    result.error_stage = "verify_theme";
    const verified = await client.call("Runtime.evaluate", {
      expression: verificationExpression,
      returnByValue: true,
    }, match.sessionId, 4000);
    recordVerification(verified?.result?.value);
    result.classification = verificationPassed() ? "HEALTHY" : "NOT_HEALTHY";
    result.restore_ok = verificationPassed();
    result.error_stage = null;
  } else {
    result.error_stage = "inject_theme";
    const installExpression = makeInstallExpression(css);
    try { await client.call("Page.enable", {}, match.sessionId, 2500); } catch { }
    try {
      const registered = await client.call("Page.addScriptToEvaluateOnNewDocument", {
        source: installExpression,
      }, match.sessionId, 5000);
      result.page_script_registered = Boolean(registered.identifier);
    } catch {
    }
    const applied = await client.call("Runtime.evaluate", {
      expression: installExpression,
      returnByValue: true,
      awaitPromise: true,
    }, match.sessionId, 8000);
    const appliedValue = applied?.result?.value;
    result.theme_applied = appliedValue?.applied === true && appliedValue?.stylePresent === true;

    result.error_stage = "transfer_video";
    await client.call("Runtime.evaluate", {
      expression: "globalThis.__codexNeonVideoParts = []; true",
      returnByValue: true,
    }, match.sessionId, 3000);
    const chunkSize = 384 * 1024;
    for (let offset = 0; offset < background.length; offset += chunkSize) {
      const encoded = background.subarray(offset, Math.min(offset + chunkSize, background.length)).toString("base64");
      await client.call("Runtime.evaluate", {
        expression: makeVideoChunkExpression(encoded),
        returnByValue: true,
      }, match.sessionId, 10_000);
      result.video_chunk_count += 1;
    }
    const videoInstalled = await client.call("Runtime.evaluate", {
      expression: makeVideoInstallExpression(),
      returnByValue: true,
      awaitPromise: true,
    }, match.sessionId, 15_000);
    if (videoInstalled?.result?.value?.installed !== true) throw new Error("VIDEO_INSTALL_FAILED");

    result.error_stage = "verify_theme";
    let verifyValue = null;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const verified = await client.call("Runtime.evaluate", {
        expression: verificationExpression,
        returnByValue: true,
      }, match.sessionId, 4000);
      verifyValue = verified?.result?.value;
      if (verifyValue?.background && verifyValue?.loop && verifyValue?.muted && !verifyValue?.paused && verifyValue?.readyState >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    recordVerification(verifyValue);
    if (!verificationPassed()) throw new Error("THEME_VERIFICATION_FAILED");

    result.classification = "APPLIED";
    result.restore_ok = true;
    result.error_stage = null;
  }
} catch (error) {
  result.classification = operation === "verify" ? "HEALTH_CHECK_FAILED" : "INJECTION_FAILED";
  result.error_type = error?.constructor?.name ?? "Error";
} finally {
  client?.close();
  try { writeResult(); } catch {
  }
}
