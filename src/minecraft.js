const bedrock = require('bedrock-protocol');
const { ClientStatus } = require('bedrock-protocol/src/connection');

const common = require('./common');
const config = require('./config');
const database = require('./database');
const prom = require('./prom');
const routing = require('./routing');
const actions = require('./actions');

const agents = [];
let watchdogTimer;

// loggable deaths that have a definite cause, but no other actors
const deaths = [
  'death.attack.anvil', 'death.attack.cactus', 'death.attack.drown',
  'death.attack.explosion', 'death.attack.fall', 'death.attack.fallingBlock',
  'death.attack.fireball', 'death.attack.fireworks', 'death.attack.flyIntoWall',
  'death.attack.generic', 'death.attack.inFire', 'death.attack.inWall',
  'death.attack.lava', 'death.attack.lightningBolt', 'death.attack.magic',
  'death.attack.magma', 'death.attack.onFire', 'death.attack.outOfWorld',
  'death.attack.starve', 'death.attack.wither', 'death.fell.killer',
];

// group falls together
const falls = [
  'death.fell.accident.generic', 'death.fell.accident.ladder',
  'death.fell.accident.vines', 'death.fell.accident.water',
];

class Agent {
  /**
   * A Minecraft agent, relaying chat messages and obsserving state for a
   * particular server. Not a bot, not really a client itself, its an agent!
   * @param {string} name
   * @param {{ host: string, port: number, relay: object?, commands: array<string>? format: string? }} options
   */
  constructor(name, options) {
    this.db = database.instance();
    this.name = name;
    this.ticks = [];
    this.reconnectTimer = null;
    this.tick_count = 100;
    this.players = {};
    this.commands = [];
    this.relay = {};
    this.active = true;
    this.authenticated = null;
    this.authResolve = null;
    this.authReject = null;
    this.language = 'en';
    this.timers = new Set();
    Object.assign(this, options);

    common.messenger.on(common.MessageType.MinecraftRelay, (channel, message) => {
      this.relayMessage(channel, message);
    });
    common.messenger.on(common.MessageType.MinecraftWhisper, (xuid, message) => {
      this.whisper(xuid, message);
    });
    common.messenger.on(common.MessageType.MinecraftChat, (server, message) => {
      if (server == this.name) {
        this.sendText(message);
      }
    });
    common.messenger.on(common.MessageType.EventServerHasMail, server => {
      if (server !== name) return;
      Object.values(this.players).forEach(p => {
        this.whisper(p.xuid, common.template(this.language, ['mail_received__minecraft', 'mail_received']));
      });
    });
    common.messenger.on(common.MessageType.EventPlayerHasMail, xuid => {
      this.whisper(xuid, common.template(this.language, ['mail_received__minecraft', 'mail_received']));
    });
    this.createClient();
  }

  /**
   * Creates the client as needed.
   */
  createClient() {
    this.authenticated = new Promise((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;
    });
    if (this.client !== undefined) {
      this.client.close();
    }
    const options = {
      host: this.host,
      port: this.port,
      conLog: (...args) => this.log('[conlog]', ...args),
    };
    if (config.minecraft.profilesFolder !== undefined) {
      options['profilesFolder'] = config.minecraft.profilesFolder;
    }
    if (config.minecraft.connectTimeout !== undefined) {
      options['connectTimeout'] = config.minecraft.connectTimeout;
    }
    if (this?.options) {
      Object.assign(options, this.options);
    }
    this.client = bedrock.createClient(options);
    if (this?.options?.protocolVersion) {
      this.client.options.protocolVersion = this.options.protocolVersion;
    }

    [
      'player_list', 'set_time', 'level_event', 'heartbeat', 'text',
      'start_game', 'close', 'disconnect', 'error', 'spawn', 'ping_timeout',
      'session',
    ].forEach(event => {
      if (this[`packet_${event}`] == undefined) {
        throw new Error(`Missing event: ${event}`);
      }
      this.client.on(event, packet => this[`packet_${event}`](packet));
    });
  }

  packet_ping_timeout() {
    this.log('ping_timeout');
  }

  packet_session() {
    this.log('authenticated');
    this.authResolve();
  }

  async onReady() {
    await this.authenticated;
  }

  /**
   * Handle error messages from bedrock client.
   * @param  {...any} args
   */
  packet_error(...args) {
    this.log('[error]', ...args);
    this.authReject(...args);
  }

  /**
   * set_time signal received from bedrock client.
   * @param {object} packet packet_set_time
   */
  packet_set_time(packet) {
    prom.TIME.set({ instance: this.name }, packet.time);
  }

  /**
   * text signal received from bedrock client - possibly relay and check for
   * death/sleep translation messages.
   * @param {object} packet packet_text
   */
  packet_text(packet) {
    if (['tip', 'jukebox_popup', 'popup'].includes(packet.type)) {
      return;
    }
    const msg = new common.Message(
      this.name,
      'Minecraft' + common.capitalize(packet.type),
      packet.xuid,
      packet.source_name,
      packet.message,
      {
        language: this.language,
        type: packet.type,
        parameters: packet.parameters,
      },
    );
    if (packet.source_name != this.client.username) {
      routing.route(msg);
    }

    if (packet.type == 'translation') {
      if (packet.message.startsWith('death.')) {
        if (deaths.includes(packet.message)) {
          this.countDeath(packet.parameters[0], packet.message.split('.').pop());
        } else if (falls.includes(packet.message)) {
          this.countDeath(packet.parameters[0], 'fall');
        } else {
          this.countDeath(packet.parameters[0], packet.parameters.length > 1 ?
            packet.parameters[1] : '');
        }
      }
      if (packet.message == 'chat.type.sleeping') {
        packet.parameters.forEach(player => {
          prom.PLAYERS_SLEEP.inc({
            instance: this.name,
            player: player,
          });
        });
      }
    }

    if (packet.type == 'whisper') {
      actions.parseMessage(msg);
    }

    if (packet.type == 'chat' && packet.source_name != this.client.username) {
      prom.CHAT.inc({
        instance: this.name,
        source: packet.source_name,
      });
    }
  }

  /**
   * heartbeat signal received from bedrock client - calculate tps.
   * @param {object} packet packet_heartbeat
   */
  packet_heartbeat(packet) {
    const now = [new Date().getTime(), packet];
    this.ticks.unshift(now);
    let cnt = this.ticks.length;
    if (cnt > this.tick_count) {
      this.ticks.pop();
      cnt = this.tick_count;
    }
    if (cnt < this.tick_count / 2) return;
    // 50 ms per tick = 20 ticks per second
    // heartbeat is every 10 ticks, or 500ms
    const then = this.ticks[cnt - 1];
    // don't know why time needs to be at ticks[1]
    const tps = 1000 * Number(now[1] - then[1]) / (this.ticks[1][0] - then[0]);
    if (!isNaN(tps)) {
      prom.TPS.set({ instance: this.name }, tps);
    }
    prom.TICKS.set({ instance: this.name }, Number(packet));
  }

  /**
   * player_list signal received from bedrock client.
   * @param {object} packet packet_player_list
   */
  async packet_player_list(packet) {
    if (packet.records.type == 'add') {
      const newPlayers = new Set();
      packet.records.records.forEach(r => {
        const isNotMe = r.username !== this.client.username;
        if (this.players[r.uuid] === undefined && isNotMe) {
          newPlayers.add(r.uuid);
        }
        this.players[r.uuid] = {
          username: r.username,
          xuid: r.xbox_user_id,
        };
        if (isNotMe) {
          this.log(packet.records.type, this.players[r.uuid].username);
          prom.PLAYERS_ONLINE.set({
            instance: this.name,
            player: r.username,
          }, 1);
        }
      });
      const playerMap = {};
      Object.values(this.players).forEach(p => playerMap[p.xuid] = p.username);
      await this.db.checkInPlayers(this.name, playerMap);
      for (const p of newPlayers) {
        const timer = setTimeout(async () => {
          this.timers.delete(timer);
          const messageCount = await this.db.countPlayerMessages(this.name, this.players[p].xuid);
          const templates = ['welcome'];
          const inboxTemplates = ['inbox'];
          if (messageCount == 0) {
            templates.unshift('welcome_empty');
            inboxTemplates.unshift('inbox_none');
          }
          if (messageCount == 1) {
            templates.unshift('welcome_one');
            inboxTemplates.unshift('inbox_one');
          }
          const message = common.template(this.language, templates, {
            username: this.players[p].username,
            botname: this.client.username,
            messageCount: messageCount,
            checkInbox: (values) => common.template(this.language, inboxTemplates, values),
          });
          this.whisper(this.players[p].xuid, message);
        }, 25_000 + Math.random() * 10_000);
        this.timers.add(timer);
      }
    }
    if (packet.records.type == 'remove') {
      packet.records.records.forEach(r => {
        if (this.players[r.uuid].username == this.client.username) {
          return;
        }
        this.log(packet.records.type, this.players[r.uuid].username);
        prom.PLAYERS_ONLINE.set({
          instance: this.name,
          player: this.players[r.uuid].username,
        }, 0);
        delete this.players[r.uuid];
      });
    }
  }

  /**
   * level_event signal received from bedrock client - primarily weather.
   * @param {object} packet packet_level_event
   */
  packet_level_event(packet) {
    const weather = {
      start_rain: 1,
      stop_rain: 0,
      start_thunder: 2,
      stop_thunder: 1,
    };
    if (weather[packet.event] !== undefined) {
      prom.WEATHER.set({ instance: this.name }, weather[packet.event]);
    }
  }

  /**
   * start_game signal received from bedrock client - initialize metrics.
   * @param {object} packet packet_start_game
   */
  packet_start_game(packet) {
    const profile = JSON.stringify(this.client.profile);
    this.log(`logged in as ${this.client.username} (${profile})`);
    prom.WEATHER.set(
      { instance: this.name },
      packet.lightning_level > 0 ? 2 : (packet.rain_level > 0 ? 1 : 0),
    );
    prom.TICKS.set({ instance: this.name }, Number(packet.current_tick));
    prom.TIME.set({ instance: this.name }, packet.day_cycle_stop_time);
  }

  /**
   * spawn signal received from bedrock client - perform any initial commands.
   */
  packet_spawn() {
    if (this.commands.length > 0) {
      this.performCommands([...this.commands]);
    }
  }

  /**
   * Perform an item from a list of commands.
   * @param {array<string>} commands
   */
  performCommands(commands) {
    setTimeout(() => {
      const action = commands.shift(commands);
      if (action === undefined) return;
      this.log(action);
      if (action.startsWith('/')) {
        this.client.queue('command_request', {
          command: action.slice(1),
          interval: false,
          origin: {
            uuid: this.client.profile.uuid,
            request_id: this.client.profile.uuid,
            type: 'player',
          },
        });
      } else {
        this.sendText(action);
      }
      this.performCommands(commands);
    }, 500);
  }

  /**
   * Close signal received from bedrock client.
   */
  packet_close() {
    this.log('close');
    if (this.active && this.reconnectTimer === null) {
      this.reconnectTimer = setTimeout(() => this.reconnect(10), 500);
    }
  }

  /**
   * Try to reconnect with exponential backoff.
   */
  reconnect(timeout) {
    this.reconnectTimer = null;
    if (!this.active || this.client.status == ClientStatus.Initialized) {
      return;
    }
    timeout = Math.min(timeout * 1.5, 300);
    this.log(`disconnected - reconnecting (${timeout}s)`);
    if (this.client.status == ClientStatus.Disconnected) {
      this.createClient();
    }
    this.reconnectTimer = setTimeout((t) => this.reconnect(t), timeout * 1000, timeout);
  }

  /**
   * Stop signal received from application (ctrl-c).
   */
  stop() {
    this.log('stop');
    this.timers.forEach(t => {
      clearTimeout(t);
    });
    this.timers.clear();
    this.active = false;
    this.client.disconnect();
    this.client.close();
    if (this.reconnectTimer !== null) {
      this.log('reconnection stopped');
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Disconnect signal received from bedrock client.
   */
  packet_disconnect() {
    this.log('disconnected');
    if (this.active && this.reconnectTimer === null) {
      this.reconnectTimer = setTimeout(() => this.reconnect(10), 500);
    }
  }

  /**
   * Handle a relayed message from discord.
   *
   * @param {string} channel
   * @param {common.Message} message
   */
  relayMessage(channel, message) {
    prom.CHAT.inc({
      instance: this.name,
      source: message.source,
    });
    this.tellraw('@a', message);
  }

  /**
   * Whisper a message
   *
   * @param {string} xuid The xbox user id of the user
   * @param {string} message The message to whisper
   */
  whisper(xuid, message) {
    Object.values(this.players).forEach(playerObj => {
      if (playerObj.xuid == xuid) {
        this.tellraw(playerObj.username, message);
      }
    });
  }

  /**
   * Send a rawtext message to the specified target(s).
   *
   * @param {string} target who to send to (player name, @a, etc)
   * @param {string} message message to send
   */
  tellraw(target, message) {
    if (target.includes(' ')) target = `"${target}"`;
    const safequote = message.replace(/"/g, '\\"');
    const command = `tellraw ${target} {"rawtext": [{"text": "${safequote}"}]}`;
    this.client.queue('command_request', {
      command: command,
      interval: false,
      origin: {
        uuid: this.client.profile.uuid,
        request_id: this.client.profile.uuid,
        type: 'player',
      },
    });
  }

  /**
   * A convenience function for incrementing death counters.
   * @param {string} player
   * @param {string} cause
   */
  countDeath(player, cause = '') {
    prom.PLAYERS_DEATH.inc({
      instance: this.name,
      player: player,
      cause: cause,
    });
  }

  /**
   * Queues a chat message.
   * @param {string} message
   */
  sendText(message) {
    // this.tellraw('@a', message);
    this.client.queue('text', {
      type: 'chat',
      needs_translation: false,
      source_name: this.client.username,
      xuid: '',
      platform_chat_id: '',
      message: message,
    });
  }

  log(...args) {
    log(`${this.name}: `, ...args);
  }
}

/**
 * Start watchdog and initialize Agent objects.
 */
async function init() {
  let ms = 10000;
  if (config.minecraft.connectTimeout !== undefined) {
    ms = Math.max(ms, config.minecraft.connectTimeout * 1.5);
  }
  watchdogTimer = setInterval(watchdog, ms);

  for (const name in config.minecraft.servers) {
    log('Starting ', name);
    const agent = new Agent(name, config.minecraft.servers[name]);
    agents.push(agent);
    try {
      await agent.onReady();
    } catch (e) {
      console.error(e);
    }
  }
}

/**
 * Checks for hanging Agents (failed connections primarily).
 */
function watchdog() {
  agents.forEach(agent => {
    if (agent.client.status === ClientStatus.Disconnected && agent.reconnectTimer === null) {
      agent.close();
    }
    if (agent.client.status === ClientStatus.Initialized && agent.reconnectTimer !== null) {
      agent.reconnectTimer = null;
    }
  });
}

/**
 * Handles module level logging.
 * @param  {...any} args
 */
function log(...args) {
  common.log('minecraft', ...args);
}

/**
 * Stop all Agents.
 */
common.messenger.on('stop', () => {
  log('stopping');
  agents.forEach(agent => agent.stop());
  clearInterval(watchdogTimer);
});

Object.assign(module.exports, {
  init,
});

if (require.main === module) {
  init();
}
