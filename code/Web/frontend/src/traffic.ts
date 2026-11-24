import { mountEmbedded, stopEmbedded } from "./embedded";
type Api = (path: string, body?: unknown) => Promise<any>;
type Intersection = {
  id: string; name: string; location: string; mode: string; version: number;
  north_south_green: number; east_west_green: number; yellow: number; all_red: number;
  signals: { northSouth: string; eastWest: string; remaining: number | null };
};
let timer: ReturnType<typeof setInterval> | undefined;
export function stopDashboard() { clearInterval(timer); stopEmbedded(); }
const escape = (text: unknown) => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const colors: Record<string, string> = { red: 'Đỏ', yellow: 'Vàng', green: 'Xanh' };
const modes: Record<string, string> = { automatic: 'Chu kỳ tự động', all_red: 'Giữ đỏ toàn phần' };
const timingFields = (row: Intersection) => ([['north_south_green', 'Xanh Bắc–Nam', 10, 180], ['east_west_green', 'Xanh Đông–Tây', 10, 180], ['yellow', 'Vàng', 3, 10], ['all_red', 'Đỏ toàn phần', 2, 10]] as const).map(([key, label, min, max]) => `<label>${label} (giây)<input type="number" name="${key}" min="${min}" max="${max}" value="${row[key]}" required></label>`).join('');

export function mountDashboard(host: HTMLElement, role: 'admin' | 'user', api: Api) {
  let rows: Intersection[] = [];
  let refreshing = false;
  host.innerHTML = `<div class="simulation-note"><strong>MÔ PHỎNG PHẦN MỀM</strong><p>Tín hiệu được tính từ cấu hình máy chủ. Chưa kết nối bộ điều khiển đèn thực tế.</p></div><div class="dashboard-heading"><h3>Nút giao & tín hiệu</h3><button type="button" id="refresh-traffic">Tải lại</button></div><p id="traffic-status" role="status" aria-live="polite">Đang tải…</p>${role === 'user' ? '<p>Bạn có quyền xem. Liên hệ quản trị viên để thay đổi cấu hình.</p>' : '<details class="new-intersection"><summary>+ Thêm nút giao</summary><form id="intersection-form"><label for="intersection-name">Tên nút giao</label><input id="intersection-name" name="name" maxlength="120" required><label for="intersection-location">Vị trí</label><input id="intersection-location" name="location" maxlength="240" required><button class="primary" type="submit">Tạo nút giao ở chế độ đỏ toàn phần</button></form></details>'}<div id="intersection-list" class="intersection-list"></div><section id="signal-history" aria-live="polite"></section>`;
  const status = host.querySelector<HTMLElement>('#traffic-status')!;
  const list = host.querySelector<HTMLElement>('#intersection-list')!;
  const report = (message: string, error = false) => { status.textContent = message; status.className = error ? 'traffic-error' : ''; };
  function draw() {
    list.innerHTML = rows.length ? rows.map(row => `<article class="intersection-card" data-id="${row.id}"><div class="intersection-title"><div><h3>${escape(row.name)}</h3><p>${escape(row.location)}</p></div><span class="role">${modes[row.mode]}</span></div><div class="signal-pair"><div>Bắc–Nam <strong data-signal="northSouth"></strong></div><div>Đông–Tây <strong data-signal="eastWest"></strong></div><p data-countdown></p></div><p class="plan-summary">Xanh B–N ${row.north_south_green}s · Xanh Đ–T ${row.east_west_green}s · Vàng ${row.yellow}s · Đỏ toàn phần ${row.all_red}s</p>${role === 'admin' ? `<details><summary>Cấu hình tín hiệu</summary><form data-configure="${row.id}"><label>Chế độ<select name="mode"><option value="all_red" ${row.mode === 'all_red' ? 'selected' : ''}>Giữ đỏ toàn phần</option><option value="automatic" ${row.mode === 'automatic' ? 'selected' : ''}>Chu kỳ tự động</option></select></label><div class="timing-grid">${timingFields(row)}</div><p class="muted">Lưu cấu hình sẽ bắt đầu lại bằng khoảng đỏ toàn phần.</p><button class="primary" type="submit">Lưu cấu hình</button></form></details>` : ''}<button type="button" class="history-button" data-history="${row.id}">Xem lịch sử thay đổi</button></article>`).join('') : '<div class="empty-state">Chưa có nút giao. Quản trị viên có thể thêm nút giao để bắt đầu.</div>';
    updateSignals(rows);
  }
  function updateSignals(latest: Intersection[]) {
    latest.forEach(row => {
      const card = list.querySelector<HTMLElement>(`[data-id="${row.id}"]`);
      if (!card) return;
      for (const axis of ['northSouth', 'eastWest'] as const) {
        const el = card.querySelector<HTMLElement>(`[data-signal="${axis}"]`)!;
        el.textContent = colors[row.signals[axis]];
        el.className = `signal-color ${row.signals[axis]}`;
      }
      card.querySelector('[data-countdown]')!.textContent = row.signals.remaining === null ? 'Đang giữ đỏ toàn phần' : `Chuyển pha sau ${row.signals.remaining} giây`;
    });
  }
  async function load(redraw = true) {
    if (refreshing && !redraw) return;
    refreshing = true;
    try {
      const data = await api('/api/traffic/intersections');
      if (!host.isConnected) return;
      const latest: Intersection[] = data.intersections;
      // Never overwrite an administrator's unsaved form on a background poll.
      const changed = latest.length !== rows.length || latest.some(row => rows.find(old => old.id === row.id)?.version !== row.version);
      if (redraw) { rows = latest; draw(); }
      else if (!changed) updateSignals(latest);
      else {
        host.querySelectorAll<HTMLElement>('[data-signal]').forEach(el => { el.textContent = 'Cần tải lại'; el.className = 'signal-color'; });
        host.querySelectorAll('[data-countdown]').forEach(el => { el.textContent = 'Cấu hình đã thay đổi'; });
      }
      report(changed && !redraw ? 'Cấu hình đã thay đổi. Nhấn Tải lại để xem dữ liệu mới trước khi lưu.' : `Cập nhật máy chủ: ${new Date(data.serverTime).toLocaleTimeString('vi-VN')}`);
    } catch (error) {
      if (host.isConnected) {
        // Remove stale colors when the connection cannot confirm state.
        host.querySelectorAll<HTMLElement>('[data-signal]').forEach(el => { el.textContent = 'Không có dữ liệu'; el.className = 'signal-color'; });
        host.querySelectorAll('[data-countdown]').forEach(el => { el.textContent = 'Mất kết nối máy chủ'; });
        report((error as Error).message, true);
      }
    } finally { refreshing = false; }
  }
  host.querySelector('#refresh-traffic')!.addEventListener('click', () => { void load(); });
  host.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const data = new FormData(form);
    button.disabled = true;
    try {
      if (form.id === 'intersection-form') {
        await api('/api/traffic/intersections', { name: data.get('name'), location: data.get('location') });
        form.reset();
      } else {
        const row = rows.find(row => row.id === form.dataset.configure)!;
        await api(`/api/traffic/intersections/${row.id}/configure`, { version: row.version, mode: data.get('mode'), north_south_green: Number(data.get('north_south_green')), east_west_green: Number(data.get('east_west_green')), yellow: Number(data.get('yellow')), all_red: Number(data.get('all_red')) });
      }
      await load();
    } catch (error) { report((error as Error).message, true); }
    finally { button.disabled = false; }
  });
  host.addEventListener('click', async event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-history]');
    if (!button) return;
    button.disabled = true;
    try {
      const data = await api(`/api/traffic/intersections/${button.dataset.history}/history`);
      if (!host.isConnected) return;
      const row = rows.find(row => row.id === button.dataset.history)!;
      host.querySelector('#signal-history')!.innerHTML = `<h3>Lịch sử · ${escape(row.name)}</h3><ol class="history-list">${data.changes.map((change: any) => `<li><strong>${change.action === 'created' ? 'Tạo nút giao' : 'Cập nhật cấu hình'}</strong> · ${escape(change.actor_name || 'Tài khoản đã xóa')}<br><time>${escape(new Date(change.created_at).toLocaleString('vi-VN'))}</time> · ${escape(modes[change.configuration.mode])}<br>Xanh B–N ${escape(change.configuration.north_south_green)}s · Xanh Đ–T ${escape(change.configuration.east_west_green)}s · Vàng ${escape(change.configuration.yellow)}s · Đỏ toàn phần ${escape(change.configuration.all_red)}s</li>`).join('')}</ol>`;
    } catch (error) { report((error as Error).message, true); }
    finally { button.disabled = false; }
  });
  if (role === 'admin') mountEmbedded(host, api);
  void load();
  timer = setInterval(() => { if (host.isConnected) void load(false); }, 2000);
}
