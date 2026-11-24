# Smart Traffic desktop

Electron application using the shared web interface and the existing backend. See the [client setup and connection guide](../README.md).

Install dependencies in `Web/frontend` and `Desktop`, then run `npm start` here. Run `npm run dist` for the Windows installer or `npm run pack` for the unpacked app. Use the app's connection panel to choose `http://localhost:3000`, a LAN backend, or an HTTPS tunnel.

The Hanoi camera viewer supports road/camera selection, labelled demo images, HTTP snapshots and continuous MJPEG using native session cookies. Stop and backgrounding clear the view; reconnect to resume. See [camera source setup](../Web/CAMERAS.md). `npm run test:camera-native` exercises the real native app against a disposable backend fixture.

## Video and YOLO AI demo

Sign in as an admin and open **Video & AI demo**. Desktop supports the same local video and YOLO classification `.pt` selection, draggable crop, model resolution dialog, live overlays, predictions, snapshot export and saved demo configurations as the web app. The reinforcement learning tab remains explicitly under development and does not execute policies or control lights.

The backend and its Python worker must be available. In `../Web/backend`, run `npm run ai:setup` once and start the backend normally; then run `npm start` here. The desktop client includes its own UI and does not need a Vite server. Models run on the configured backend CPU, not inside Electron. Only select trusted `.pt` checkpoints. See [the full AI demo guide](../Web/AI_DEMO.md).

AI-specific native requests permit model uploads up to the backend's 100 MB checkpoint limit, frame requests up to 6 MB and longer model initialization. Normal account routes retain their 8 KB / 10-second limits. Local video blobs are allowed by the app's content security policy. Video/inference pauses when the window is hidden or minimized.

Run `npm test` for native bridge validation, `npm run test:smoke` for account/traffic regression tests, and `npm run test:ai` for the actual packaged protocol + native cookie bridge + YOLO runtime workflow. The AI test needs the initialized local test database and `npm run ai:setup`; it creates its own disposable admin and untrained/synthetic model/video assets, cleans up the admin, and saves screenshots under `release/screenshots`.

## Default server library

The backend lists files in `Web/backend/demo-library/videos`, `models` and `policies` (or an absolute `AI_LIBRARY_DIR` with these subfolders). Add your own videos/checkpoints and refresh the library in the app. No sample assets are passed off as real traffic data. The video route supports authenticated byte-range playback and seeking. Classification models selected from the server stay on the server; inference runs there.
Web/Desktop offer both **Server library** and **On this device** for video/model selection. Android only offers the server library. The local-file workflow remains available here.
