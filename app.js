'use strict';

/*
 * 無音カメラ
 * 写真はカメラ映像のフレームを canvas に描いて JPEG にするだけなので、シャッター音は鳴りません。
 * ビデオは MediaRecorder で録画します（こちらも開始/終了音なし）。
 * 撮ったものは端末内（IndexedDB）に保存され、共有シートから写真アプリへ書き出します。
 */

const $ = (sel) => document.querySelector(sel);

const els = {
  stage: $('#stage'),
  frame: $('#frame'),
  video: $('#preview'),
  grid: $('#grid'),
  flash: $('#flash'),
  countdown: $('#countdown'),
  rec: $('#rec-indicator'),
  recTime: $('#rec-time'),
  zoomLabel: $('#zoom-label'),
  zoomBar: $('#zoom-bar'),
  zoom: $('#zoom'),
  lensMenu: $('#lens-menu'),
  message: $('#message'),
  messageText: $('#message-text'),
  btnRetry: $('#btn-retry'),
  btnGrid: $('#btn-grid'),
  btnTimer: $('#btn-timer'),
  btnTorch: $('#btn-torch'),
  btnLens: $('#btn-lens'),
  modes: document.querySelectorAll('.mode'),
  shutter: $('#btn-shutter'),
  btnGallery: $('#btn-gallery'),
  thumb: $('#thumb'),
  badge: $('#badge'),
  btnFlip: $('#btn-flip'),
  gallery: $('#gallery'),
  galleryTitle: $('#gallery-title'),
  galleryGrid: $('#gallery-grid'),
  galleryEmpty: $('#gallery-empty'),
  btnGalleryClose: $('#btn-gallery-close'),
  btnSelect: $('#btn-select'),
  btnSaveMain: $('#btn-save-main'),
  btnDeleteMain: $('#btn-delete-main'),
  viewer: $('#viewer'),
  viewerInfo: $('#viewer-info'),
  viewerMedia: $('#viewer-media'),
  btnViewerClose: $('#btn-viewer-close'),
  btnViewerSave: $('#btn-viewer-save'),
  btnViewerDelete: $('#btn-viewer-delete'),
  toast: $('#toast'),
};

const TIMERS = [0, 3, 10];
const MAX_ZOOM = 10;

/* ---------- 設定（この端末のブラウザにだけ保存） ---------- */

// 同じサイト（github.io）のほかのアプリと名前がぶつからないよう、アプリ名を付けたキーに保存する
const PREFS_KEY = 'silent-camera:prefs';
const prefs = loadPrefs();

function loadPrefs() {
  const defaults = { grid: false, timer: 0, facing: 'environment' };
  try {
    const raw = localStorage.getItem(PREFS_KEY) || localStorage.getItem('prefs') || '{}'; // 'prefs' は以前の保存先
    const p = { ...defaults, ...JSON.parse(raw) };
    if (!TIMERS.includes(p.timer)) p.timer = 0;
    if (p.facing !== 'user') p.facing = 'environment';
    return { grid: !!p.grid, timer: p.timer, facing: p.facing };
  } catch {
    return defaults;
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 保存できなくても動作には影響しない
  }
}

function applyPrefsUI() {
  els.grid.hidden = !prefs.grid;
  els.btnGrid.setAttribute('aria-pressed', String(prefs.grid));
  els.btnTimer.textContent = prefs.timer ? `タイマー ${prefs.timer}秒` : 'タイマー オフ';
  els.btnTimer.setAttribute('aria-pressed', String(prefs.timer > 0));
}

/* ---------- カメラ ---------- */

let mode = 'photo';
let deviceId = null;
let stream = null;
let track = null;
let startSeq = 0;
let lenses = [];
let zoomCaps = null;
let currentZoom = 1;
let zoomFrame = null;
let torchOn = false;

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  track = null;
  els.video.srcObject = null;
}

async function startCamera() {
  const seq = ++startSeq;
  stopCamera();
  hideMessage();

  if (!window.isSecureContext) {
    showMessage('カメラは https:// で開いたページでのみ使えます。', false);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showMessage('このブラウザではカメラを使えません。iPhone の Safari で開いてください。', false);
    return;
  }

  const video = mode === 'photo'
    ? { width: { ideal: 4032 }, height: { ideal: 3024 } }
    : { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  if (deviceId) video.deviceId = { exact: deviceId };
  else video.facingMode = { ideal: prefs.facing };

  let s;
  let noMic = false;
  try {
    if (mode === 'video') {
      try {
        s = await navigator.mediaDevices.getUserMedia({ video, audio: true });
      } catch (err) {
        if (err.name !== 'NotAllowedError' && err.name !== 'NotFoundError') throw err;
        noMic = true;
      }
    }
    if (!s) s = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (err) {
    if (seq !== startSeq) return;
    if (deviceId) {
      // 選んだレンズが使えなかったら通常のカメラで再試行
      deviceId = null;
      startCamera();
      return;
    }
    showMessage(cameraErrorText(err), true);
    return;
  }

  if (seq !== startSeq) {
    s.getTracks().forEach((t) => t.stop());
    return;
  }

  stream = s;
  track = s.getVideoTracks()[0];
  els.video.srcObject = s;
  try {
    await els.video.play();
  } catch {
    // autoplay は muted + playsinline なので通常は失敗しない
  }

  const settings = track.getSettings?.() || {};
  const facing = settings.facingMode || (deviceId ? guessFacing(track.label) : prefs.facing);
  els.video.classList.toggle('mirror', facing === 'user');

  if (noMic) toast('マイクが使えないため音声なしで録画します');
  fitFrame();
  setupCapabilities();
  refreshLenses();
}

function cameraErrorText(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'カメラへのアクセスが許可されていません。\nSafari のアドレスバー左の「ぁあ」→「Webサイトの設定」→「カメラ」を「許可」にしてから再試行してください。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'カメラが見つかりませんでした。';
    case 'NotReadableError':
    case 'AbortError':
      return 'カメラを起動できませんでした。他のアプリがカメラを使っていないか確認してください。';
    default:
      return `カメラを起動できませんでした（${err?.name || 'エラー'}）。`;
  }
}

function guessFacing(label = '') {
  return /front|前面|user|facetime/i.test(label) ? 'user' : 'environment';
}

// プレビュー枠を映像と同じ縦横比にして、写る範囲＝保存される範囲にする
function fitFrame() {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw || !vh) return;
  const { width: sw, height: sh } = els.stage.getBoundingClientRect();
  const scale = Math.min(sw / vw, sh / vh);
  els.frame.style.width = `${Math.floor(vw * scale)}px`;
  els.frame.style.height = `${Math.floor(vh * scale)}px`;
}

function setupCapabilities() {
  const caps = track?.getCapabilities?.() || {};

  zoomCaps = caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null;
  els.zoomBar.hidden = !zoomCaps;
  if (zoomCaps) {
    els.zoom.min = zoomCaps.min;
    els.zoom.max = Math.min(zoomCaps.max, MAX_ZOOM);
    els.zoom.step = zoomCaps.step || 0.1;
    currentZoom = track.getSettings().zoom ?? zoomCaps.min;
    els.zoom.value = currentZoom;
  }

  torchOn = false;
  els.btnTorch.hidden = !caps.torch;
  els.btnTorch.setAttribute('aria-pressed', 'false');
}

function setZoom(z, showLabel = true) {
  if (!zoomCaps || !track) return;
  currentZoom = Math.min(Math.max(z, zoomCaps.min), Number(els.zoom.max));
  els.zoom.value = currentZoom;
  if (showLabel) showZoomLabel();
  if (zoomFrame == null) {
    zoomFrame = requestAnimationFrame(() => {
      zoomFrame = null;
      track?.applyConstraints({ advanced: [{ zoom: currentZoom }] }).catch(() => {});
    });
  }
}

let zoomLabelTimer = null;
function showZoomLabel() {
  els.zoomLabel.textContent = `${currentZoom.toFixed(1)}×`;
  els.zoomLabel.hidden = false;
  clearTimeout(zoomLabelTimer);
  zoomLabelTimer = setTimeout(() => { els.zoomLabel.hidden = true; }, 900);
}

async function toggleTorch() {
  if (!track) return;
  const next = !torchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: next }] });
    torchOn = next;
    els.btnTorch.setAttribute('aria-pressed', String(torchOn));
  } catch {
    toast('ライトを切り替えられませんでした');
  }
}

async function refreshLenses() {
  try {
    lenses = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch {
    lenses = [];
  }
  // 前面＋背面の 2 つだけならフリップボタンで足りるので、3 つ以上あるときだけ出す
  els.btnLens.hidden = lenses.length <= 2;
}

function openLensMenu() {
  const current = track?.getSettings?.().deviceId;
  const buttons = lenses.map((d, i) => {
    const b = document.createElement('button');
    b.textContent = d.label || `カメラ ${i + 1}`;
    b.classList.toggle('active', d.deviceId === current);
    b.addEventListener('click', () => {
      deviceId = d.deviceId;
      prefs.facing = guessFacing(d.label);
      savePrefs();
      closeLensMenu();
      startCamera();
    });
    return b;
  });
  els.lensMenu.replaceChildren(...buttons);
  els.lensMenu.hidden = false;
}

function closeLensMenu() {
  els.lensMenu.hidden = true;
}

function flipCamera() {
  const current = els.video.classList.contains('mirror') ? 'user' : 'environment';
  prefs.facing = current === 'user' ? 'environment' : 'user';
  deviceId = null;
  savePrefs();
  startCamera();
}

function setMode(next) {
  if (next === mode || recorder || countdownTimer) return;
  mode = next;
  els.modes.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  els.shutter.classList.toggle('video-mode', mode === 'video');
  els.shutter.setAttribute('aria-label', mode === 'video' ? '録画開始' : '撮影');
  startCamera();
}

/* ---------- 撮影 ---------- */

let countdownTimer = null;

function onShutter() {
  if (countdownTimer) {
    cancelCountdown();
    return;
  }
  if (recorder) {
    stopRecording();
    return;
  }
  if (!track) return;
  const action = mode === 'photo' ? takePhoto : startRecording;
  if (prefs.timer > 0) startCountdown(prefs.timer, action);
  else action();
}

function startCountdown(sec, action) {
  let n = sec;
  els.countdown.textContent = n;
  els.countdown.hidden = false;
  els.shutter.classList.add('counting');
  countdownTimer = setInterval(() => {
    n -= 1;
    if (n <= 0) {
      cancelCountdown();
      action();
    } else {
      els.countdown.textContent = n;
    }
  }, 1000);
}

function cancelCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  els.countdown.hidden = true;
  els.shutter.classList.remove('counting');
}

function blink() {
  els.flash.classList.remove('on');
  void els.flash.offsetWidth; // アニメーションを毎回最初から再生する
  els.flash.classList.add('on');
}

async function takePhoto() {
  const v = els.video;
  const w = v.videoWidth;
  const h = v.videoHeight;
  if (!w || !h) return;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(v, 0, 0, w, h);
  blink();

  try {
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    const thumb = await makeThumb(canvas, w, h);
    await addItem({ type: 'photo', blob, mime: 'image/jpeg', thumb, width: w, height: h, createdAt: Date.now(), saved: false });
  } catch (err) {
    console.error(err);
    toast('写真を保存できませんでした');
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, quality);
  });
}

async function makeThumb(source, w, h) {
  const scale = Math.min(1, 360 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return canvasToBlob(c, 'image/jpeg', 0.8);
}

/* ---------- 録画 ---------- */

let recorder = null;
let recChunks = [];
let recStartedAt = 0;
let recThumb = null;
let recTick = null;

function pickVideoMime() {
  const candidates = ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return candidates.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
}

async function startRecording() {
  if (!stream || typeof MediaRecorder === 'undefined') {
    toast('このブラウザでは録画できません');
    return;
  }
  const mime = pickVideoMime();
  let rec;
  try {
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (err) {
    console.error(err);
    toast('録画を開始できませんでした');
    return;
  }

  const v = els.video;
  recThumb = v.videoWidth ? await makeThumb(v, v.videoWidth, v.videoHeight).catch(() => null) : null;
  recChunks = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) recChunks.push(e.data);
  };
  rec.onstop = () => finishRecording(rec, mime);
  try {
    rec.start(1000);
  } catch (err) {
    // マイクなしの映像に音声コーデックを指定したときなど、開始の時点で失敗することがある
    console.error(err);
    toast('録画を開始できませんでした');
    return;
  }

  recorder = rec;
  recStartedAt = Date.now();
  setRecordingUI(true);
  updateRecTime();
  recTick = setInterval(updateRecTime, 250);
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

async function finishRecording(rec, requestedMime) {
  recorder = null;
  clearInterval(recTick);
  setRecordingUI(false);

  const type = rec.mimeType || recChunks[0]?.type || requestedMime || 'video/mp4';
  const blob = new Blob(recChunks, { type });
  recChunks = [];
  if (!blob.size) {
    toast('録画データがありませんでした');
    return;
  }
  try {
    await addItem({
      type: 'video',
      blob,
      mime: type,
      thumb: recThumb,
      duration: (Date.now() - recStartedAt) / 1000,
      createdAt: recStartedAt,
      saved: false,
    });
  } catch (err) {
    console.error(err);
    toast('ビデオを保存できませんでした');
  }
}

function updateRecTime() {
  els.recTime.textContent = formatDuration((Date.now() - recStartedAt) / 1000);
}

function setRecordingUI(on) {
  els.rec.hidden = !on;
  els.shutter.classList.toggle('recording', on);
  els.shutter.setAttribute('aria-label', on ? '録画停止' : mode === 'video' ? '録画開始' : '撮影');
  for (const b of [els.btnFlip, els.btnGallery, els.btnLens, ...els.modes]) b.disabled = on;
}

/* ---------- 端末内の保存（IndexedDB） ---------- */

const DB_NAME = 'silent-camera';
const STORE = 'media';
let db = null;
const memStore = new Map();
let memSeq = 0;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(txMode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, txMode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function dbAll() {
  if (!db) return [...memStore.values()];
  return idb('readonly', (s) => s.getAll());
}

async function dbPut(item) {
  if (db) {
    try {
      item.id = await idb('readwrite', (s) => s.put(item));
      return;
    } catch (err) {
      console.warn(err);
      db = null;
      toast('端末内に保存できないため、アプリを閉じると消えます。早めに写真アプリへ保存してください');
    }
  }
  if (item.id == null) item.id = `m${++memSeq}`;
  memStore.set(item.id, item);
}

async function dbDelete(id) {
  if (db) {
    try {
      await idb('readwrite', (s) => s.delete(id));
    } catch (err) {
      console.warn(err);
    }
  }
  memStore.delete(id);
}

/* ---------- 撮影データ ---------- */

let items = []; // 新しい順
const urlCache = new Map();

function getURL(item, kind) {
  const key = `${item.id}:${kind}`;
  if (!urlCache.has(key)) {
    const blob = kind === 'thumb' ? item.thumb : item.blob;
    if (!blob) return '';
    urlCache.set(key, URL.createObjectURL(blob));
  }
  return urlCache.get(key);
}

function revokeURLs(id) {
  for (const kind of ['thumb', 'full']) {
    const key = `${id}:${kind}`;
    if (urlCache.has(key)) {
      URL.revokeObjectURL(urlCache.get(key));
      urlCache.delete(key);
    }
  }
}

async function addItem(item) {
  await dbPut(item);
  items.unshift(item);
  updateGalleryButton();
  if (!els.gallery.hidden) renderGallery();
}

function updateGalleryButton() {
  const latest = items[0];
  const src = latest ? getURL(latest, 'thumb') : '';
  els.thumb.hidden = !src;
  if (src) els.thumb.src = src;
  const unsaved = items.filter((i) => !i.saved).length;
  els.badge.hidden = unsaved === 0;
  els.badge.textContent = unsaved;
}

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

function fileName(item) {
  const d = new Date(item.createdAt);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}`;
  if (item.type === 'photo') return `IMG_${stamp}.jpg`;
  const ext = baseMime(item.mime) === 'video/webm' ? 'webm' : 'mp4';
  return `VID_${stamp}.${ext}`;
}

function baseMime(mime = '') {
  return mime.split(';')[0].trim();
}

function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function formatDate(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 共有シートを開く。navigator.share はタップ直後に呼ぶ必要があるので、この関数の中では await より前に呼ぶ。
async function exportItems(list) {
  if (!list.length) return;
  const files = list.map((it) => new File([it.blob], fileName(it), { type: baseMime(it.mime) }));

  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files });
    } catch (err) {
      if (err.name !== 'AbortError') toast('共有できませんでした');
      return;
    }
  } else {
    for (const f of files) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    }
  }

  for (const it of list) {
    if (!it.saved) {
      it.saved = true;
      await dbPut(it);
    }
  }
  updateGalleryButton();
  if (!els.gallery.hidden) renderGallery();
  if (!els.viewer.hidden) renderViewer();
}

async function deleteItems(list) {
  if (!list.length) return false;
  const unsaved = list.filter((i) => !i.saved).length;
  const msg = unsaved
    ? `${list.length}件を削除します（うち${unsaved}件はまだ写真アプリに保存していません）。よろしいですか？`
    : `${list.length}件を削除します。よろしいですか？`;
  if (!confirm(msg)) return false;

  const ids = new Set(list.map((i) => i.id));
  for (const id of ids) {
    await dbDelete(id);
    revokeURLs(id);
    selected.delete(id);
  }
  items = items.filter((i) => !ids.has(i.id));
  updateGalleryButton();
  renderGallery();
  return true;
}

/* ---------- ライブラリ ---------- */

let selectMode = false;
const selected = new Set();

function openGallery() {
  closeLensMenu();
  els.gallery.hidden = false;
  renderGallery();
}

function closeGallery() {
  els.gallery.hidden = true;
  setSelectMode(false);
}

function setSelectMode(on) {
  selectMode = on;
  selected.clear();
  els.btnSelect.textContent = on ? 'キャンセル' : '選択';
  if (!els.gallery.hidden) renderGallery();
}

function renderGallery() {
  els.galleryTitle.textContent = `ライブラリ（${items.length}）`;
  els.galleryEmpty.hidden = items.length > 0;
  els.galleryGrid.hidden = items.length === 0;
  els.btnSelect.disabled = items.length === 0;

  const frag = document.createDocumentFragment();
  items.forEach((it, index) => {
    const tile = document.createElement('button');
    tile.className = 'tile';
    tile.classList.toggle('selected', selectMode && selected.has(it.id));

    const src = getURL(it, 'thumb') || (it.type === 'photo' ? getURL(it, 'full') : '');
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.loading = 'lazy';
      tile.append(img);
    }
    if (it.type === 'video') tile.append(tag('dur', `▶ ${formatDuration(it.duration || 0)}`));
    if (it.saved) tile.append(tag('saved', '✓ 保存済'));

    tile.addEventListener('click', () => {
      if (selectMode) {
        if (selected.has(it.id)) selected.delete(it.id);
        else selected.add(it.id);
        renderGallery();
      } else {
        openViewer(index);
      }
    });
    frag.append(tile);
  });
  els.galleryGrid.replaceChildren(frag);
  updateGalleryActions();
}

function tag(cls, text) {
  const s = document.createElement('span');
  s.className = `tag ${cls}`;
  s.textContent = text;
  return s;
}

function updateGalleryActions() {
  if (selectMode) {
    els.btnSaveMain.textContent = `保存（${selected.size}）`;
    els.btnDeleteMain.textContent = `削除（${selected.size}）`;
    els.btnSaveMain.disabled = selected.size === 0;
    els.btnDeleteMain.disabled = selected.size === 0;
  } else {
    const unsaved = items.filter((i) => !i.saved).length;
    const saved = items.length - unsaved;
    els.btnSaveMain.textContent = `すべて保存（${unsaved}）`;
    els.btnDeleteMain.textContent = `保存済を削除（${saved}）`;
    els.btnSaveMain.disabled = unsaved === 0;
    els.btnDeleteMain.disabled = saved === 0;
  }
}

function selectedItems() {
  return items.filter((i) => selected.has(i.id));
}

async function onSaveMain() {
  const list = selectMode ? selectedItems() : items.filter((i) => !i.saved);
  await exportItems(list);
  if (selectMode) setSelectMode(false);
}

async function onDeleteMain() {
  const list = selectMode ? selectedItems() : items.filter((i) => i.saved);
  if ((await deleteItems(list)) && selectMode) setSelectMode(false);
}

/* ---------- 1枚表示 ---------- */

let viewIndex = -1;
let swipeStartX = null;

function openViewer(index) {
  viewIndex = index;
  els.viewer.hidden = false;
  renderViewer();
}

function closeViewer() {
  els.viewer.hidden = true;
  els.viewerMedia.replaceChildren();
  viewIndex = -1;
}

function renderViewer() {
  const it = items[viewIndex];
  if (!it) {
    closeViewer();
    return;
  }
  let media;
  if (it.type === 'video') {
    media = document.createElement('video');
    media.controls = true;
    media.playsInline = true;
    media.setAttribute('playsinline', '');
    if (it.thumb) media.poster = getURL(it, 'thumb');
  } else {
    media = document.createElement('img');
    media.alt = '';
  }
  media.src = getURL(it, 'full');
  els.viewerMedia.replaceChildren(media);
  els.viewerInfo.textContent = `${viewIndex + 1} / ${items.length}・${formatDate(it.createdAt)}${it.saved ? '・保存済' : ''}`;
}

function stepViewer(delta) {
  const next = viewIndex + delta;
  if (next < 0 || next >= items.length) return;
  viewIndex = next;
  renderViewer();
}

async function onViewerDelete() {
  const it = items[viewIndex];
  if (!it) return;
  if (await deleteItems([it])) {
    if (viewIndex >= items.length) viewIndex = items.length - 1;
    renderViewer();
  }
}

/* ---------- メッセージ・トースト ---------- */

function showMessage(text, canRetry) {
  els.messageText.textContent = text;
  els.messageText.style.whiteSpace = 'pre-line';
  els.btnRetry.hidden = !canRetry;
  els.message.hidden = false;
}

function hideMessage() {
  els.message.hidden = true;
}

let toastTimer = null;
function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

/* ---------- イベント ---------- */

function bindEvents() {
  els.shutter.addEventListener('click', onShutter);
  els.btnFlip.addEventListener('click', flipCamera);
  els.btnGallery.addEventListener('click', openGallery);
  els.btnRetry.addEventListener('click', startCamera);
  els.modes.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  els.btnGrid.addEventListener('click', () => {
    prefs.grid = !prefs.grid;
    savePrefs();
    applyPrefsUI();
  });
  els.btnTimer.addEventListener('click', () => {
    prefs.timer = TIMERS[(TIMERS.indexOf(prefs.timer) + 1) % TIMERS.length];
    savePrefs();
    applyPrefsUI();
  });
  els.btnTorch.addEventListener('click', toggleTorch);
  els.btnLens.addEventListener('click', (e) => {
    e.stopPropagation();
    if (els.lensMenu.hidden) openLensMenu();
    else closeLensMenu();
  });
  document.addEventListener('click', (e) => {
    if (!els.lensMenu.hidden && !els.lensMenu.contains(e.target)) closeLensMenu();
  });

  els.zoom.addEventListener('input', () => setZoom(Number(els.zoom.value)));

  // ピンチでズーム
  let pinch = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  els.stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && zoomCaps) pinch = { d: dist(e.touches), z: currentZoom };
  }, { passive: true });
  els.stage.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      setZoom(pinch.z * (dist(e.touches) / pinch.d));
    }
  }, { passive: false });
  els.stage.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinch = null;
  });
  // iOS Safari のページ拡大を止める
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  els.video.addEventListener('loadedmetadata', fitFrame);
  els.video.addEventListener('resize', fitFrame);
  window.addEventListener('resize', fitFrame);

  els.btnGalleryClose.addEventListener('click', closeGallery);
  els.btnSelect.addEventListener('click', () => setSelectMode(!selectMode));
  els.btnSaveMain.addEventListener('click', onSaveMain);
  els.btnDeleteMain.addEventListener('click', onDeleteMain);

  els.btnViewerClose.addEventListener('click', closeViewer);
  els.btnViewerSave.addEventListener('click', () => {
    const it = items[viewIndex];
    if (it) exportItems([it]);
  });
  els.btnViewerDelete.addEventListener('click', onViewerDelete);
  els.viewerMedia.addEventListener('touchstart', (e) => {
    swipeStartX = e.touches.length === 1 ? e.touches[0].clientX : null;
  }, { passive: true });
  els.viewerMedia.addEventListener('touchend', (e) => {
    if (swipeStartX == null) return;
    const dx = e.changedTouches[0].clientX - swipeStartX;
    swipeStartX = null;
    if (Math.abs(dx) > 60) stepViewer(dx < 0 ? 1 : -1);
  });

  // アプリを裏に回したらカメラを止め、戻ったら再開
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelCountdown();
      stopRecording();
      startSeq++;
      stopCamera();
    } else {
      startCamera();
    }
  });
}

async function init() {
  applyPrefsUI();
  bindEvents();

  try {
    db = await openDB();
  } catch (err) {
    console.warn(err);
    db = null;
  }
  try {
    items = (await dbAll()).sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    console.warn(err);
    items = [];
  }
  updateGalleryButton();
  navigator.storage?.persist?.().catch(() => {});

  startCamera();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
