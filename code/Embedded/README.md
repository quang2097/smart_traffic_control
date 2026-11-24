# ESP32 traffic controller — Wokwi simulation

This project drives two groups of three LEDs (North–South and East–West) from commands queued on the Smart Traffic server. It is a **simulation controller**, not a certified controller for public-road signal hardware. RL policy inference is not connected yet; the queue API is the future integration contract.

## Strict timing contract

An admin (later the RL adapter) queues `{redAxis, redSeconds, requestId}`. `redAxis` is `north_south` or `east_west`; the other axis is green during the hold. `redSeconds` is an integer 10–180. Once a hold starts, its deadline is latched against the ESP32 monotonic clock. Incoming commands, changed server timing, HTTP latency and Wi-Fi loss cannot shorten, extend or restart that hold. The device polls the server on a separate FreeRTOS core; the GPIO/timer loop never waits on HTTP.

At expiry the previously green direction gets **3 seconds yellow**, then **2 seconds all-red**, then the opposite direction's next hold starts. These clearance intervals are additional to `redSeconds`. The red lamp can therefore remain on longer than the requested hold during clearance or offline waiting; `redSeconds` describes the red/green hold phase, not the full uninterrupted electrical red-lamp interval. Directions must alternate, so a second command cannot silently extend the same movement.

The server stores immutable commands and accepts an idempotency UUID (`requestId`) for retries. The ESP32 buffers one next command, rejects changed duplicates/replays, and never recalculates an active deadline. A pending command must have been refreshed within 5 seconds when it starts. With no fresh next command, it finishes the active hold, yellow and clearance, then holds both red. A reset starts both red and generates a new boot ID; the server aborts unfinished commands from a previous boot. Do not run two boards with the same device credential.

## Circuit

`diagram.json` contains the ESP32, all six LEDs, all six **330-ohm** series resistors, Serial Monitor links and shared ground. The LED wiring is GPIO → resistor → LED anode A; LED cathode C → ESP32 GND. No relay or external power stage is required for the simulator.

| Movement | Red | Yellow | Green |
| --- | --- | --- | --- |
| North–South | GPIO25 | GPIO26 | GPIO27 |
| East–West | GPIO18 | GPIO19 | GPIO21 |

Only one green output can be on. All permissive outputs are cleared before the next movement is enabled. Startup, no-command waiting and recovery states show both reds.

## Server setup and runtime timing

1. In `../Web/backend`, run `npm run db:migrate`, then start the backend normally. Start the web frontend (`npm run dev` in `../Web/frontend`) and sign in as admin.
2. Open **Điều khiển giao thông**. Create an intersection if needed, then open **ESP32 · Bộ điều khiển Wokwi** and refresh the intersection list.
3. Select the intersection and register an ESP32. Each intersection has at most one device. The server displays a one-time device ID/token configuration. The token is stored only as a SHA-256 digest in PostgreSQL.
4. Enter a backend address reachable from Wokwi. With the Wokwi **private IoT gateway**, use `http://host.wokwi.internal:3000`. Wokwi's public gateway cannot reach your computer's localhost; it needs a publicly reachable backend/tunnel. For HTTPS, provide the server's CA PEM in the dashboard CA field (or the Serial JSON `ca` property). Firmware verifies certificates and never calls `setInsecure()`.
5. Run the simulator, paste the generated **one-line JSON** into Serial Monitor and send a newline. The board saves connection settings in Preferences/NVS and restarts while all-red. Default Wi-Fi is `Wokwi-GUEST` with an empty password. The JSON can additionally set `ssid` and `password` for another network.
6. Queue alternating directions and hold durations in the dashboard. The active timer never changes; new commands wait. All timing changes happen at runtime—**no rebuild or reflash**. The existing server-only cyclic signal simulation remains independent; device status is shown separately and labelled as device-reported, without lamp-sensor confirmation.

If a credential is lost, use **Tạo lại token kết nối** and enter the replacement Serial configuration while idle. Runtime connection changes are rejected during a hold/clearance; current timing cannot be cut short by a configuration update. A power reset necessarily restarts all-red. Simulator flash persistence across stopping/reopening a project depends on Wokwi; if settings disappear, paste the same Serial JSON again without rebuilding.

## Wokwi browser

Create a new **ESP32 Arduino** project in [Wokwi](https://wokwi.com/projects/new/esp32). Replace its `sketch.ino` and `diagram.json` with this project's files, add `StrictController.h` as another source file, and use `libraries.txt` (ArduinoJson 6.21.5) or add that library in Library Manager. Start simulation. Do not paste device tokens into a public project's source code; use Serial input. Initial firmware compilation is required, but changing durations never requires compilation.

## Wokwi for VS Code / PlatformIO

Open this directory in VS Code with the Wokwi extension. Build once with `pio run`, then select **Wokwi: Start Simulator**. `wokwi.toml` points to `.pio/build/esp32dev/firmware.bin` and its ELF. For the isolated tool installed during development, run `../Web/artifacts/pio-env/Scripts/python.exe -m platformio run` on Windows. Prebuilt binaries, when generated, are in `.pio/build/esp32dev/`.

Native timing tests: `g++ -std=c++17 strict_timer_test.cpp -o strict_timer_test && ./strict_timer_test` (on Windows use `strict_timer_test.exe`). These exercise the same controller class compiled into the firmware, including deadline locking, immutable pending commands, replay rejection, clearance, offline waiting and long uptime.

## API / future RL adapter

| Method | Endpoint | Authorization / body |
| --- | --- | --- |
| GET | `/api/embedded/devices` | Admin session; status + latest 20 commands |
| POST | `/api/embedded/devices` | Admin; `{intersectionId,name}` → one-time `{deviceId,token}` |
| POST | `/api/embedded/devices/:id/credential` | Admin; rotate device token |
| POST | `/api/embedded/devices/:id/queue` | Admin; `{redAxis,redSeconds,requestId}`; append only, at most 8 outstanding queued/offered commands |
| POST | `/api/embedded/exchange` | Device bearer token; `{deviceId,bootId,phase,activeId,completedId,remainingMs}` |

The exchange response is `{protocol:1,next:{id,redAxis,redSeconds,yellowSeconds:3,clearanceSeconds:2}|null,pollMs:1000}`. `activeId` remains attached through yellow/clearance; `completedId` advances only after clearance. The backend never sends a command for changing the active deadline. Queue responses distinguish a retry from a new command. Dashboard “online” means a report arrived within 10 seconds, not verified lamp operation. RL will submit the same queue contract through its server adapter; no RL policy is executed by this project today.

Official references: [Wokwi networking and gateway requirements](https://docs.wokwi.com/guides/esp32-wifi), [Wokwi project configuration](https://docs.wokwi.com/vscode/project-config), [LED anode/cathode pins](https://docs.wokwi.com/parts/wokwi-led).
