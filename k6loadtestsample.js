import ws from 'k6/ws';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';

// --- Custom Metrics ---
const sentMessages = new Counter('ws_msgs_sent');
const recvMessages = new Counter('ws_msgs_recv');
const welcomeMessages = new Counter('ws_welcome_recv');
const errorRate = new Rate('ws_errors');

// --- Load Test Scenario ---
export const options = {
    scenarios: {
        multiplayer_load: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '15s', target: 50 },  // Ramp up to 50 concurrent players
                { duration: '30s', target: 50 },  // Sustain 50 players 
                { duration: '10s', target: 0 },   // Graceful scale down
            ],
            gracefulRampDown: '10s',
        },
    },
};

// Simulate traffic distribution across multiple dynamic arenas
function getRandomRoom() {
    const rooms = ['arena-11', 'arena-22', 'arena-33'];
    return rooms[Math.floor(Math.random() * rooms.length)];
}

export default function () {
    const roomId = getRandomRoom();
    
    // Connect to the specific Worker URL from the HTML configuration
    const url = `wss://"yourgameactorurl"/ws?roomId=${roomId}&serverHz=20`;//replace with your actor url

    const res = ws.connect(url, null, function (socket) {
        let seq = 0;
        let tickInterval;

        socket.on('open', function () {
            // Mimic the Client Publish Hz from the HTML (20 Hz = 50ms interval)
            const clientHz = 20;
            const tickRateMs = 1000 / clientHz;

            tickInterval = socket.setInterval(function () {
                seq++;
                
                // ----------------------------------------------------
                // REPLICATE EXACT BINARY PAYLOAD (14 Bytes)
                // ----------------------------------------------------
                const buffer = new ArrayBuffer(14);
                const view = new DataView(buffer);
                
                view.setUint8(0, 1);                  // Message Type (1 = Input)
                view.setUint32(1, seq, true);         // Seq (Little Endian)
                view.setFloat64(5, Date.now(), true); // Timestamp (Little Endian)
                
                // Randomly pick a direction (0: None, 1: U, 2: D, 3: L, 4: R)
                const dirCode = Math.floor(Math.random() * 5);
                view.setUint8(13, dirCode);
                
                // k6 automatically sends ArrayBuffer as a WebSocket Binary Frame
                socket.send(buffer);
                sentMessages.add(1);
                
            }, tickRateMs);
        });

        socket.on('message', function (msg) {
            recvMessages.add(1);
            
            // Check if the message is a string (Welcome JSON) or Binary (Server Auth State)
            if (typeof msg === 'string') {
                try {
                    const data = JSON.parse(msg);
                    if (data.type === 'welcome') {
                        welcomeMessages.add(1);
                    }
                } catch (e) {
                    // Ignore JSON parse error
                }
            } else {
                // Message is an ArrayBuffer (Binary Game State)
                // Optional: Verify the custom 0x4753 server header
                if (msg.byteLength >= 2) {
                    const view = new DataView(msg);
                    if (view.getUint16(0, true) !== 0x4753) {
                        errorRate.add(1); // Track bad protocol messages
                    }
                }
            }
        });

        socket.on('error', function (e) {
            errorRate.add(1);
            console.error('WebSocket Error:', e.error());
        });

        socket.on('close', function () {
            // Clean up timers to prevent memory leaks in VUs
            if (tickInterval) {
                socket.clearInterval(tickInterval);
            }
        });

        // Restrict maximum connection time per VU to force client rotation
        socket.setTimeout(function () {
            socket.close();
        }, 45000); 
    });

    // Ensure the connection was successfully established (HTTP 101 Switching Protocols)
    check(res, {
        'status is 101 (Switching Protocols)': (r) => r && r.status === 101,
    });
}
