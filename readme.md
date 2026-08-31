Actors 
websockets
o copy memory 
hibernation 
simple multiplayer collision detection .
stated limits :1000 inputs / sec soft 
tested 2500
pricing :0.1 gbs / min (6players 20 hz)+6*60*20.(7200)360 req




***

# 🌐 Edge-Native Multiplayer Game Server

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Actors-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)
![WebSockets](https://img.shields.io/badge/WebSockets-010101?style=for-the-badge&logo=socketdotio&logoColor=white)

An authoritative, highly scalable real-time multiplayer game server engineered on top of **Cloudflare Actors (Durable Objects)**. 

This project demonstrates how to build low-latency, infinitely scalable game rooms at the network edge, utilizing custom binary protocols and strictly in-memory state management for zero-latency overhead.

## 🎯 Project Overview & The Challenge

Traditional multiplayer game servers rely on centralized infrastructure, which can introduce latency and require complex scaling orchestration (e.g., Kubernetes + Agones). 

**The Solution:** I designed this serverless architecture using Cloudflare Actors. Each game room is an isolated V8 isolate running at the edge. Millions of game rooms can be instantiated on-demand via a simple URL parameter without any pre-allocation of server resources.

## 🚀 Technical Highlights & Achievements

*   **Infinite Edge Scalability:** Engineered dynamic multi-instance routing. The system reads the `?roomId=` parameter and seamlessly spawns or routes to an isolated Actor instance.
*   **Custom Binary Protocol:** To minimize bandwidth and maximize parsing speed, I implemented a strict 14-byte binary input protocol and a tightly packed snapshot broadcast using `ArrayBuffer` and `DataView`. *(Includes a JSON fallback for legacy clients).*
*   **Authoritative Game Loop:** Implemented a custom event-driven game loop (`pumpTicks`) that handles fast-forwarding, time drift, and dynamic tick rates (up to 64Hz) dictated by the first connected client.
*   **Spatial Math & Collision:** Built a 2D circular collision detection system using squared-distance calculations (`dx*dx + dy*dy`) to optimize CPU cycles on the server.
*   **Zero-Storage Memory Management:** State is explicitly kept out of persistent storage to ensure maximum WebSocket broadcast performance. Implemented active dead-socket purging and client catch-up logic.

---

## 🧠 Architecture & Flow

1.  **Connection:** A client connects via WebSocket (`/ws?roomId=X`).
2.  **Instantiation:** Cloudflare spawns a single Actor for `roomId=X` in a data center close to the players.
3.  **Input Queueing:** Player inputs (Direction, Sequence, Timestamp) are received via binary frames and queued in memory.
4.  **Tick Execution:** The server processes inputs, calculates physics/collisions, and updates authoritative positions.
5.  **Broadcast:** The server packs the global state into a single ArrayBuffer and broadcasts it to all connected sockets in one optimized call.

---

## 🔬 Deep Dive: Protocol Optimization

To demonstrate low-level memory manipulation, here is how the custom binary protocol is structured to avoid the overhead of JSON serialization during the hot path:

**Client Input (14 Bytes):**
```text
[0]    Uint8:   Message Type (1 = Input)
[1-4]  Uint32:  Sequence Number (Little Endian)
[5-12] Float64: Client Timestamp (Little Endian)
[13]   Uint8:   Direction Code (1=U, 2=D, 3=L, 4=R)
```

**Server Snapshot (Broadcasted every tick):**
*   **Header (40 Bytes):** Magic Number validation, Server Tick, Tick Execution Time, Drift, and Player Count.
*   **Entity Data (24 Bytes/Player):** Player ID, X/Y Coordinates, Last Processed Sequence (for client-side prediction/reconciliation), and Queue metrics.

---

## 🛠️ Skills Demonstrated

*   **Languages:** TypeScript, Node.js API concepts.
*   **Architecture:** Serverless / Edge Computing, Distributed Systems, Actor Model.
*   **Game Development:** Authoritative Servers, Client-Side Prediction concepts, Tick Rates, Collision Detection.
*   **Low-Level Networking:** WebSockets, Binary Data Serialization (`ArrayBuffer`, `DataView`, Endianness), Bandwidth Optimization.

---

## 💻 Code Structure

*   `MySocketsActor`: The core class handling the WebSocket lifecycle and game state.
*   `processPlayerInput()`: Deduplicates and validates queue insertions.
*   `pumpTicks()`: The heart of the server, managing time drift and executing steps.
*   `simulateStep()`: Resolves movement and physics calculations.
*   `broadcastSnapshot()`: Encodes the state into binary and ships it to clients.

> *Feel free to explore the source code to see the implementation of the binary DataViews and the physics loop!*
>  Deployment
Make sure you have Wrangler installed.
> npm create cloudflare@latest gameroom-app -- --template autotask05-pixel/gameroomactor
> cd gameroom-app
> wrangler dev

