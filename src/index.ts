import {
    Actor,
    ActorConfiguration,
    handler,
} from '@cloudflare/actors';

// ============================================================
// ENVIRONMENT BINDINGS
// ============================================================

export interface Env {
    
    MY_SOCKETS_ACTOR: DurableObjectNamespace;
}

// ============================================================
// CONFIG & PROTOCOL
// ============================================================

const MAX_PLAYERS = 500;
const PLAYER_SPEED_PER_TICK = 5;
const MAX_INPUT_QUEUE = 30;
const MAX_SEQUENCE_JUMP = 1_000_000;

// --- Collision Constants ---
const ARENA_WIDTH = 800;
const ARENA_HEIGHT = 600;
const PLAYER_RADIUS = 10;
const COLLISION_DIST_SQ =
    (PLAYER_RADIUS * 2) * (PLAYER_RADIUS * 2);

// --- Binary Protocol Constants ---
const MAGIC = 0x4753; // "GS"
const VERSION = 1;
const HEADER_BYTES = 40;
const PLAYER_BYTES = 24;
const MAX_PACKET_BYTES =
    HEADER_BYTES + MAX_PLAYERS * PLAYER_BYTES;

type Direction = 'U' | 'D' | 'L' | 'R';

interface QueuedInput {
    seq: number;
    clientTimestamp: number;
    receivedAt: number;
    direction: Direction;
}

interface Player {
    id: number;
    x: number;
    y: number;

    inputX: number;
    inputY: number;

    latestReceivedSequence: number;
    lastProcessedSequence: number;
    lastProcessedClientTimestamp: number;

    inputQueueDelayMs: number;
    inputQueue: QueuedInput[];

    totalInputsReceived: number;
    totalInputsProcessed: number;
    invalidInputs: number;

    _serverTick?: number;
}

// ============================================================
// ACTOR CLASS
// ============================================================

export class MySocketsActor extends Actor<Env> {

    // In-memory state only.
    //
    // IMPORTANT:
    // We intentionally do NOT serialize this state into the
    // WebSocket attachment anymore.
    //
    // If the Actor is evicted/hibernated and recreated, this map
    // is lost. The next message from an old socket will therefore
    // be rejected and that socket will be closed.
    private readonly players = new Map<WebSocket, Player>();

    private nextPlayerId = 1;

    // --- Dynamic Room Tick Settings ---
    private tickRate = 20;               // Default fallback Hz
    private tickPeriodMs = 1000 / 20;    // Default ms per tick

    // Authoritative state
    private serverTick = 0;
    private lastTickTimeMs = 0;

    // Reused packet buffer
    private readonly snapshotBuffer =
        new ArrayBuffer(MAX_PACKET_BYTES);

    private readonly snapshotView =
        new DataView(this.snapshotBuffer);

    // Runtime counters still required by the actual game protocol.
    // but totalInputsReceived / totalInputsProcessed are still
    // placed into the binary snapshot exactly as before.
    private totalTicks = 0;
    private totalInputsReceived = 0;
    private totalInputsProcessed = 0;
    private totalSnapshotsSent = 0;
    private totalTickExecutionMs = 0;
    private maxTickExecutionMs = 0;

    // ========================================================
    // CONFIG & ROUTING
    // ========================================================

    static configuration(request: Request): ActorConfiguration {
        return {
            sockets: {
                upgradePath: '/ws',
            },
        };
    }

    /**
     * MULTI-INSTANCE ROUTING LOGIC
     * Here we can see scalability of Actors . Millions of game room actor instances can be created without any pre-allocation of resources .
     * Uses the ?roomId= URL query parameter to spawn
     * isolated game instances.
     */
    static nameFromRequest(request: Request): string {
        const url = new URL(request.url);

        const roomId = url.searchParams.get('roomId');

        if (roomId) {
            return roomId;
        }

        return 'global-lobby';
    }

    protected shouldUpgradeSocket(request: Request): boolean {
        return request.headers
            .get('Upgrade')
            ?.toLowerCase() === 'websocket';
    }

    protected onRequest(request: Request): Promise<Response> {
        return Promise.resolve(
            Response.json({
                ok: true,
                roomId: this.ctx.id.toString(),
                service: 'multi-instance-game-room',
                tickRate: this.tickRate,
                targetPeriodMs: this.tickPeriodMs,
                players: this.ctx.getWebSockets().length,
                serverTick: this.serverTick,
            })
        );
    }

    // ========================================================
    // IN-MEMORY STATE MANAGEMENT
    // ========================================================

    /**
     * Returns the player object associated with this socket.
     *
     */
    private getPlayer(ws: WebSocket): Player | undefined {
        return this.players.get(ws);
    }

    /**
     * Stores player state only in the Actor's in-memory Map.
     *
     */
    private savePlayer(
        ws: WebSocket,
        player: Player
    ): void {
        this.players.set(ws, player);
    }

    // ========================================================
    // CONNECT / DISCONNECT
    // ========================================================

    protected onWebSocketConnect(
        ws: WebSocket,
        request: Request
    ): void {

        if (this.ctx.getWebSockets().length > MAX_PLAYERS) {
            try {
                ws.close(1013, 'Game room full');
            } catch (_) {}

            return;
        }

        // --- APPLY DYNAMIC TICK RATE ---
        //
        // If this is the FIRST player entering the room,
        // they dictate the server speed for that specific room and the server speed is retained until the instance undegoes eviction.
        if (this.players.size === 0) {
            const url = new URL(request.url);

            const requestedHz = parseInt(
                url.searchParams.get('serverHz') || '20',
                10
            );

            if (
                requestedHz > 0 &&
                requestedHz <= 64
            ) {
                this.tickRate = requestedHz;
                this.tickPeriodMs =
                    1000 / this.tickRate;
            }
        }

        const player: Player = {
            id: this.nextPlayerId++,

            x:
                Math.floor(
                    Math.random() *
                    (ARENA_WIDTH - 40)
                ) + 20,

            y:
                Math.floor(
                    Math.random() *
                    (ARENA_HEIGHT - 40)
                ) + 20,

            inputX: 0,
            inputY: 0,

            latestReceivedSequence: 0,
            lastProcessedSequence: 0,
            lastProcessedClientTimestamp: 0,

            inputQueueDelayMs: 0,
            inputQueue: [],

            totalInputsReceived: 0,
            totalInputsProcessed: 0,
            invalidInputs: 0,

            _serverTick: this.serverTick,
        };

        this.savePlayer(ws, player);

        if (this.lastTickTimeMs === 0) {
            this.lastTickTimeMs = Date.now();
        }

        // Welcome payload passes the room's accepted Tick Rate
        // to the client.
        try {
            ws.send(
                JSON.stringify({
                    type: 'welcome',
                    playerId: player.id,
                    tickRate: this.tickRate,
                    snapshotVersion: VERSION,
                })
            );
        } catch (_) {
            
        }
    }

    protected onWebSocketDisconnect(
        ws: WebSocket
    ): void {

        const player = this.players.get(ws);

        this.players.delete(ws);


        void player;
    }

    // ========================================================
    // MESSAGE
    // ========================================================

    protected onWebSocketMessage(
        ws: WebSocket,
        message: string | ArrayBuffer
    ): void {

        const player = this.getPlayer(ws);

        if (!player) {
            try {
                ws.close(
                    1001,
                    'Game session expired'
                );
            } catch (_) {}

            return;
        }

        if (typeof message === 'string') {

            try {
                const input = JSON.parse(message);

                if (input.type === 'input') {

                    const seq = Number(input.seq);

                    let dir: Direction | null = null;

                    if (
                        input.input === 'U' ||
                        input.input === 'D' ||
                        input.input === 'L' ||
                        input.input === 'R'
                    ) {
                        dir = input.input;
                    }

                    if (
                        seq > player.latestReceivedSequence &&
                        seq <=
                            player.latestReceivedSequence +
                            MAX_SEQUENCE_JUMP &&
                        dir
                    ) {

                        player.inputQueue.push({
                            seq,
                            clientTimestamp:
                                input.clientTimestamp || 0,
                            receivedAt:
                                performance.now(),
                            direction: dir,
                        });

                        if (
                            player.inputQueue.length >
                            MAX_INPUT_QUEUE
                        ) {
                            player.inputQueue.shift();
                        }

                        player.latestReceivedSequence =
                            seq;

                        player.totalInputsReceived++;

                        this.totalInputsReceived++;
                    }
                }

            } catch (_) {
                player.invalidInputs++;
            }
        }

        this.savePlayer(ws, player);

        this.pumpTicks();
    }

    // ========================================================
    // EVENT-DRIVEN LOOP
    // ========================================================

    private pumpTicks(): void {

        const now = Date.now();

        if (this.lastTickTimeMs === 0) {
            this.lastTickTimeMs = now;
        }

        const elapsed =
            now - this.lastTickTimeMs;

        let ticksToRun =
            Math.floor(
                elapsed / this.tickPeriodMs
            );

        if (ticksToRun <= 0) {
            return;
        }

        // Dynamic catch-up constraint
        // based on tick rate (3 seconds of catchup).
        const maxCatchupTicks =
            this.tickRate * 3;

        if (ticksToRun > maxCatchupTicks) {

            ticksToRun =
                maxCatchupTicks;

            this.lastTickTimeMs =
                now -
                (ticksToRun *
                    this.tickPeriodMs);
        }

        const tickStarted =
            performance.now();

        // Ensure all currently connected sockets have
        // their in-memory Player object available.
        
        const allSockets =
            this.ctx.getWebSockets();

        for (const ws of allSockets) {
            this.getPlayer(ws);
        }

        // Purge dead sockets.
        if (
            this.players.size !==
            allSockets.length
        ) {

            const activeSet =
                new Set(allSockets);

            for (
                const ws of this.players.keys()
            ) {
                if (!activeSet.has(ws)) {
                    this.players.delete(ws);
                }
            }
        }

        // Fast-forward processing loops seamlessly.
        for (
            let i = 0;
            i < ticksToRun;
            i++
        ) {

            this.serverTick++;
            this.totalTicks++;

            this.simulateStep(
                tickStarted
            );
        }

        this.lastTickTimeMs +=
            ticksToRun *
            this.tickPeriodMs;

        // Metrics needed for the snapshot protocol.
        const executionMs =
            performance.now() -
            tickStarted;

        this.totalTickExecutionMs +=
            executionMs;

        this.maxTickExecutionMs =
            Math.max(
                this.maxTickExecutionMs,
                executionMs
            );

        const driftMs =
            Math.max(
                0,
                elapsed -
                    (
                        ticksToRun *
                        this.tickPeriodMs
                    )
            );

        this.broadcastSnapshot(
            executionMs,
            driftMs
        );
    }

    // ========================================================
    // SIMULATION & COLLISIONS
    // ========================================================

    private simulateStep(
        tickStarted: number
    ): void {

        for (
            const player of
            this.players.values()
        ) {

            while (
                player.inputQueue.length > 0
            ) {

                const input =
                    player.inputQueue.shift()!;

                player.inputX =
                    input.direction === 'L'
                        ? -1
                        : input.direction === 'R'
                            ? 1
                            : 0;

                player.inputY =
                    input.direction === 'U'
                        ? -1
                        : input.direction === 'D'
                            ? 1
                            : 0;

                player.lastProcessedSequence =
                    input.seq;

                player.lastProcessedClientTimestamp =
                    input.clientTimestamp;

                player.inputQueueDelayMs =
                    Math.max(
                        0,
                        tickStarted -
                            input.receivedAt
                    );

                player.totalInputsProcessed++;

                this.totalInputsProcessed++;
            }

            let nextX =
                player.x +
                player.inputX *
                    PLAYER_SPEED_PER_TICK;

            let nextY =
                player.y +
                player.inputY *
                    PLAYER_SPEED_PER_TICK;

            nextX =
                Math.max(
                    PLAYER_RADIUS,
                    Math.min(
                        ARENA_WIDTH -
                            PLAYER_RADIUS,
                        nextX
                    )
                );

            nextY =
                Math.max(
                    PLAYER_RADIUS,
                    Math.min(
                        ARENA_HEIGHT -
                            PLAYER_RADIUS,
                        nextY
                    )
                );

            let collided = false;

            for (
                const other of
                this.players.values()
            ) {

                if (
                    other.id ===
                    player.id
                ) {
                    continue;
                }

                const dx =
                    nextX - other.x;

                const dy =
                    nextY - other.y;

                if (
                    (
                        dx * dx +
                        dy * dy
                    ) < COLLISION_DIST_SQ
                ) {
                    collided = true;
                    break;
                }
            }

            if (!collided) {
                player.x = nextX;
                player.y = nextY;
            }
        }
    }

    // ========================================================
    // SNAPSHOT BROADCAST
    // ========================================================

    private broadcastSnapshot(
        tickExecutionMs: number,
        driftMs: number
    ): void {

        let offset = 0;

        // ----------------------------------------------------
        // HEADER
        // ----------------------------------------------------

        this.snapshotView.setUint16(
            offset,
            MAGIC,
            true
        );

        offset += 2;

        this.snapshotView.setUint8(
            offset,
            VERSION
        );

        offset += 1;

        this.snapshotView.setUint8(
            offset,
            0
        );

        offset += 1;

        this.snapshotView.setUint32(
            offset,
            this.serverTick,
            true
        );

        offset += 4;

        this.snapshotView.setFloat64(
            offset,
            Date.now(),
            true
        );

        offset += 8;

        this.snapshotView.setUint32(
            offset,
            Math.round(
                tickExecutionMs *
                    1000
            ),
            true
        );

        offset += 4;

        this.snapshotView.setUint32(
            offset,
            Math.round(
                driftMs *
                    1000
            ),
            true
        );

        offset += 4;

        this.snapshotView.setUint16(
            offset,
            this.players.size,
            true
        );

        offset += 2;

        this.snapshotView.setUint16(
            offset,
            0,
            true
        );

        offset += 2;

        this.snapshotView.setUint32(
            offset,
            this.totalInputsReceived,
            true
        );

        offset += 4;

        this.snapshotView.setUint32(
            offset,
            this.totalInputsProcessed,
            true
        );

        offset += 4;

        this.snapshotView.setUint32(
            offset,
            this.totalTicks,
            true
        );

        offset += 4;

        // ----------------------------------------------------
        // PLAYER DATA
        // ----------------------------------------------------

        for (
            const player of
            this.players.values()
        ) {

            this.snapshotView.setUint32(
                offset,
                player.id,
                true
            );

            offset += 4;

            this.snapshotView.setFloat32(
                offset,
                player.x,
                true
            );

            offset += 4;

            this.snapshotView.setFloat32(
                offset,
                player.y,
                true
            );

            offset += 4;

            this.snapshotView.setUint32(
                offset,
                player.lastProcessedSequence,
                true
            );

            offset += 4;

            this.snapshotView.setUint16(
                offset,
                player.inputQueue.length,
                true
            );

            offset += 2;

            this.snapshotView.setUint16(
                offset,
                0,
                true
            );

            offset += 2;

            this.snapshotView.setFloat32(
                offset,
                player.inputQueueDelayMs,
                true
            );

            offset += 4;
        }

        const packet =
            new Uint8Array(
                this.snapshotBuffer,
                0,
                offset
            );

        try {
            this.sockets.message(
                packet,
                '*'
            );

            this.totalSnapshotsSent++;

        } catch (_) {
            // Intentionally ignored.
        }
    }
}

// ============================================================
// WORKER / ACTOR HANDLER
// ============================================================

export default handler(
    MySocketsActor
);
