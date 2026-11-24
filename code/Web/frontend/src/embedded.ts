type Api = (path: string, body?: unknown) => Promise<any>;
let dispose = () => {};
export function stopEmbedded() { dispose(); dispose = () => {}; }
const safe = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]!);
const axisNames: Record<string,string> = {north_south:'Đỏ Bắc–Nam / xanh Đông–Tây',east_west:'Đỏ Đông–Tây / xanh Bắc–Nam'};
export function mountEmbedded(parent: HTMLElement, api: Api) {
  stopEmbedded();
  const host = document.createElement('section'); host.className = 'embedded-panel'; parent.append(host);
  host.innerHTML = `<details><summary>ESP32 · Bộ điều khiển Wokwi</summary><p>Thời gian hiện tại được khóa trên ESP32. Chỉ thêm lệnh cho pha kế tiếp; không chỉnh sửa pha đang chạy. Sau mỗi pha có vàng 3s và đỏ toàn phần 2s. Chưa có lệnh mới hoặc mất kết nối: giữ đỏ toàn phần sau khi hoàn thành pha hiện tại.</p><p class="muted">Dữ liệu bên dưới do thiết bị báo cáo, không phải cảm biến xác nhận đèn. Đồng hồ mô phỏng máy chủ phía trên hoạt động độc lập.</p><label for="embedded-server">Địa chỉ backend mà Wokwi truy cập được<input id="embedded-server" type="url" value="http://host.wokwi.internal:3000"></label><label for="embedded-ca">CA cho HTTPS (để trống nếu dùng HTTP qua private gateway)<textarea id="embedded-ca" rows="2" placeholder="-----BEGIN CERTIFICATE-----"></textarea></label><form id="embedded-enroll"><label for="embedded-intersection">Nút giao<select id="embedded-intersection" name="intersectionId" required><option value="">Đang tải…</option></select></label><label for="embedded-name">Tên ESP32<input id="embedded-name" name="name" required maxlength="120" placeholder="ESP32 Wokwi 01"></label><button type="submit">Đăng ký ESP32</button></form><div id="embedded-credentials" hidden><p>Thông tin kết nối chỉ hiện một lần. Dán JSON một dòng này vào Serial Monitor của ESP32 khi hai hướng đang đỏ. Không đưa token vào mã nguồn Wokwi.</p><textarea id="embedded-json" readonly rows="5" aria-label="Cấu hình Serial ESP32"></textarea></div><div class="dashboard-heading"><h3>Thiết bị & hàng đợi pha</h3><button type="button" id="embedded-refresh">Tải lại thiết bị</button></div><p id="embedded-message" role="status" aria-live="polite"></p><div id="embedded-devices"></div></details>`;
  let devices: any[] = [], busy = false;
  const report = (message: string) => { host.querySelector('#embedded-message')!.textContent = message; };
  const credentials = (data: any) => {
    const server = host.querySelector<HTMLInputElement>('#embedded-server')!.value.trim();
    const ca = host.querySelector<HTMLTextAreaElement>('#embedded-ca')!.value.trim();
    host.querySelector<HTMLElement>('#embedded-credentials')!.hidden = false;
    host.querySelector<HTMLTextAreaElement>('#embedded-json')!.value = JSON.stringify({server,deviceId:data.deviceId,token:data.token,ssid:'Wokwi-GUEST',password:'',...(ca?{ca}:{})});
    report('Đã tạo thông tin kết nối. Lưu ngay; server chỉ lưu digest của token.');
  };
  function updateTelemetry() {
    for (const device of devices) {
      const card = host.querySelector<HTMLElement>(`[data-esp="${device.id}"]`); if (!card) continue;
      const state = device.reported;
      const phaseNames:Record<string,string>={waiting:'Giữ đỏ toàn phần',green:'Pha đỏ/xanh đang khóa',yellow:'Chuyển vàng 3s',clearance:'Đỏ toàn phần 2s'};
      card.querySelector('[data-telemetry]')!.textContent = device.online ? `${phaseNames[state?.phase] || 'Đang kết nối'} · còn ${Math.ceil((state?.remainingMs || 0)/1000)}s tại lần báo cáo cuối · lệnh ${state?.activeId || '—'}` : 'Chưa có báo cáo mới / ngoại tuyến. ESP32 tự hoàn thành timer và giữ đỏ khi hết lệnh.';
      card.querySelector('[data-seen]')!.textContent = device.last_seen ? `Báo cáo cuối: ${new Date(device.last_seen).toLocaleTimeString('vi-VN')}` : 'Chưa kết nối lần nào.';
      card.querySelector('[data-commands]')!.innerHTML = device.commands.length ? device.commands.map((command:any) => `<li>#${command.id} · ${axisNames[command.red_axis]} · ${command.red_seconds}s · ${safe(command.status)}</li>`).join('') : '<li>Chưa có lệnh. Thêm pha để bắt đầu.</li>';
      const select = card.querySelector<HTMLSelectElement>('[name=redAxis]')!;
      if (document.activeElement !== select) select.value = device.nextRedAxis;
    }
  }
  async function load(redraw = false) {
    if (busy) return; busy = true;
    try {
      const result = await api('/api/embedded/devices'); if (!host.isConnected) return;
      const changed = devices.length !== result.devices.length; devices = result.devices;
      if (redraw || changed) host.querySelector('#embedded-devices')!.innerHTML = devices.map(device => `<article class="intersection-card" data-esp="${device.id}"><h3>${safe(device.name)} · ${safe(device.intersection_name)}</h3><p class="muted">ID: ${device.id}</p><p data-telemetry></p><p data-seen class="muted"></p><form data-enqueue="${device.id}"><label>Hướng đỏ cho pha tiếp theo<select name="redAxis"><option value="north_south">${axisNames.north_south}</option><option value="east_west">${axisNames.east_west}</option></select></label><label>Thời gian giữ pha (giây)<input type="number" name="redSeconds" min="10" max="180" value="30" required></label><button type="submit">Thêm pha kế tiếp · không đổi timer hiện tại</button></form><ol data-commands></ol><button type="button" data-rotate="${device.id}">Tạo lại token kết nối</button></article>`).join('') || '<p>Chưa đăng ký ESP32.</p>';
      updateTelemetry();
    } catch(error) { report((error as Error).message); } finally { busy = false; }
  }
  host.addEventListener('submit', async event => {
    event.preventDefault();event.stopPropagation();
    const form = event.target as HTMLFormElement, button = form.querySelector<HTMLButtonElement>('button[type=submit]')!;button.disabled = true;
    const data = new FormData(form);
    try {
      if (form.id === 'embedded-enroll') {
        credentials(await api('/api/embedded/devices',{intersectionId:data.get('intersectionId'),name:data.get('name')}));
        await load(true);
      } else {
        await api(`/api/embedded/devices/${form.dataset.enqueue}/queue`,{redAxis:data.get('redAxis'),redSeconds:Number(data.get('redSeconds')),requestId:crypto.randomUUID()});
        report('Đã xếp hàng pha mới. Timer đang chạy trên ESP32 không thay đổi.'); await load();
      }
    } catch(error) { report((error as Error).message); } finally { button.disabled=false; }
  });
  host.addEventListener('click', async event => {
    const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-rotate]');if(!button)return;
    button.disabled=true;try{credentials(await api(`/api/embedded/devices/${button.dataset.rotate}/credential`,{}));}catch(error){report((error as Error).message);}finally{button.disabled=false;}
  });
  host.querySelector('#embedded-refresh')!.addEventListener('click',()=>{void load(true);void intersections();});
  async function intersections() {
    try {
      const result=await api('/api/traffic/intersections');if(!host.isConnected)return;
      const select=host.querySelector<HTMLSelectElement>('#embedded-intersection')!,previous=select.value;
      select.replaceChildren(new Option('Chọn nút giao',''),...result.intersections.map((row:any)=>new Option(row.name,row.id)));select.value=previous;
    }catch(error){report((error as Error).message);}
  }
  void load(true);void intersections();const timer=setInterval(()=>{if(host.isConnected)void load();},2000);
  dispose=()=>{clearInterval(timer);host.remove();};
}
