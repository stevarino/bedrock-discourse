const http = require('http');
const prom = require('prom-client');

const common = require('./common');
const config = require('./config');

/**
 * Initializes a Prometheus client web endpoint, if configured.
 * @returns null
 */
function init() {
  if (config.web === undefined) {
    return;
  }
  const requestListener = async function(req, res) {
    if (!['/metrics', '/'].includes(req.url)) {
      res.writeHead(404);
      res.end('Not Found.');
      return;
    }
    res.setHeader('Content-Type', prom.register.contentType);
    res.writeHead(200);
    res.end(await prom.register.metrics());
  };

  const server = http.createServer(requestListener);
  server.listen(config.web.port, config.web.host, () => {
    log(`Server is running on http://${config.web.host}:${config.web.port}`);
  });

  // https://stackoverflow.com/a/14636625/4001895 - destroy hanging sockets
  let socketId = 0;
  const sockets = {};
  server.on('connection', function(socket) {
    socketId += 1;
    sockets[socketId] = socket;
    socket.on('close', () => {
      delete sockets[socketId];
    });
  });

  process.on('SIGINT', () => {
    server.close(() => { log('Server is closed'); });
    Object.values(sockets).forEach(s => { s.destroy(); });
  });
}

function log(...args) {
  common.log('prom', ...args);
}

if (require.main === module) {
  init();
}

module.exports = {
  init,
  TPS: new prom.Gauge({
    name: 'minecraft_tps',
    help: 'Ticks per second of a given Minecraft server.',
    labelNames: ['instance'],
  }),
  TICKS: new prom.Gauge({
    name: 'minecraft_ticks',
    help: 'Current tick for a given Minecraft server.',
    labelNames: ['instance'],
  }),
  TIME: new prom.Gauge({
    name: 'minecraft_time',
    help: 'Current world time for a given server.',
    labelNames: ['instance'],
  }),
  WEATHER: new prom.Gauge({
    name: 'minecraft_weather',
    help: 'Current world weather state (0 clear, 1 rain, 2 thunder) for a given server.',
    labelNames: ['instance'],
  }),
  CHAT: new prom.Counter({
    name: 'minecraft_messages',
    help: 'Total chat events for a given server.',
    labelNames: ['instance', 'source'],
  }),
  PLAYERS_ONLINE: new prom.Gauge({
    name: 'minecraft_players',
    help: '0/1 for players online for a given server.',
    labelNames: ['instance', 'player'],
  }),
  PLAYERS_DEATH: new prom.Counter({
    name: 'minecraft_death',
    help: 'Counts number of deaths by username for a given server.',
    labelNames: ['instance', 'player', 'cause'],
  }),
  PLAYERS_SLEEP: new prom.Counter({
    name: 'minecraft_sleep',
    help: 'Counts number of sleeps by username for a given server.',
    labelNames: ['instance', 'player'],
  }),
};