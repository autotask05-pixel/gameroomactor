Actors 
websockets
o copy memory 
hibernation 
simple multiplayer collision detection .
stated limits :1000 inputs / sec soft 
tested 2500
pricing :0.1 gbs / min (6players 20 hz)+6*60*20.(7200)360 req



# Cloudflare Actor: Real-Time Multiplayer Game Server

This repository contains a highly scalable, real-time multiplayer game server backend built using **Cloudflare Actors**. It handles WebSocket connections, authoritative game logic, and state broadcasting using an optimized binary protocol. 

## 🚀 Key Features

*   **Multi-Instance Scaling:** Instantly spin up isolated game rooms without pre-allocating resources using a `roomId` query parameter.
*   **Authoritative Game Loop:** Event-driven server ticks process inputs, movement, and collision detection to prevent client-side cheating.
*   **Dynamic Tick Rate:** The first player joining a room dictates the server speed (up to 64Hz; defaults to 20Hz).
*   **Optimized Binary Protocol:** Broadcasts game state to all connected clients via highly compressed `ArrayBuffer` packets to save bandwidth and reduce latency.
*   **Ephemeral In-Memory State:** Player states are held securely in memory for maximum performance (state is intentionally discarded on Actor hibernation/eviction).
*   **Lag Compensation & Catch-up:** Dynamic constraint system handles input queues and fast-forwards tick processing seamlessly.

## ⚙️ Game Constants & Rules

*   **Max Players per Room:** 500
*   **Arena Size:** 800 x 600
*   **Player Radius:** 10 (with basic circle-based collision detection)
*   **Speed:** 5 units per tick
*   **Max Input Queue:** 30 moves

## 🌐 Connection & Routing

### **Connecting to a Room**
Connect via WebSocket to the `/ws` endpoint.
*   **URL Format:** `wss://<your-worker-domain>/ws?roomId=<ROOM_NAME>&serverHz=<TICK_RATE>`
*   **`roomId`:** String to isolate instances. Defaults to `global-lobby` if omitted.
*   **`serverHz`:** (Optional) Sets the room's tick rate if you are the first player (1-64).

### **HTTP Health Check**
Sending a standard GET request to the Actor URL returns a JSON payload containing room status, player count, tick rate, and server uptime.

## 📡 Messaging Protocol

### **1. Client to Server (JSON)**
Clients send their movement inputs in JSON format:
```json
{
  "type": "input",
  "seq": 123,
  "clientTimestamp": 1693151234567,
  "input": "U" // Accepts 'U' (Up), 'D' (Down), 'L' (Left), 'R' (Right)
}
```

### **2. Server to Client (JSON & Binary)**
*   **Welcome Packet (JSON):** Upon connection, the server sends a welcome message containing the assigned `playerId` and the room's `tickRate`.
*   **Game State Snapshots (Binary):** During every tick cycle, the server broadcasts an authoritative state snapshot in a strict byte format (Header + Player Array) using a `DataView` buffer.

## 🛠️ Deployment Configuration

To deploy this Actor, ensure your `wrangler.toml` is configured with the correct Durable Object bindings:

```toml
[[durable_objects.bindings]]
name = "MY_SOCKETS_ACTOR"
class_name = "MySocketsActor"
```
