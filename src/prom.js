const http = require('http');
const prom = require('prom-client');

const common = require('./common');
const database = require('./database');

/** @type {Set<Counter>} */
const _COUNTERS = new Set();

class Counter {
  constructor(counterConfigObject) {
    this.name = counterConfigObject.name;
    this.widget = new prom.Counter(counterConfigObject);
    /** @type {database.DatabaseWrapper} */
    this.db = null;
    this.timers = [];
    this.timeout = 60_000;
    _COUNTERS.add(this);
  }

  /**
   * Initializes Counter from database.
   *
   * @param {object} config Configuration file object
   * @param {database.DatabaseWrapper} db Database object
   */
  async init(config, db) {
    this.db = db === undefined ? database.instance() : db;
    this.widget.reset();
    (await this.db.getCounter(this.name)).forEach(v => {
      this.widget.inc(v.fields, v.value);
    });
    this.timeout = config.web?.counterDelay ?? this.timeout;
  }

  /**
   * Increments a counter after a delay.
   *
   * @param {object} fields Key/Value pair of fields.
   * @param {number} value Value to increment by.
   * @returns {Promise}
   */
  inc(fields, value = 1) {
    // increment by zero to handle initializtion case of fields
    this.widget.inc(fields, 0);
    // then wait one minute to ensure this value is saved in prometheus
    return new Promise(res => {
      this.timers.push(setTimeout(async () => {
        this.widget.inc(fields, value);
        const total = await this.get(fields);
        await this.db.setCounter(this.name, fields, total);
        this.timers.shift();
        res(total);
      }, this.timeout));
    });
  }

  /**
   * Retrieves the Counter for the given fields, or undefined if unset.
   *
   * @param {object} fields Field key/value mapping
   * @returns {number}
   */
  async get(fields) {
    const fieldStr = hashObj(fields);
    for (const value of (await this.widget.get()).values) {
      if (fieldStr === hashObj(value.labels)) {
        return value.value;
      }
    }
    return undefined;
  }

  /**
   * Remove registrations of this instance.
   */
  delete() {
    prom.register.removeSingleMetric(this.name);
    _COUNTERS.delete(this);
  }

  /**
   * Halt any timers active.
   */
  stop() {
    this.timers.forEach(t => clearTimeout(t));
  }
}


/**
 * Initializes a Prometheus client web endpoint, if configured.
 *
 * @returns {null}
 */
async function init(config) {
  if (config === undefined) {
    config = require('./config').get();
  }
  _COUNTERS.forEach(cntr => cntr.init(config));
  if (config.web === undefined || config.web.enabled === false) {
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

  common.messenger.on('stop', () => {
    server.close(() => { log('Server is closed'); });
    Object.values(sockets).forEach(s => { s.destroy(); });
    _COUNTERS.forEach(cntr => cntr.stop());
  });
}

function log(...args) {
  common.log('prom', ...args);
}

function reset() {
  prom.register.clear();
}

module.exports = {
  init,
  Counter,
  reset,
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
  CHAT: new Counter({
    name: 'minecraft_messages',
    help: 'Total chat events for a given server.',
    labelNames: ['instance', 'source'],
  }),
  PLAYERS_ONLINE: new prom.Gauge({
    name: 'minecraft_players',
    help: '0/1 for players online for a given server.',
    labelNames: ['instance', 'player'],
  }),
  PLAYERS_DEATH: new Counter({
    name: 'minecraft_death',
    help: 'Counts number of deaths by username for a given server.',
    labelNames: ['instance', 'player', 'cause'],
  }),
  PLAYERS_SLEEP: new Counter({
    name: 'minecraft_sleep',
    help: 'Counts number of sleeps by username for a given server.',
    labelNames: ['instance', 'player'],
  }),
};

/**
 * Converts an object into a normalized string for comparisons.
 *
 * @param {object} obj Object to be compared
 * @returns {string}
 */
function hashObj(obj) {
  return JSON.stringify(Object.keys(obj).sort().map(k => [k, obj[k]]));
}

if (require.main === module) {
  init();
}
