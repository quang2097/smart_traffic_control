# Default AI demo library

Add real videos to `videos/` (`.mp4` H.264 or `.webm`) and trained Ultralytics classification checkpoints to `models/` (`.pt`). Optional future RL policy files go in `policies/` (`.pt`, `.pth`, `.onnx`, `.zip`); these are listed only and never executed by the RL screen.

Click **Refresh server library** in the app after copying files. Filenames become display names. All three clients use this same catalog. Web/Desktop can also choose local files; Android only offers this server catalog.

Alternatively set `AI_LIBRARY_DIR` to an absolute server directory containing the same three subfolders. Files stay on the backend host; selecting a server model loads it directly through the backend runtime. Video streaming requires an authenticated admin session and supports byte ranges for seeking. No full server filesystem paths are exposed to clients.

Only regular files directly inside each folder are listed. Models/policies are limited to 100 MB, videos to 2 GB. Symlinks escaping their folder are rejected. Use trusted checkpoints. The library starts empty; no synthetic assets are presented as real traffic data.
