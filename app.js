/* Pixel Mood PWA MVP
   - Stores mood images in IndexedDB
   - Converts to 8-bit black/white + dithering
   - Composes portrait + RPG text box on canvas
*/

const MOODS = [
  { key: "neutral", label: "Neutral", icon: "😐" },
  { key: "happy",   label: "Happy",   icon: "😀" },
  { key: "angry",   label: "Angry",   icon: "😠" },
  { key: "sad",     label: "Sad",     icon: "😢" },
  { key: "surprised", label: "Surprised", icon: "😲" },
];

const DB_NAME = "pixel_mood_db";
const DB_STORE = "mood_photos";
const DB_VERSION = 1;

const setupGrid = document.getElementById("setupGrid");
const goComposeBtn = document.getElementById("goComposeBtn");
const resetBtn = document.getElementById("resetBtn");

const setupCard = document.getElementById("setupCard");
const composeCard = document.getElementById("composeCard");

const moodPicker = document.getElementById("moodPicker");
const msgEl = document.getElementById("msg");

const outCanvas = document.getElementById("outCanvas");
const outCtx = outCanvas.getContext("2d", { willReadFrequently: true });

const renderBtn = document.getElementById("renderBtn");
const downloadBtn = document.getElementById("downloadBtn");
const shareBtn = document.getElementById("shareBtn");
const backToSetupBtn = document.getElementById("backToSetupBtn");

const installBtn = document.getElementById("installBtn");
let deferredPrompt = null;

let selectedMood = MOODS[0].key;
let latestBlob = null;

initPWAInstall();
registerSW();
initUI();

async function initUI() {
  renderSetupGrid();
  renderMoodPicker();
  await refreshSetupThumbs();
  updateReadyState();

  goComposeBtn.addEventListener("click", () => {
    setupCard.hidden = true;
    composeCard.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  backToSetupBtn.addEventListener("click", () => {
    composeCard.hidden = true;
    setupCard.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  resetBtn.addEventListener("click", async () => {
    if (!confirm("Reset all saved mood photos?")) return;
    await dbClearAll();
    await refreshSetupThumbs();
    updateReadyState();
  });

  renderBtn.addEventListener("click", async () => {
    const text = (msgEl.value || "").trim();
    if (!text) {
      alert("Type some text first 🙂");
      return;
    }
    const blob = await dbGet(selectedMood);
    if (!blob) {
      alert("That mood doesn’t have a photo yet. Add it in Setup.");
      return;
    }
    await generateOutput(blob, text);
  });

  downloadBtn.addEventListener("click", async () => {
    if (!latestBlob) return;
    downloadBlob(latestBlob, `pixel-mood-${selectedMood}.png`);
  });

  shareBtn.addEventListener("click", async () => {
    if (!latestBlob) return;

    const file = new File([latestBlob], `pixel-mood-${selectedMood}.png`, { type: "image/png" });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: "Pixel Mood",
          text: "8-bit reaction!"
        });
      } catch (e) {
        // user canceled; ignore
      }
    } else {
      // fallback to download
      downloadBlob(latestBlob, `pixel-mood-${selectedMood}.png`);
      alert("Sharing not supported here — downloaded instead.");
    }
  });
}

function renderSetupGrid() {
  setupGrid.innerHTML = "";
  for (const m of MOODS) {
    const card = document.createElement("div");
    card.className = "moodCard";
    card.innerHTML = `
      <div class="moodTop">
        <div class="moodName">${m.icon} ${m.label}</div>
        <button class="btn ghost danger" type="button" data-clear="${m.key}">Clear</button>
      </div>
      <div class="thumb" id="thumb_${m.key}">
        <span class="smallNote">No photo yet</span>
      </div>
      <div class="row">
        <label class="btn" style="display:inline-flex;align-items:center;gap:8px;">
          📷 Camera
          <input type="file" accept="image/*" capture="user" data-pick="${m.key}" hidden>
        </label>
        <label class="btn" style="display:inline-flex;align-items:center;gap:8px;">
          🖼️ Upload
          <input type="file" accept="image/*" data-pick="${m.key}" hidden>
        </label>
      </div>
    `;
    setupGrid.appendChild(card);
  }

  // Pickers
  setupGrid.querySelectorAll('input[type="file"][data-pick]').forEach(inp => {
    inp.addEventListener("change", async (e) => {
      const moodKey = inp.dataset.pick;
      const file = e.target.files?.[0];
      if (!file) return;

      const blob = await fileToBlob(file);
      await dbPut(moodKey, blob);

      await refreshSetupThumb(moodKey);
      updateReadyState();

      // reset input so picking same file again triggers change
      inp.value = "";
    });
  });

  // Clear buttons
  setupGrid.querySelectorAll("button[data-clear]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const k = btn.dataset.clear;
      await dbDelete(k);
      await refreshSetupThumb(k);
      updateReadyState();
    });
  });
}

function renderMoodPicker() {
  moodPicker.innerHTML = "";
  for (const m of MOODS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "moodBtn";
    b.setAttribute("aria-pressed", String(m.key === selectedMood));
    b.dataset.mood = m.key;
    b.innerHTML = `<span aria-hidden="true">${m.icon}</span><span>${m.label}</span>`;
    b.addEventListener("click", () => {
      selectedMood = m.key;
      moodPicker.querySelectorAll(".moodBtn").forEach(x => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
    });
    moodPicker.appendChild(b);
  }
}

async function refreshSetupThumbs() {
  for (const m of MOODS) {
    await refreshSetupThumb(m.key);
  }
}

async function refreshSetupThumb(moodKey) {
  const thumb = document.getElementById(`thumb_${moodKey}`);
  thumb.innerHTML = `<span class="smallNote">Loading…</span>`;
  const blob = await dbGet(moodKey);
  if (!blob) {
    thumb.innerHTML = `<span class="smallNote">No photo yet</span>`;
    return;
  }

  // Generate a small pixel preview for the setup screen
  const img = await blobToImage(blob);
  const previewDataURL = makePixelPortraitDataURL(img, 128, true);

  const el = document.createElement("img");
  el.alt = `${moodKey} portrait preview`;
  el.src = previewDataURL;
  thumb.innerHTML = "";
  thumb.appendChild(el);
}

async function updateReadyState() {
  const all = await Promise.all(MOODS.map(m => dbGet(m.key)));
  const ready = all.every(Boolean);
  goComposeBtn.disabled = !ready;
}

/* ---------- Output Generation ---------- */

async function generateOutput(blob, text) {
  // Big output canvas already set (720x720)
  const img = await blobToImage(blob);

  // Create portrait pixel art at a fixed size
  const PORTRAIT_SIZE = 240; // displayed size inside final image
  const portraitDataURL = makePixelPortraitDataURL(img, PORTRAIT_SIZE, false);
  const portraitImg = await dataURLToImage(portraitDataURL);

  // Draw background
  outCtx.clearRect(0, 0, outCanvas.width, outCanvas.height);
  outCtx.fillStyle = "#000";
  outCtx.fillRect(0, 0, outCanvas.width, outCanvas.height);

  // Subtle “retro” pattern
  outCtx.globalAlpha = 0.08;
  drawScanlines(outCtx, outCanvas.width, outCanvas.height);
  outCtx.globalAlpha = 1;

  // Layout
  const pad = 36;
  const boxH = 230;
  const boxY = outCanvas.height - pad - boxH;

  // Portrait placement (left)
  const pX = pad + 24;
  const pY = boxY - PORTRAIT_SIZE - 24;

  // Draw portrait frame
  drawPixelFrame(outCtx, pX - 10, pY - 10, PORTRAIT_SIZE + 20, PORTRAIT_SIZE + 20);

  // Draw portrait
  outCtx.imageSmoothingEnabled = false;
  outCtx.drawImage(portraitImg, pX, pY, PORTRAIT_SIZE, PORTRAIT_SIZE);

  // Draw dialogue box
  const boxX = pad;
  const boxW = outCanvas.width - pad * 2;
  drawDialogueBox(outCtx, boxX, boxY, boxW, boxH);

  // Render pixel text
  drawPixelText(outCtx, text, boxX + 28, boxY + 38, boxW - 56, 8);

  // Export to blob
  latestBlob = await canvasToBlob(outCanvas, "image/png", 0.92);
  downloadBtn.disabled = false;
  shareBtn.disabled = false;
}

/* ---------- Pixel Art Conversion ---------- */

function makePixelPortraitDataURL(img, outSize, quickPreview) {
  // Crop to face-ish center square
  const size = Math.min(img.width, img.height);
  const sx = Math.floor((img.width - size) / 2);
  const sy = Math.floor((img.height - size) / 2);

  // Downscale size (lower = chunkier pixels)
  const pixelScale = quickPreview ? 44 : 56; // tweak these for chunkiness
  const small = Math.max(24, Math.floor(outSize * (pixelScale / 240)));

  const c1 = document.createElement("canvas");
  c1.width = small;
  c1.height = small;
  const ctx1 = c1.getContext("2d", { willReadFrequently: true });

  // Draw cropped image into tiny canvas
  ctx1.drawImage(img, sx, sy, size, size, 0, 0, small, small);

  // Get pixels
  const im = ctx1.getImageData(0, 0, small, small);
  const d = im.data;

  // Grayscale + contrast
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], b = d[i+2];
    let lum = (0.2126*r + 0.7152*g + 0.0722*b);
    lum = (lum - 128) * 1.15 + 128; // contrast
    lum = Math.max(0, Math.min(255, lum));
    d[i] = d[i+1] = d[i+2] = lum;
    d[i+3] = 255;
  }

  // Floyd-Steinberg dithering to pure black/white
  floydSteinbergBW(im, small, small);
  ctx1.putImageData(im, 0, 0);

  // Upscale to outSize
  const c2 = document.createElement("canvas");
  c2.width = outSize;
  c2.height = outSize;
  const ctx2 = c2.getContext("2d");
  ctx2.imageSmoothingEnabled = false;
  ctx2.drawImage(c1, 0, 0, outSize, outSize);

  return c2.toDataURL("image/png");
}

function floydSteinbergBW(imageData, w, h) {
  const d = imageData.data;

  function idx(x, y) { return (y*w + x) * 4; }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      const old = d[i]; // grayscale
      const neu = old < 128 ? 0 : 255;
      const err = old - neu;

      d[i] = d[i+1] = d[i+2] = neu;

      // distribute error
      distribute(x+1, y,   err * 7/16);
      distribute(x-1, y+1, err * 3/16);
      distribute(x,   y+1, err * 5/16);
      distribute(x+1, y+1, err * 1/16);
    }
  }

  function distribute(x, y, amt) {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = (y*w + x) * 4;
    let v = d[i] + amt;
    v = Math.max(0, Math.min(255, v));
    d[i] = d[i+1] = d[i+2] = v;
  }
}

/* ---------- Drawing UI (8-bit frames/text) ---------- */

function drawScanlines(ctx, w, h) {
  ctx.fillStyle = "#fff";
  for (let y = 0; y < h; y += 4) {
    ctx.fillRect(0, y, w, 1);
  }
}

function drawPixelFrame(ctx, x, y, w, h) {
  // chunky 8-bit border
  ctx.fillStyle = "#fff";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#000";
  ctx.fillRect(x + 6, y + 6, w - 12, h - 12);
  ctx.fillStyle = "#fff";
  ctx.fillRect(x + 10, y + 10, w - 20, h - 20);
  ctx.fillStyle = "#000";
  ctx.fillRect(x + 14, y + 14, w - 28, h - 28);
}

function drawDialogueBox(ctx, x, y, w, h) {
  // outer border
  ctx.fillStyle = "#fff";
  ctx.fillRect(x, y, w, h);
  // inner black
  ctx.fillStyle = "#000";
  ctx.fillRect(x + 10, y + 10, w - 20, h - 20);
  // inner white line
  ctx.fillStyle = "#fff";
  ctx.fillRect(x + 16, y + 16, w - 32, h - 32);
  // inner black area
  ctx.fillStyle = "#000";
  ctx.fillRect(x + 20, y + 20, w - 40, h - 40);
}

function drawPixelText(ctx, text, x, y, maxW, scale) {
  // Minimal “bitmap” font (5x7) for uppercase + basic punctuation.
  // For best results, we transform to uppercase and replace unsupported chars.
  const map = PIXEL_FONT_5x7;
  const s = (text || "").toUpperCase();

  const words = s.split(/\s+/).filter(Boolean);

  let cx = x;
  let cy = y;

  const lineH = 10 * scale;
  const spaceW = 4 * scale;

  for (const word of words) {
    const wordW = measureWord(word, scale);
    if (cx + wordW > x + maxW) {
      // new line
      cx = x;
      cy += lineH;
      if (cy > y + 180) break; // prevent overflow
    }
    for (const ch of word) {
      drawChar(ctx, ch, cx, cy, scale, map);
      cx += 6 * scale; // char advance
    }
    cx += spaceW;
  }
}

function measureWord(word, scale) {
  return word.length * (6 * scale);
}

function drawChar(ctx, ch, x, y, scale, map) {
  const glyph = map[ch] || map["?"];
  ctx.fillStyle = "#fff";
  for (let row = 0; row < glyph.length; row++) {
    const bits = glyph[row];
    for (let col = 0; col < bits.length; col++) {
      if (bits[col] === "1") {
        ctx.fillRect(x + col * scale, y + row * scale, scale, scale);
      }
    }
  }
}

const PIXEL_FONT_5x7 = {
  "A":["01110","10001","10001","11111","10001","10001","10001"],
  "B":["11110","10001","10001","11110","10001","10001","11110"],
  "C":["01111","10000","10000","10000","10000","10000","01111"],
  "D":["11110","10001","10001","10001","10001","10001","11110"],
  "E":["11111","10000","10000","11110","10000","10000","11111"],
  "F":["11111","10000","10000","11110","10000","10000","10000"],
  "G":["01111","10000","10000","10011","10001","10001","01111"],
  "H":["10001","10001","10001","11111","10001","10001","10001"],
  "I":["11111","00100","00100","00100","00100","00100","11111"],
  "J":["00111","00010","00010","00010","00010","10010","01100"],
  "K":["10001","10010","10100","11000","10100","10010","10001"],
  "L":["10000","10000","10000","10000","10000","10000","11111"],
  "M":["10001","11011","10101","10101","10001","10001","10001"],
  "N":["10001","11001","10101","10011","10001","10001","10001"],
  "O":["01110","10001","10001","10001","10001","10001","01110"],
  "P":["11110","10001","10001","11110","10000","10000","10000"],
  "Q":["01110","10001","10001","10001","10101","10010","01101"],
  "R":["11110","10001","10001","11110","10100","10010","10001"],
  "S":["01111","10000","10000","01110","00001","00001","11110"],
  "T":["11111","00100","00100","00100","00100","00100","00100"],
  "U":["10001","10001","10001","10001","10001","10001","01110"],
  "V":["10001","10001","10001","10001","10001","01010","00100"],
  "W":["10001","10001","10001","10101","10101","11011","10001"],
  "X":["10001","10001","01010","00100","01010","10001","10001"],
  "Y":["10001","10001","01010","00100","00100","00100","00100"],
  "Z":["11111","00001","00010","00100","01000","10000","11111"],
  "0":["01110","10001","10011","10101","11001","10001","01110"],
  "1":["00100","01100","00100","00100","00100","00100","01110"],
  "2":["01110","10001","00001","00010","00100","01000","11111"],
  "3":["11110","00001","00001","01110","00001","00001","11110"],
  "4":["00010","00110","01010","10010","11111","00010","00010"],
  "5":["11111","10000","10000","11110","00001","00001","11110"],
  "6":["01110","10000","10000","11110","10001","10001","01110"],
  "7":["11111","00001","00010","00100","01000","01000","01000"],
  "8":["01110","10001","10001","01110","10001","10001","01110"],
  "9":["01110","10001","10001","01111","00001","00001","01110"],
  ".":["00000","00000","00000","00000","00000","01100","01100"],
  ",":["00000","00000","00000","00000","01100","01100","01000"],
  "!":["00100","00100","00100","00100","00100","00000","00100"],
  "?":["01110","10001","00001","00010","00100","00000","00100"],
  ":":["00000","01100","01100","00000","01100","01100","00000"],
  "-":["00000","00000","00000","11111","00000","00000","00000"],
  "'":["00100","00100","00000","00000","00000","00000","00000"],
  "\"":["01010","01010","00000","00000","00000","00000","00000"],
  "/":["00001","00010","00100","01000","10000","00000","00000"],
  "(":["00010","00100","01000","01000","01000","00100","00010"],
  ")":["01000","00100","00010","00010","00010","00100","01000"],
  " ":[ "00000","00000","00000","00000","00000","00000","00000" ]
};

/* ---------- IndexedDB ---------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(key, blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbClearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- Utilities ---------- */

function fileToBlob(file) {
  // ensure image/* stays as-is
  return file.slice(0, file.size, file.type || "image/jpeg");
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function dataURLToImage(dataURL) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataURL;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

/* ---------- PWA install + SW ---------- */

function initPWAInstall() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.hidden = false;
  });

  installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch {}
    deferredPrompt = null;
    installBtn.hidden = true;
  });
}

async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (e) {
    // ignore (local file:// won’t work with SW)
  }
}
