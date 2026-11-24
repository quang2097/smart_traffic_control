import { request, nativeClient, androidClient, saveAndroidDemoFile } from './connection';
import { cropFromPoints, pixelCrop, validResolution, type Crop } from './vision-math';

type Prediction = { classId: number; label: string; confidence: number };
let cleanup: () => void | Promise<unknown> = () => {};
export function stopAiDemo() { const previous = cleanup; cleanup = () => {}; return Promise.resolve(previous()); }

async function aiRequest(path: string, body?: unknown, timeout = 35000) {
  // Native clients use the existing authenticated HTTP bridge. Web requests allow
  // longer model initialization than the ordinary 10-second account requests.
  const native = nativeClient;
  if (native) {
    const response = await request(`/api/demo/${path}`, body);
    if (response.status >= 400) throw Object.assign(new Error(response.data.message || 'AI request failed'), { status: response.status });
    return response.data;
  }
  const response = await fetch(`/api/demo/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
  const data = await response.json().catch(() => ({ message: 'Phản hồi AI không hợp lệ.' }));
  if (!response.ok) throw Object.assign(new Error(data.message || 'Không thực hiện được yêu cầu AI.'), { status: response.status });
  return data;
}
function asBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Không đọc được tệp.')); reader.readAsDataURL(file); });
}

export function mountAiDemo(host: HTMLElement, role: 'admin' | 'user') {
  stopAiDemo();
  const unavailableNative = Boolean(window.desktopTraffic) && window.desktopTraffic?.aiDemoVersion !== 1;
  const sourceFields = (kind: 'video' | 'model') => `<label for="demo-${kind}-source">Nguồn ${kind === 'video' ? 'video' : 'model'}<select id="demo-${kind}-source"><option value="server">Thư viện máy chủ</option>${androidClient ? '' : '<option value="local" selected>Trên thiết bị</option>'}</select></label><div id="demo-${kind}-server-box" ${androidClient ? '' : 'hidden'}><label for="demo-server-${kind}">${kind === 'video' ? 'Video' : 'Model'} có sẵn trên máy chủ<select id="demo-server-${kind}"><option value="">Đang tải thư viện…</option></select></label>${kind === 'video' ? '<button type="button" id="demo-use-server-video">Mở video máy chủ</button>' : ''}</div>${androidClient ? '' : `<div id="demo-${kind}-local-box"><label for="demo-${kind}-file">${kind === 'video' ? 'Video trên máy' : 'YOLO classification checkpoint'}<input id="demo-${kind}-file" type="file" accept="${kind === 'video' ? 'video/*' : '.pt'}" ${kind === 'model' && role !== 'admin' ? 'disabled' : ''}></label></div>`}`;
  host.innerHTML = `<div class="ai-header"><div><span class="ai-kicker">SMART TRAFFIC LAB</span><h3>Video & mô hình AI</h3><p>Chọn video, khoanh vùng và xem kết quả phân loại trực tiếp.</p></div><span class="ai-chip">YOLO classification · .pt</span></div><div class="ai-tabs" role="tablist" aria-label="Không gian AI"><button type="button" role="tab" id="vision-tab" aria-controls="vision-panel" aria-selected="true">Thị giác máy tính</button><button type="button" role="tab" id="rl-tab" aria-controls="rl-panel" aria-selected="false" tabindex="-1">Học tăng cường <span>Đang phát triển</span></button></div><section id="vision-panel" role="tabpanel" aria-labelledby="vision-tab"><div class="ai-workspace"><aside class="ai-setup"><div class="ai-step"><h4>Video & model tương ứng</h4><button type="button" id="demo-library-refresh">Làm mới thư viện máy chủ</button><p id="demo-library-status" class="ai-meta" role="status">Đang tải…</p>${sourceFields('video')}<p id="demo-video-name" class="ai-meta">Chưa chọn video</p>${sourceFields('model')}<p class="ai-meta">Model .pt tin cậy · tối đa 100 MB · nhãn lấy từ model</p><button type="button" id="demo-load-model" ${role !== 'admin' || unavailableNative ? 'disabled' : ''}>Nạp model</button><p id="demo-model-name" class="ai-meta">Chưa nạp model${role !== 'admin' ? ' · yêu cầu tài khoản quản trị viên' : unavailableNative ? ' · phiên bản này chưa hỗ trợ AI demo; mở bản web hoặc cập nhật Desktop' : ''}</p><button type="button" id="demo-release" disabled>Gỡ model</button></div><div class="ai-step"><h4>Vùng ảnh đưa vào model</h4><div class="ai-button-row"><button type="button" id="demo-crop" disabled>Kéo chọn vùng</button><button type="button" id="demo-full" disabled>Toàn khung hình</button></div><p id="demo-crop-info" class="ai-meta">Toàn khung hình · chưa có video</p><button type="button" id="demo-resolution">Độ phân giải: 224 × 224</button><p class="ai-meta">Vùng đã chọn được co giãn chính xác về kích thước này; không cắt tâm lần nữa.</p><canvas id="demo-input-preview" width="224" height="224" aria-label="Ảnh thực tế đưa vào model"></canvas><span class="ai-meta">Ảnh đầu vào model · RGB / 255</span></div><details class="ai-step"><summary>Tùy chọn demo</summary><label for="demo-rate">Tần suất mục tiêu<select id="demo-rate"><option value="2">2 lần / giây</option><option value="5" selected>5 lần / giây</option><option value="10">10 lần / giây</option><option value="15">15 lần / giây</option></select></label><label class="ai-check"><input id="demo-loop" type="checkbox" checked> Lặp lại video</label><p class="ai-meta">Mỗi lần chỉ xử lý một khung hình. Tốc độ thực tế phụ thuộc model và CPU.</p><button type="button" id="demo-save">Lưu cấu hình demo</button>${androidClient ? '' : '<label for="demo-config">Mở cấu hình đã lưu<input type="file" id="demo-config" accept=".json,application/json"></label>'}</details></aside><div class="ai-view"><div class="ai-view-heading"><strong>Xem video & phân loại</strong><span id="demo-state" class="ai-chip">Chưa sẵn sàng</span></div><div id="demo-stage" class="ai-stage"><div id="demo-media" class="ai-media" hidden><video id="demo-video" preload="metadata" playsinline loop></video><canvas id="demo-overlay" aria-label="Nhãn phân loại và vùng ảnh" tabindex="0"></canvas></div><div id="demo-placeholder" class="ai-placeholder"><svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><rect x="6" y="12" width="52" height="40" rx="8" stroke="currentColor" stroke-width="2"/><path d="m27 24 14 8-14 8V24Z" fill="currentColor"/></svg><strong>Chọn video để bắt đầu</strong><span>Chọn video trên máy chủ${androidClient ? '.' : ' hoặc trên thiết bị.'} Vùng ảnh được gửi tới máy chủ AI để phân loại.</span></div></div><div class="ai-playback"><button type="button" id="demo-play" disabled>Phát & phân loại</button><label class="ai-seek-label" for="demo-seek">Vị trí video<input id="demo-seek" type="range" min="0" max="1000" value="0" disabled></label><span id="demo-time">00:00 / 00:00</span><button type="button" id="demo-snapshot" disabled>Lưu ảnh có nhãn</button></div><p id="demo-status" role="status" aria-live="polite">Chọn một video và nạp model classification .pt của bạn.</p><div class="ai-metrics"><div><span>Kết quả hiện tại</span><strong id="demo-result">Chờ phân loại</strong></div><div><span>Độ tin cậy</span><strong id="demo-confidence">—</strong></div><div><span>Thời gian model</span><strong id="demo-latency">—</strong></div><div><span>Tốc độ thực tế</span><strong id="demo-fps">—</strong></div></div><div class="ai-ranking"><h4>Top lớp dự đoán</h4><ol id="demo-predictions"><li>Chưa có kết quả. Nhấn Phát sau khi nạp video và model.</li></ol></div></div></div></section><section id="rl-panel" role="tabpanel" aria-labelledby="rl-tab" hidden><div class="rl-notice"><span class="ai-chip">ĐANG PHÁT TRIỂN</span><h3>Không gian học tăng cường</h3><p>Chuẩn bị model và video cho giai đoạn điều khiển đèn giao thông. Chưa chạy policy, chưa định nghĩa hành động và chưa kết nối điều khiển đèn.</p></div><div class="rl-grid"><div class="ai-step"><h4>Tệp thử nghiệm</h4><label for="rl-server-model">Policy trên máy chủ<select id="rl-server-model"><option value="">Chưa có policy</option></select></label><label for="rl-server-video">Video trên máy chủ<select id="rl-server-video"><option value="">Chưa có video</option></select></label>${androidClient ? '' : '<label for="rl-model">Model / policy trên thiết bị<input type="file" id="rl-model" accept=".pt,.pth,.onnx,.zip"></label><label for="rl-video">Video trên thiết bị<input type="file" id="rl-video" accept="video/*"></label>'}<p id="rl-files" class="ai-meta">Chưa chọn tệp. Policy chỉ được chọn, chưa thực thi.</p></div><div class="ai-step"><h4>Trạng thái tích hợp</h4><ul class="rl-roadmap"><li>Giao diện chuẩn bị tệp <strong>Sẵn sàng</strong></li><li>Observation / đầu vào policy <strong>Chưa định nghĩa</strong></li><li>Không gian hành động <strong>Chưa định nghĩa</strong></li><li>Điều khiển đèn <strong>Chưa kết nối</strong></li></ul><button type="button" disabled>Chạy policy · Sắp có</button></div></div></section><dialog id="demo-size-dialog" class="ai-dialog"><form id="demo-size-form"><h3>Kích thước ảnh cho model</h3><p>Vùng chọn sẽ được upscale / downscale tới độ phân giải bên dưới.</p><div class="ai-size-grid"><label for="demo-width">Chiều rộng (px)<input id="demo-width" type="number" min="32" max="2048" step="1" value="224" required></label><label for="demo-height">Chiều cao (px)<input id="demo-height" type="number" min="32" max="2048" step="1" value="224" required></label></div><p id="demo-size-error" role="alert"></p><div class="ai-button-row"><button type="button" id="demo-size-cancel">Hủy</button><button type="submit">Áp dụng vùng & kích thước</button></div></form></dialog>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`#${id}`)!;
  const video = el<HTMLVideoElement>('demo-video'), overlay = el<HTMLCanvasElement>('demo-overlay'), preview = el<HTMLCanvasElement>('demo-input-preview');
  const ctx = overlay.getContext('2d')!, input = document.createElement('canvas'), inputCtx = input.getContext('2d', { willReadFrequently: true })!;
  const status = el('demo-status'), play = el<HTMLButtonElement>('demo-play'), dialog = el<HTMLDialogElement>('demo-size-dialog');
  let disposed = false, videoUrl = '', modelId = '', modelName = '', videoName = '', modelLoading = false;
  let crop: Crop = { x: 0, y: 0, width: 1, height: 1 }, draft: Crop | undefined, selecting = false, anchor: { x: number; y: number } | undefined;
  let width = 224, height = 224, revision = 0, busy = false, running = false, lastSent = 0, frames = 0, measuredAt = performance.now(), raf = 0;
  let result: { predictions: Prediction[]; time: number; inferenceMs: number } | undefined;
  const report = (message: string, error = false) => { if (disposed) return; status.textContent = message; status.classList.toggle('ai-error', error); };
  function clearResult() {
    revision++; result = undefined; el('demo-result').textContent = 'Chờ phân loại'; el('demo-confidence').textContent = '—'; el('demo-latency').textContent = '—';
    el('demo-predictions').replaceChildren(Object.assign(document.createElement('li'), { textContent: 'Chờ khung hình mới.' }));
  }
  function updateReady() {
    const ready = Boolean(video.videoWidth && modelId && !modelLoading);
    play.disabled = !ready; el<HTMLButtonElement>('demo-release').disabled = !modelId || modelLoading;
    el('demo-state').textContent = running ? 'Đang phân loại' : ready ? 'Sẵn sàng' : modelLoading ? 'Đang nạp model' : 'Chọn video & model';
  }
  function pause() { running = false; video.pause(); play.textContent = 'Phát & phân loại'; updateReady(); }
  function info() {
    const pixels = pixelCrop(crop, video.videoWidth || 1, video.videoHeight || 1);
    el('demo-crop-info').textContent = video.videoWidth ? `Vùng: ${pixels.width} × ${pixels.height} px · x=${pixels.x}, y=${pixels.y}` : 'Toàn khung hình · chưa có video';
    preview.width = width; preview.height = height;
    el('demo-resolution').textContent = `Độ phân giải: ${width} × ${height}`;
  }
  function extract() {
    if (!video.videoWidth || video.readyState < 2) return;
    input.width = width; input.height = height;
    const box = pixelCrop(crop, video.videoWidth, video.videoHeight);
    inputCtx.imageSmoothingEnabled = true; inputCtx.imageSmoothingQuality = 'high';
    inputCtx.drawImage(video, box.x, box.y, box.width, box.height, 0, 0, width, height);
    preview.getContext('2d')!.drawImage(input, 0, 0, preview.width, preview.height);
  }
  function draw() {
    if (disposed) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (video.videoWidth) {
      const box = pixelCrop(draft || crop, overlay.width, overlay.height);
      const line = Math.max(2, overlay.width / 500), font = Math.max(15, overlay.width / 50);
      if (selecting || draft || crop.width < 0.999 || crop.height < 0.999) {
        ctx.fillStyle = '#03151088'; ctx.fillRect(0, 0, overlay.width, overlay.height); ctx.clearRect(box.x, box.y, box.width, box.height);
      }
      ctx.strokeStyle = '#a8f5c4'; ctx.lineWidth = line; ctx.setLineDash(selecting ? [line * 4, line * 3] : []); ctx.strokeRect(box.x + line, box.y + line, Math.max(0, box.width - line * 2), Math.max(0, box.height - line * 2)); ctx.setLineDash([]);
      const top = result?.predictions[0];
      if (top && !selecting && Math.abs(video.currentTime - result!.time) <= 1.5) {
        const label = `${top.label} · ${(top.confidence * 100).toFixed(1)}%`;
        ctx.font = `600 ${font}px Arial`; const maxWidth = Math.min(overlay.width - 16, ctx.measureText(label).width + font * 2);
        const x = Math.max(8, Math.min(box.x + 8, overlay.width - maxWidth - 8)), y = Math.max(8, box.y + 8);
        ctx.fillStyle = '#0c3028ee'; ctx.fillRect(x, y, maxWidth, font * 2.2); ctx.fillStyle = '#c2ffdb'; ctx.fillText(label, x + font / 2, y + font * 1.45, maxWidth - font);
      }
    }
    raf = requestAnimationFrame(draw);
  }
  async function infer(now: number) {
    if (!running || disposed || busy || selecting || dialog.open || video.paused || video.seeking || video.readyState < 2 || now - lastSent < 1000 / Number(el<HTMLSelectElement>('demo-rate').value)) return;
    busy = true; lastSent = now; const current = revision, time = video.currentTime, currentModel = modelId;
    try {
      extract();
      const data = await aiRequest('classify', { modelId: currentModel, width, height, frame: input.toDataURL('image/jpeg', 0.9).split(',')[1] });
      if (disposed || current !== revision || !running || video.seeking) return;
      if (Math.abs(video.currentTime - time) > 1.5) { clearResult(); report('Model chậm hơn video. Giảm độ phân giải để kết quả theo kịp.'); return; }
      result = { predictions: data.predictions, time, inferenceMs: data.inferenceMs };
      const top = result.predictions[0];
      el('demo-result').textContent = top.label; el('demo-confidence').textContent = `${(top.confidence * 100).toFixed(1)}%`; el('demo-latency').textContent = `${data.inferenceMs} ms`;
      frames++; const elapsed = (performance.now() - measuredAt) / 1000;
      el('demo-fps').textContent = `${(frames / Math.max(elapsed, 0.1)).toFixed(1)} fps`;
      el('demo-predictions').replaceChildren(...result.predictions.map(prediction => { const li = document.createElement('li'); const name = document.createElement('span'); name.textContent = prediction.label; const score = document.createElement('strong'); score.textContent = `${(prediction.confidence * 100).toFixed(1)}%`; const bar = document.createElement('progress'); bar.max = 1; bar.value = prediction.confidence; bar.setAttribute('aria-label', prediction.label); li.append(name, score, bar); return li; }));
      report(`Đang phân loại ${width} × ${height} · kết quả từ khung hình ${time.toFixed(2)}s`);
    } catch (error) {
      if (!disposed && current === revision) { pause(); clearResult(); if ((error as { status?: number }).status === 410) { modelId = ''; el('demo-model-name').textContent = 'Model đã hết hạn hoặc được thay thế. Nạp lại để tiếp tục.'; updateReady(); } report((error as Error).message, true); }
    } finally { busy = false; }
  }
  const ticker = setInterval(() => { void infer(performance.now()); }, 30);
  raf = requestAnimationFrame(draw);
  type Entry = { id: string; name: string; size: number; streamPath?: string };
  let catalog: { videos: Entry[]; models: Entry[]; policies: Entry[] } = { videos: [], models: [], policies: [] };
  const fillOptions = (id: string, items: Entry[]) => { const field = el<HTMLSelectElement>(id), previous = field.value; field.replaceChildren(new Option(items.length ? 'Chọn tệp trên máy chủ' : 'Chưa có tệp trên máy chủ', ''), ...items.map(item => new Option(item.name, item.id))); if (items.some(item => item.id === previous)) field.value = previous; };
  async function loadLibrary() {
    el<HTMLButtonElement>('demo-library-refresh').disabled = true;
    try {
      const data = await aiRequest('catalog'); if (disposed) return;
      catalog = data;
      fillOptions('demo-server-video', catalog.videos); fillOptions('demo-server-model', catalog.models); fillOptions('rl-server-model', catalog.policies); fillOptions('rl-server-video', catalog.videos);
      el('demo-library-status').textContent = `${catalog.videos.length} video · ${catalog.models.length} model · ${catalog.policies.length} policy. ${catalog.videos.length || catalog.models.length ? '' : 'Quản trị viên máy chủ cần thêm tệp vào thư viện.'}`;
    } catch (error) { if (!disposed) el('demo-library-status').textContent = (error as Error).message; }
    finally { if (!disposed) el<HTMLButtonElement>('demo-library-refresh').disabled = false; }
  }
  el('demo-library-refresh').onclick = () => { void loadLibrary(); };
  for (const kind of ['video', 'model']) el<HTMLSelectElement>(`demo-${kind}-source`).onchange = () => {
    pause(); clearResult(); const local = el<HTMLSelectElement>(`demo-${kind}-source`).value === 'local';
    el(`demo-${kind}-server-box`).hidden = local;
    const box = host.querySelector<HTMLElement>(`#demo-${kind}-local-box`); if (box) box.hidden = !local;
  };
  el('demo-use-server-video').onclick = () => {
    const entry = catalog.videos.find(item => item.id === el<HTMLSelectElement>('demo-server-video').value);
    if (!entry?.streamPath || !/^\/api\/demo\/videos\/[a-f0-9]{24}\/stream$/.test(entry.streamPath)) { report('Chọn video trên máy chủ trước.', true); return; }
    pause(); clearResult(); if (videoUrl.startsWith('blob:')) URL.revokeObjectURL(videoUrl); videoUrl = '';
    videoName = entry.name; video.src = entry.streamPath; video.load(); crop = { x: 0, y: 0, width: 1, height: 1 }; cancelCrop();
    el('demo-media').hidden = false; el('demo-placeholder').hidden = true; el('demo-video-name').textContent = entry.name;
    report('Đang mở video từ thư viện máy chủ…');
  };
  void loadLibrary();
  const localVideoInput = host.querySelector<HTMLInputElement>('#demo-video-file');
  if (localVideoInput) localVideoInput.onchange = () => {
    const file = el<HTMLInputElement>('demo-video-file').files?.[0]; if (!file) return;
    pause(); clearResult(); if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoName = file.name; videoUrl = URL.createObjectURL(file); video.src = videoUrl; video.load();
    crop = { x: 0, y: 0, width: 1, height: 1 }; draft = undefined; selecting = false; anchor = undefined;
    overlay.classList.remove('is-cropping'); el('demo-video-name').textContent = file.name;
    el('demo-media').hidden = false; el('demo-placeholder').hidden = true;
    report('Đang đọc video…');
  };
  video.onloadedmetadata = () => {
    if (!video.videoWidth || !Number.isFinite(video.duration)) { report('Video không có kích thước hoặc thời lượng hợp lệ.', true); return; }
    overlay.width = video.videoWidth; overlay.height = video.videoHeight;
    el('demo-time').textContent = `00:00 / ${timeText(video.duration)}`;
    el('demo-video-name').textContent = `${videoName} · ${video.videoWidth} × ${video.videoHeight}`;
    for (const id of ['demo-crop', 'demo-full', 'demo-seek', 'demo-snapshot']) (el(id) as HTMLButtonElement).disabled = false;
    info(); updateReady(); report(modelId ? 'Sẵn sàng. Chọn vùng ảnh hoặc nhấn Phát & phân loại.' : 'Video đã sẵn sàng. Nạp model classification để bắt đầu.');
  };
  video.onloadeddata = () => extract();
  video.onerror = () => { pause(); report('Không mở được video. Dùng định dạng trình duyệt hỗ trợ, ví dụ MP4 H.264 hoặc WebM.', true); };
  const timeText = (seconds: number) => `${String(Math.floor((seconds || 0) / 60)).padStart(2, '0')}:${String(Math.floor((seconds || 0) % 60)).padStart(2, '0')}`;
  video.ontimeupdate = () => { el('demo-time').textContent = `${timeText(video.currentTime)} / ${timeText(video.duration)}`; el<HTMLInputElement>('demo-seek').value = String(video.duration ? Math.round(video.currentTime / video.duration * 1000) : 0); };
  video.onended = () => { pause(); clearResult(); report('Video đã kết thúc.'); };
  video.onseeking = () => clearResult();
  video.onseeked = () => { clearResult(); extract(); lastSent = 0; };
  video.addEventListener('pause', () => { running = false; play.textContent = 'Phát & phân loại'; updateReady(); });
  video.addEventListener('play', () => { clearResult(); });
  el<HTMLInputElement>('demo-loop').onchange = event => { video.loop = (event.target as HTMLInputElement).checked; };
  el<HTMLInputElement>('demo-seek').oninput = event => { if (video.duration) video.currentTime = Number((event.target as HTMLInputElement).value) / 1000 * video.duration; };
  play.onclick = async () => {
    if (running) { pause(); return; }
    if (!modelId || !video.videoWidth) return;
    selecting = false; overlay.classList.remove('is-cropping'); frames = 0; measuredAt = performance.now(); lastSent = 0;
    try { await video.play(); running = true; play.textContent = 'Tạm dừng'; updateReady(); }
    catch { report('Không thể phát video. Hãy chọn tệp khác.', true); }
  };
  const showSize = () => { pause(); el<HTMLInputElement>('demo-width').value = String(width); el<HTMLInputElement>('demo-height').value = String(height); el('demo-size-error').textContent = ''; dialog.showModal(); };
  el('demo-resolution').onclick = showSize;
  el('demo-crop').onclick = () => { pause(); clearResult(); selecting = true; draft = undefined; overlay.classList.add('is-cropping'); overlay.focus(); report('Kéo trên video để chọn vùng. Thả chuột để nhập độ phân giải. Nhấn Esc để hủy.'); };
  const point = (event: PointerEvent) => { const rect = overlay.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }; };
  overlay.onpointerdown = event => { if (!selecting || event.button !== 0) return; event.preventDefault(); anchor = point(event); overlay.setPointerCapture(event.pointerId); };
  overlay.onpointermove = event => { if (!anchor) return; draft = cropFromPoints(anchor, point(event)); };
  overlay.onpointerup = event => {
    if (!anchor) return;
    draft = cropFromPoints(anchor, point(event)); anchor = undefined;
    if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    if (draft.width * video.videoWidth < 4 || draft.height * video.videoHeight < 4) { draft = undefined; report('Vùng chọn quá nhỏ. Kéo một hình chữ nhật lớn hơn.', true); return; }
    showSize();
  };
  const cancelCrop = () => { draft = undefined; anchor = undefined; selecting = false; overlay.classList.remove('is-cropping'); };
  overlay.onpointercancel = cancelCrop;
  overlay.onkeydown = event => { if (event.key === 'Escape') cancelCrop(); };
  dialog.oncancel = () => cancelCrop();
  el('demo-size-cancel').onclick = () => { cancelCrop(); dialog.close(); };
  el<HTMLFormElement>('demo-size-form').onsubmit = event => {
    event.preventDefault(); const nextWidth = Number(el<HTMLInputElement>('demo-width').value), nextHeight = Number(el<HTMLInputElement>('demo-height').value);
    if (!validResolution(nextWidth, nextHeight)) { el('demo-size-error').textContent = 'Nhập số nguyên từ 32 tới 2048 cho mỗi chiều.'; return; }
    width = nextWidth; height = nextHeight; if (draft) crop = draft;
    cancelCrop(); clearResult(); dialog.close(); info(); extract(); report('Đã áp dụng vùng ảnh và kích thước. Nhấn Phát để phân loại.');
  };
  el('demo-full').onclick = () => { pause(); crop = { x: 0, y: 0, width: 1, height: 1 }; cancelCrop(); clearResult(); info(); extract(); };
  el('demo-load-model').onclick = async () => {
    const serverModel = el<HTMLSelectElement>('demo-model-source').value === 'server';
    const file = host.querySelector<HTMLInputElement>('#demo-model-file')?.files?.[0];
    const selected = catalog.models.find(item => item.id === el<HTMLSelectElement>('demo-server-model').value);
    if (serverModel ? !selected : !file || !file.name.toLowerCase().endsWith('.pt')) { report('Chọn model YOLO classification .pt trước.', true); return; }
    if (!serverModel && file && (file.size > 100 * 1024 * 1024 || file.size === 0)) { report('Chọn model .pt không rỗng, tối đa 100 MB.', true); return; }
    pause(); clearResult(); modelLoading = true; updateReady(); el<HTMLButtonElement>('demo-load-model').disabled = true;
    report('Đang nạp model. Lần đầu cần khởi động Python / PyTorch…');
    try {
      const data = serverModel ? await aiRequest('model-server', { id: selected!.id }, 240000) : await aiRequest('model', { data: await asBase64(file!) }, 240000);
      if (disposed) { void aiRequest('release', { modelId: data.modelId }).catch(() => {}); return; }
      modelId = data.modelId; modelName = serverModel ? selected!.name : file!.name; width = data.width; height = data.height;
      el('demo-model-name').textContent = `${modelName} · ${data.classes} lớp · CPU`;
      info(); extract(); report('Model đã nạp. Kiểm tra độ phân giải rồi phát video để phân loại.');
    } catch (error) { report((error as Error).message, true); }
    finally { if (!disposed) { modelLoading = false; el<HTMLButtonElement>('demo-load-model').disabled = false; updateReady(); } }
  };
  el('demo-release').onclick = async () => {
    pause(); clearResult(); const id = modelId; modelId = ''; updateReady(); el('demo-model-name').textContent = 'Chưa nạp model';
    try { await aiRequest('release', { modelId: id }); report('Đã gỡ model khỏi runtime.'); } catch (error) { report((error as Error).message, true); }
  };
  const download = (blob: Blob, filename: string) => { if (androidClient) { void asBase64(blob).then(data => saveAndroidDemoFile(filename, data)).catch(error => report((error as Error).message, true)); return; } const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  el('demo-snapshot').onclick = () => {
    const canvas = document.createElement('canvas'); canvas.width = overlay.width; canvas.height = overlay.height;
    const context = canvas.getContext('2d')!; context.drawImage(video, 0, 0); context.drawImage(overlay, 0, 0);
    canvas.toBlob(blob => { if (blob) download(blob, 'traffic-classification.png'); });
  };
  el('demo-save').onclick = () => download(new Blob([JSON.stringify({ version: 1, videoName, modelName, crop, width, height, rate: Number(el<HTMLSelectElement>('demo-rate').value) }, null, 2)], { type: 'application/json' }), 'traffic-demo.json');
  const configInput = host.querySelector<HTMLInputElement>('#demo-config');
  if (configInput) configInput.onchange = async () => {
    const file = el<HTMLInputElement>('demo-config').files?.[0]; if (!file) return;
    try {
      if (file.size > 10000) throw new Error('Tệp cấu hình quá lớn.');
      const config = JSON.parse(await file.text()), box = config.crop;
      if (config.version !== 1 || !validResolution(config.width, config.height) || !box || !['x', 'y', 'width', 'height'].every(key => typeof box[key] === 'number' && Number.isFinite(box[key])) || box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 || box.x + box.width > 1 || box.y + box.height > 1 || ![2, 5, 10, 15].includes(config.rate)) throw new Error('Cấu hình demo không hợp lệ.');
      pause(); clearResult(); crop = box; width = config.width; height = config.height; cancelCrop(); el<HTMLSelectElement>('demo-rate').value = String(config.rate); info(); extract();
      report(`Đã khôi phục cấu hình. Chọn lại video ${String(config.videoName || '')} và model ${String(config.modelName || '')} tương ứng.`);
    } catch (error) { report((error as Error).message, true); }
  };
  const visibility = () => { if (document.hidden) pause(); };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('traffic-ai-paused', pause);
  const unsubscribePause = window.desktopTraffic?.onAiPause?.(pause);
  host.addEventListener('demo-pause', pause);
  const chooseTab = (rl: boolean) => {
    if (rl) pause();
    el('vision-panel').hidden = rl; el('rl-panel').hidden = !rl;
    for (const [id, selected] of [['vision-tab', !rl], ['rl-tab', rl]] as const) { el(id).setAttribute('aria-selected', String(selected)); el(id).tabIndex = selected ? 0 : -1; }
  };
  el('vision-tab').onclick = () => chooseTab(false); el('rl-tab').onclick = () => chooseTab(true);
  host.querySelector('.ai-tabs')!.addEventListener('keydown', event => { const key = (event as KeyboardEvent).key; if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) { event.preventDefault(); const rl = key === 'End' || (key !== 'Home' && el('rl-tab').getAttribute('aria-selected') !== 'true'); chooseTab(rl); el(rl ? 'rl-tab' : 'vision-tab').focus(); } });
  const rlFiles = () => {
    const model = host.querySelector<HTMLInputElement>('#rl-model')?.files?.[0], file = host.querySelector<HTMLInputElement>('#rl-video')?.files?.[0];
    const policy = catalog.policies.find(item => item.id === el<HTMLSelectElement>('rl-server-model').value);
    const serverVideo = catalog.videos.find(item => item.id === el<HTMLSelectElement>('rl-server-video').value);
    el('rl-files').textContent = `Policy: ${model?.name || policy?.name || 'chưa chọn'} · Video: ${file?.name || serverVideo?.name || 'chưa chọn'}. Chỉ chọn tệp; chưa thực thi hoặc điều khiển.`;
  };
  for (const id of ['rl-model', 'rl-video', 'rl-server-model', 'rl-server-video']) { const field = host.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`); if (field) field.onchange = rlFiles; }
  cleanup = () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('traffic-ai-paused', pause); unsubscribePause?.(); disposed = true; revision++; running = false; clearInterval(ticker); cancelAnimationFrame(raf); video.pause(); video.removeAttribute('src'); video.load(); if (videoUrl) URL.revokeObjectURL(videoUrl); if (dialog.open) dialog.close(); if (modelId) return aiRequest('release', { modelId }, 5000).catch(() => {}); };
}
