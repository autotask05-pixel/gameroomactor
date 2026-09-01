

***

# 🎮 Multi-Instance Multiplayer Game Server

A scalable, authoritative real-time game server built using [Cloudflare Actors](https://developers.cloudflare.com/workers/runtime-apis/durable-objects/). It manages WebSocket connections, processes player inputs, runs a server-side game loop with collision detection, and broadcasts optimized binary state snapshots to all clients.

## 🚀 Key Features

*   **Multi-Room Architecture:** Infinitely scalable instances routed dynamically via the `?roomId=` query parameter. No pre-allocation required.
*   **Dynamic Tick Rate:** The first player in a room dictates the server's update rate (default 20Hz, up to 512Hz).
*   **Ultra-Fast Binary Protocol:** Uses `ArrayBuffer` and `DataView` for high-performance, low-bandwidth communication, with a JSON fallback.
*   **Authoritative State:** Server processes inputs, handles 2D circular collision detection, and broadcasts the absolute truth to clients.
*   **In-Memory Performance:** State is strictly in-memory to ensure zero latency overhead from storage operations.

---

## 📡 Connection & Routing

Connect to the server via WebSocket. You can spawn or join isolated game rooms by providing a `roomId`.

**Endpoint:** `ws://<YOUR_WORKER_URL>/ws?roomId=my-room-123&serverHz=30`

*   `roomId`: (Optional) The unique identifier for the game instance. Defaults to `global-lobby`.
*   `serverHz`: (Optional) The requested tick rate for the room (1-512). Only applied if you are the first player to join the room.

---

## 🕹️ Client-Server Protocol

### 1. Server -> Client (Welcome Message)
Upon connecting, the server sends a JSON welcome payload:
```json
{
  "type": "welcome",
  "playerId": 1,
  "tickRate": 30,
  "snapshotVersion": 1
}
```

### 2. Client -> Server (Player Input)
Clients can send input using either **Binary** .

**Option A: Binary Input (14 bytes)**
*   `[0]` `Uint8`: Message Type (Must be `1` for Input)
*   `[1-4]` `Uint32`: Sequence Number (Little Endian)
*   `[5-12]` `Float64`: Client Timestamp (Little Endian)
*   `[13]` `Uint8`: Direction (`1`=Up, `2`=Down, `3`=Left, `4`=Right)

**Option B: JSON Input**
```json
{
  "type": "input",
  "seq": 101,
  "clientTimestamp": 1690000000000,
  "input": "U" // 'U', 'D', 'L', or 'R'
}
```

### 3. Server -> Client (State Snapshot)
The server broadcasts the game state to all players on every tick using a tightly packed binary buffer.

**Header (40 Bytes):**
*   `Uint16`: Magic Number (`0x4753` / "GS")
*   `Uint8`: Version (`1`)
*   `Uint32`: Server Tick
*   `Float64`: Server Timestamp
*   `Uint32`: Tick Execution Time (microseconds)
*   `Uint32`: Drift (microseconds)
*   `Uint16`: Player Count
*   *(Followed by global metrics like inputs received/processed)*

**Player Data (24 Bytes per player):**
*   `Uint32`: Player ID
*   `Float32`: X Position
*   `Float32`: Y Position
*   `Uint32`: Last Processed Input Sequence
*   `Uint16`: Input Queue Length
*   `Float32`: Input Queue Delay (ms)

---

## ⚙️ Game Loop & Mechanics

*   **Arena:** A fixed `800x600` unit map.
*   **Movement:** Players move at a fixed speed of `5` units per tick.
*   **Collision Detection:** Players have a radius of `10`. The server prevents overlapping entities using a squared-distance calculation.
*   **Event-Driven Ticks:** The server fast-forwards and processes loops seamlessly (`pumpTicks`) based on the room's set `tickRate`.

---

## 🛠️ Deployment

1. Make sure you have [Wrangler](https://developers.cloudflare.com/workers/wrangler/) installed.
2. Ensure your `wrangler.toml` is configured for Cloudflare Actors/Durable Objects.
3. Deploy the worker:
   ```bash
   npm create cloudflare@latest gameroom-app -- --template autotask05-pixel/gameroomactor
   cd gameroom-app
   npx wrangler dev
   npx wrangler deploy
   ```


