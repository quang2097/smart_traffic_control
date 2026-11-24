# Video classification and reinforcement learning demo

## Run

The web application now opens **Video & AI demo** after sign-in. Existing traffic controls and cameras remain accessible through the workspace navigation.

1. Install [uv](https://docs.astral.sh/uv/getting-started/installation/) if unavailable.
2. In `backend`, run `npm run ai:setup` once. This creates an isolated Python 3.12 environment and installs Ultralytics, PyTorch, FastAPI and the local worker dependencies. System Python 3.15 is not used.
3. Start the database and backend as usual (`npm run dev` in `backend`). Start the frontend with `npm run dev` in `frontend`.
4. Open http://localhost:5173 in a browser and sign in as an **admin**. The backend starts the Python worker automatically when a model request arrives. No separate Python terminal or public Python port is required.

## Computer vision workflow

- Choose a local video (MP4 H.264 or WebM are good browser-compatible choices).
- Choose your **Ultralytics YOLO classification `.pt` checkpoint**, up to 100 MB, then click **Nạp model**. Detection, segmentation and arbitrary PyTorch state dictionaries are not classification checkpoints and are rejected. Class names come from the checkpoint. Use only trusted `.pt` files; checkpoint loading executes model code on the backend. This is why model operations require admin privileges.
- Click **Kéo chọn vùng**, then drag a rectangle over the paused video in any direction. On release, enter the model input width and height in the dialog. Each dimension accepts an integer from 32 to 2048. Cancel / Escape retains the previous crop.
- The preview shows the actual selected region after resizing. **Toàn khung hình** restores the whole image, and **Độ phân giải** reopens the size dialog. Stretch resize intentionally maps the entire crop to the chosen width and height; choose the matching aspect ratio if you want to avoid distortion.
- Click **Phát & phân loại**. A class label and confidence appear over the selected region of the playing video. Top-five classes, model inference time, actual result rate and source-frame timestamp appear beside it. Pause, seek, loop and replay use the same video. Changing the video resets the crop and clears old results.
- **Lưu ảnh có nhãn** exports the current video frame with its visible overlay. **Lưu cấu hình demo** exports the video/model filenames, normalized crop, resolution and target rate as JSON. Import it to restore those settings, then reselect the matching video and model; browsers do not grant persistent access to arbitrary local files.
- **Gỡ model** releases the account's model from the worker. Leaving the account screen also releases it.

The original video stays in the browser; only JPEG images of the resized crop and the selected checkpoint are sent to your configured backend. Model uploads are temporary and never registered in the database. A worker keeps at most three account models, one per account, with a 30-minute idle expiry checked on subsequent requests. Loading another model for the same account replaces its previous model, including in another tab. Restarting the backend clears loaded models.

## Inference behavior

The worker runs **actual PyTorch inference on CPU**, with RGB float32 values divided by 255, batch size one and `[1,3,height,width]` tensor layout. Direct tensor input avoids a second implicit center crop. This targets standard Ultralytics YOLO classification checkpoints; checkpoints with custom preprocessing or custom architecture modules need matching code. Set the chosen resolution to match training. Model loading infers a suggested size from checkpoint metadata when available.

Playback follows the video's clock. The browser sends one inference request at a time and samples the latest frame at the selected target rate (2, 5, 10 or 15 per second). It drops intermediate video frames rather than building a request queue. Actual speed depends on model size, crop resolution, CPU and network latency; this does not guarantee inference on every video frame. Results more than 1.5 seconds behind playback are suppressed. Seeking, input changes and errors invalidate pending results. Lower the input resolution or use a smaller classifier if the model cannot keep up.

The Node API authenticates requests, checks the browser origin, validates model size and forwards them to a dynamically allocated loopback-only Python worker using a per-process secret. The Python worker additionally separates models by account and serializes computation to bound concurrent CPU work. No model files, crop images or predictions are stored in PostgreSQL. The demo does not change traffic signal state.

This feature supports **web, Electron Desktop and Android**. Web and Desktop can select **On this device** or **Server library** separately for videos and classification models. Android only renders server selectors; it has no local video/model/policy/configuration file inputs, and its application request layer rejects local model upload calls. Classification inference always runs on the backend. Android supports touch crop selection, exact model resolution, live overlays, seeking and native snapshot/configuration export. The RL screen remains non-executable on all platforms.

## Default server files

Put your own videos in `backend/demo-library/videos/` (`.mp4` H.264 or `.webm`), classification `.pt` checkpoints in `backend/demo-library/models/`, and optional future policy files in `backend/demo-library/policies/`. Alternatively set `AI_LIBRARY_DIR` to an absolute directory with those three folders and restart the backend. Click **Làm mới thư viện máy chủ** to refresh the lists. Files are displayed by filename. Videos are limited to 2 GB and models/policies to 100 MB. The library begins empty; generated QA assets are not installed as real defaults. No database migration is needed.

Server video playback stays on the app origin using authenticated native proxies on Desktop/Android and same-origin HTTP on the web. Byte ranges support seeking without loading the whole video into memory. The configured backend must be reachable by the device. Models selected from the server are loaded by the server, without transferring checkpoints to the phone. Server paths never appear in catalog responses; clients select opaque IDs. Direct files outside the library and symbolic-link escapes are rejected.

For Desktop, start the backend then run `npm start` in `../Desktop`; Vite is not needed. For Android, install the rebuilt debug APK from `../Android/android/app/build/outputs/apk/debug/app-debug.apk`, point its connection panel at the backend (emulator: `http://10.0.2.2:3000`, phone: the server LAN address), and sign in as admin. Both clients retain their native session cookies. The Python environment is installed only on the backend host.

## Reinforcement learning workspace

The separate **Học tăng cường** tab lets you select a server policy and video; Web/Desktop also offer local policy/video pickers. It consistently displays **Đang phát triển**. Selected policies are named in the UI but are not loaded or executed. Policy observations, action spaces and traffic-light actions remain undefined; the run button is disabled. Switching to this tab pauses the CV video. No placeholder output is presented as model inference.

## Verification

Desktop verification: in `../Desktop`, run `npm test`, `npm run test:ai`, `npm run test:smoke`, and `npm run test:camera-native`. The AI test exercises the actual Electron native bridge with a disposable real backend, real YOLO inference, local video decoding, pointer-driven cropping, rectangular input, snapshot/configuration downloads, background pause, RL file selection and logout. It saves desktop previews in `../Desktop/release/screenshots/`.

- `npm test` and `npm run build` in `frontend`: crop geometry / resolution tests and TypeScript + Vite build.
- `npm test` and `npm run build` in `backend`: existing unit tests and TypeScript build.
- `npm run ai:test` in `backend`: seven real-runtime tests using a tiny deterministic **untrained test model**, including detection-model rejection, rectangular inputs, invalid frames, owner isolation, replacement, expiry and release. This is not an accuracy benchmark for your trained checkpoint.
- For the optional API integration fixture: run `inference\.venv\Scripts\python.exe inference/make_fixture.py` on Windows (`inference/.venv/bin/python inference/make_fixture.py` on Linux/macOS), then `npx tsx --test src/demo.integration.ts` against the initialized local test database. Generated assets are explicitly marked `UNTRAINED` / `SYNTHETIC`, live under ignored `inference/.runtime/`, and are not part of the production bundle. The integration test creates and removes its own temporary accounts.

Runtime reference: [Ultralytics classification](https://docs.ultralytics.com/tasks/classify/) and [classification head output](https://docs.ultralytics.com/reference/nn/modules/head/#ultralytics.nn.modules.head.Classify).

Android server-library verification: `npm run test:ai` in `../Android` uses the real WebView/native bridge and backend. It verifies no local file inputs, authenticated server video/seek, touch crop/resizing, real classification, server RL selectors, background pause and logout. Use a disposable initialized emulator and test database.
