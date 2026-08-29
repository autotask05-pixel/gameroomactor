# Architecture & Module Breakdown

This repository implements a **real-time multiplayer game server** powered by **Cloudflare Workers** and **@cloudflare/actors (Durable Objects)**. It features high-frequency tick simulation (256 Hz), zero-allocation binary protocol broadcasting, WebSocket hibernation persistence, a full match state machine with start/end conditions, and dynamic multi-room routing.

---

## 📁 Directory Structure & File Purpose

```
s5/
├── src/
│   ├── engine/                # Reusable Real-Time Actor Infrastructure
│   │   ├── hibernation.ts     # Persistence layer for WebSocket attachment rehydration
│   │   ├── metrics.ts         # Latency, execution time, tick drift & percentile analytics
│   │   └── ticker.ts          # Event-driven time accumulator & hibernation catch-up ticker
│   │
│   ├── game/                  # Application-Specific Game Domain Logic
│   │   ├── config.ts          # Game balance, arena geometry & match lifecycle constants
│   │   ├── physics.ts         # Spatial movement, arena boundary clamping & collision math
│   │   ├── protocol.ts        # ArrayBuffer binary snapshot serializer (Header + Players + Collectibles)
│   │   ├── stateMachine.ts    # Game phase lifecycle (LOBBY -> COUNTDOWN -> PLAYING -> GAME_OVER)
│   │   └── types.ts           # TypeScript interfaces for players, inputs, items & snapshots
│   │
│   ├── actors/                # Cloudflare Actor Instances
│   │   └── GameRoomActor.ts   # Durable Object Actor handling multi-room WebSockets & tick loops
│   │
│   ├── index.ts               # Primary Cloudflare Worker entrypoint & actor export
│   │
│   ├── config.ts              # Compatibility re-export header
│   ├── types.ts               # Compatibility re-export header
│   ├── protocol.ts            # Compatibility re-export header
│   └── actor.ts               # Compatibility re-export header
│
├── index.html                 # HTML5 Canvas client UI with multi-room joining & controls
├── wrangler.jsonc             # Cloudflare Worker & Durable Object configuration
└── package.json               # Dependency definitions & scripts
```

---

## 🔍 Detailed Purpose of Every File

### 1. Reusable Engine Infrastructure (`src/engine/`)

- **`src/engine/hibernation.ts`**
  - **Purpose**: Provides zero-overhead state persistence using Cloudflare Workers' WebSocket Hibernation API.
  - **Functionality**: Wraps `ws.serializeAttachment()` and `ws.deserializeAttachment()`. When an actor instance is evicted from memory to save CPU cost, active state (player data, sequence numbers, score) remains attached to the native socket. Upon waking up on a new message, `HibernationManager` rehydrates the player state instantly without requiring database queries.

- **`src/engine/metrics.ts`**
  - **Purpose**: Collects and measures real-time server health and performance analytics.
  - **Functionality**: Tracks rolling execution latency (P95, P99), tick drift, input rate, snapshot broadcast rate, and late ticks using sliding window samples. Exposes metrics via the `/metrics` HTTP endpoint.

- **`src/engine/ticker.ts`**
  - **Purpose**: Manages event-driven simulation tick accumulation and fast-forward catchup loops.
  - **Functionality**: Replaces high-overhead `setInterval` timers with delta-time calculations triggered reactively on incoming WebSocket frames or events. Clamps catch-up ticks (`MAX_CATCHUP_TICKS`) to protect against CPU overrun after extended idle hibernation.

---

### 2. Application Game Logic Layer (`src/game/`)

- **`src/game/config.ts`**
  - **Purpose**: Houses configuration parameters and game balance constants.
  - **Functionality**: Defines `TICK_RATE` (256 Hz), `TICK_PERIOD_MS` (~3.9 ms), arena dimensions (800x600), player radius, movement speed, max input queue depth, match duration (60s), countdown duration (3s), and target win score (15 points).

- **`src/game/types.ts`**
  - **Purpose**: Contains TypeScript types and interface definitions.
  - **Functionality**: Defines `GamePhase` ('LOBBY' | 'COUNTDOWN' | 'PLAYING' | 'GAME_OVER'), `Direction`, `QueuedInput`, `Player`, `Collectible`, and `MatchSummary`.

- **`src/game/physics.ts`**
  - **Purpose**: Pure mathematical engine for entity movement and spatial interaction.
  - **Functionality**: Handles player directional movement step math, arena boundary clamping, player-vs-player circle collision prevention, and player-vs-collectible item pickup checks.

- **`src/game/protocol.ts`**
  - **Purpose**: Binary network snapshot serializer for high-frequency low-latency networking.
  - **Functionality**: Encodes server state into a zero-allocation `ArrayBuffer` using a `DataView`. Header includes magic header (`0x4753`), protocol version (`2`), game phase code, tick index, server timestamp, execution latency, countdown/match timers, winner ID, active players, and spawned gold collectibles.

- **`src/game/stateMachine.ts`**
  - **Purpose**: Manages match lifecycle transitions and win/loss rules.
  - **Functionality**: Controls phase transitions:
    1. **`LOBBY`**: Waiting for minimum required players (2+). Manual start option available.
    2. **`COUNTDOWN`**: 3-second warning timer before match kickoff.
    3. **`PLAYING`**: 60-second active gameplay. Spawns collectible gold coins. Checks for target win condition (first player to reach 15 points) or time expiry.
    4. **`GAME_OVER`**: Declares match winner, pauses gameplay for 5 seconds, and resets the room back to `LOBBY`.

---

### 3. Actor & Multi-Room Layer (`src/actors/` & `src/index.ts`)

- **`src/actors/GameRoomActor.ts`**
  - **Purpose**: Cloudflare Durable Object Actor class handling stateful room orchestration.
  - **Functionality**:
    - Overrides `static nameFromRequest(request: Request)` to dynamically route incoming requests to isolated Actor instances based on `?room=<roomId>` or `?id=<roomId>`.
    - Handles WebSocket connections (`onWebSocketConnect`, `onWebSocketDisconnect`, `onWebSocketMessage`).
    - Executes input queuing, physics updates, game state machine updates, and binary snapshot broadcasts.
    - Exposes `/metrics` and `/start` HTTP routes.

- **`src/index.ts`**
  - **Purpose**: Worker entrypoint module.
  - **Functionality**: Registers `GameRoomActor` with `@cloudflare/actors` via `export default handler(GameRoomActor)` and exports the actor class for Cloudflare Workers deployment.

- **`src/config.ts`, `src/types.ts`, `src/protocol.ts`, `src/actor.ts`**
  - **Purpose**: Compatibility re-export headers mapping legacy root imports to the new modular structure.

---

### 4. Client Application (`index.html`)

- **`index.html`**
  - **Purpose**: Interactive client interface for testing multi-room gameplay.
  - **Functionality**:
    - Features a room switcher bar allowing players to enter any room ID (e.g. `room1`, `room2`, `pvp-lobby`).
    - Renders an HTML5 Canvas view displaying player circles, active collectible gold items, player labels, and real-time score indicators.
    - Decodes binary snapshots and renders game phase badges (`LOBBY`, `COUNTDOWN`, `PLAYING`, `GAME_OVER`), match timer, and leaderboard rankings.
    - Handles input capture via WASD / Arrow keys.

---

## 🎮 Game Lifecycle State Machine

```
  +-----------------------------------------------------------+
  |                          LOBBY                            |
  |  - Waiting for min players (2+)                           |
  |  - Manual / auto start trigger                            |
  +-----------------------------+-----------------------------+
                                |
                                v
  +-----------------------------------------------------------+
  |                        COUNTDOWN                          |
  |  - 3-Second match countdown timer                         |
  |  - Position lock & broadcast prepare                      |
  +-----------------------------+-----------------------------+
                                |
                                v
  +-----------------------------------------------------------+
  |                         PLAYING                           |
  |  - 60-Second match duration timer                         |
  |  - Gold coin collectibles spawn                           |
  |  - First to 15 points or top score when timer hits 0s     |
  +-----------------------------+-----------------------------+
                                |
                                v
  +-----------------------------------------------------------+
  |                        GAME_OVER                          |
  |  - Winner announcement banner                             |
  |  - 5-Second reset delay -> returns to LOBBY               |
  +-----------------------------------------------------------+
```

---

## 🌐 How Dynamic Multi-Room Creation Works

Using Cloudflare Actors SDK (`@cloudflare/actors`), room instances are created on-demand without any manual provisioning.

When a client connects to `ws://localhost:5173/ws?room=room-123`:
1. `GameRoomActor.nameFromRequest(request)` reads `room-123`.
2. Cloudflare Actors framework routes the connection to the unique Durable Object ID corresponding to `"room-123"`.
3. If `"room-123"` does not exist yet, Cloudflare instantiates a brand new `GameRoomActor` instance.
4. Each room maintains its **own independent state machine, player list, score leaderboard, and 256 Hz tick loop**.
