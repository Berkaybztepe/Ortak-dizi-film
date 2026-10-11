// Testler için yerel MQTT aracısı (gerçek aracı sunucuların yerine).
//   node tests/broker.mjs [tcpPort=18830] [wsPort=18831]
// TCP: Kotlin istemcisi için (tcp://127.0.0.1:18830), WebSocket: JS istemcisi için (ws://127.0.0.1:18831/mqtt)
import net from 'net';
import http from 'http';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const aedesLib = require('aedes');
const { WebSocketServer, createWebSocketStream } = require('ws');

// loss: odaya giden (down) mesajların düşürülme olasılığı (0..1), zor koşul testleri için
export async function startBroker(tcpPort = 18830, wsPort = 18831) {
  const state = { loss: 0, dropped: 0 };
  const opts = {
    authorizeForward(client, packet) {
      if (state.loss > 0 && /\/(down|up)\//.test(packet.topic) && Math.random() < state.loss) {
        state.dropped++;
        return null;
      }
      return packet;
    },
  };
  const aedes = aedesLib.createBroker ? aedesLib.createBroker(opts) : aedesLib(opts);
  if (aedes.then) await aedes;
  const tcp = net.createServer(aedes.handle);
  await new Promise((r) => tcp.listen(tcpPort, '127.0.0.1', r));
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer, handleProtocols: (p) => (p.has('mqtt') ? 'mqtt' : false) });
  wss.on('connection', (ws) => aedes.handle(createWebSocketStream(ws)));
  await new Promise((r) => httpServer.listen(wsPort, '127.0.0.1', r));
  return {
    state,
    setLoss: (p) => (state.loss = p),
    tcp: `tcp://127.0.0.1:${tcpPort}`,
    ws: `ws://127.0.0.1:${wsPort}/mqtt`,
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => wss.close(r));
      await new Promise((r) => httpServer.close(r));
      await new Promise((r) => tcp.close(r));
      await new Promise((r) => aedes.close(r));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const b = await startBroker(+(process.argv[2] || 18830), +(process.argv[3] || 18831));
  console.log(`Aracı hazır: ${b.tcp} ${b.ws}`);
}
