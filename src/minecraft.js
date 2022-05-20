const bedrock = require('bedrock-protocol');
const { ClientStatus } = require('bedrock-protocol/src/connection');

const common = require('./common');
const config = require('./config');
const prom = require('./prom');

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
   * @param {{ host: string, port: number, relay: object?, actions: array<string>? format: string? }} options
   */
  constructor(name, options) {
    this.name = name;
    this.ticks = [];
    this.reconnectTimer = null;
    this.tick_count = 100;
    this.players = {};
    this.actions = [];
    this.relay = {};
    this.active = true;
    this.uuid = '';
    Object.assign(this, options);

    common.messenger.on('minecraft', (channel, message) => this.relayMessage(channel, message));
    this.createClient();
  }

  /**
   * Creates the client as needed.
   */
  createClient() {
    if (this.client !== undefined) {
      this.client.close();
      clearInterval(this.client.loop);
    }
    const options = {
      host: this.host,
      port: this.port,
      skipPing: true,
      conLog: (...args) => log(`${this.name}: `, ...args),
    };
    if (config.minecraft.profilesFolder !== undefined) {
      options['profilesFolder'] = config.minecraft.profilesFolder;
    }
    if (config.minecraft.connectTimeout !== undefined) {
      options['connectTimeout'] = config.minecraft.connectTimeout;
    }
    this.client = bedrock.createClient(options);

    [
      'player_list', 'set_time', 'level_event', 'heartbeat', 'text',
      'start_game', 'close', 'disconnect', 'error', 'spawn',
    ].forEach(event => {
      this.client.on(event, packet => this[event](packet));
    });
  }

  /**
   * Handle error messages from bedrock client.
   * @param  {...any} args
   */
  error(...args) {
    log(this.name, ...args);
  }

  /**
   * set_time signal received from bedrock client.
   * @param {object} packet packet_set_time
   */
  set_time(packet) {
    prom.TIME.set({ instance: this.name }, packet.time);
  }

  /**
   * text signal received from bedrock client - possibly relay and check for
   * death/sleep translation messages.
   * @param {object} packet packet_text
   */
  text(packet) {
    const messageObj = {
      source: this.name,
      sender: packet.source_name,
      content: packet.message,
      senderid: packet.xuid,
      type: packet.type,
      parameters: packet.parameters,
    };

    if (packet.type == 'translation') {
      if (packet.message.startsWith('death.')) {
        if (deaths.includes(packet.message)) {
          this.countDeath(packet.parameters[0], packet.message.split('.').pop());
        }
        else if (falls.includes(packet.message)) {
          this.countDeath(packet.parameters[0], 'fall');
        }
        else {
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
        log(packet);
      }
    }

    if (packet.type == 'chat' && packet.source_name != this.client.username) {
      prom.CHAT.inc({
        instance: this.name,
        source: packet.source_name,
      });
    }

    if (['tip', 'jukebox_popup', 'popup'].includes(packet.type)) {
      return;
    }
    Object.entries(this.relay).forEach(([name, channel]) => {
      if (
        (channel.receiveOnly) ||
        (!channel.sendOwnMessages && packet.source_name == this.client.username) ||
        (!channel.sendNotices && packet.type != 'chat')
      ) return;
      common.messenger.emit('discord', name, messageObj);
    });
  }

  /**
   * heartbeat signal received from bedrock client - calculate tps.
   * @param {object} packet packet_heartbeat
   */
  heartbeat(packet) {
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
  player_list(packet) {
    // TODO: figure out how to set this for all players? if a player message
    //       is missed, only active players will be current. Possible solution
    //       would be maintaining a list of all observed players, possibly
    //       indexed by xuid.
    // TODO: player name changes? server label changes? statefulness is hard...
    if (packet.records.type == 'add') {
      packet.records.records.forEach(r => {
        this.players[r.uuid] = r.username;
        if (r.username == this.client.username) {
          return;
        }
        prom.PLAYERS_ONLINE.set({
          instance: this.name,
          player: r.username,
        }, 1);
      });
    }
    if (packet.records.type == 'remove') {
      packet.records.records.forEach(r => {
        if (this.players[r.uuid] == this.client.username) {
          return;
        }
        prom.PLAYERS_ONLINE.set({
          instance: this.name,
          player: this.players[r.uuid],
        }, 0);
      });
    }
  }

  /**
   * level_event signal received from bedrock client - primarily weather.
   * @param {object} packet packet_level_event
   */
  level_event(packet) {
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
  start_game(packet) {
    const profile = JSON.stringify(this.client.profile);
    log(`${this.name}: logged in as ${this.client.username} (${profile})`);
    prom.WEATHER.set(
      { instance: this.name },
      packet.lightning_level > 0 ? 2 : (packet.rain_level > 0 ? 1 : 0),
    );
    prom.TICKS.set({ instance: this.name }, Number(packet.current_tick));
    prom.TIME.set({ instance: this.name }, packet.day_cycle_stop_time);
  }

  /**
   * spawn signal received from bedrock client - perform any initial actions.
   */
  spawn() {
    if (this.actions.length > 0) {
      this.performActions([...this.actions]);
    }
  }

  /**
   * Perform an item from a list of actions.
   * @param {array<string>} actions
   */
  performActions(actions) {
    setTimeout(() => {
      const action = actions.shift(actions);
      if (action === undefined) return;
      log(this.name, action);
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
      }
      else {
        this.sendText(action);
      }
      this.performActions(actions);
    }, 500);
  }

  /**
   * Close signal received from bedrock client.
   */
  close() {
    log(`${this.name} close`);
    if (this.active) {
      this.reconnectTimer = setTimeout(() => this.reconnect(10), 500);
    }
  }

  /**
   * Try to reconnect with exponential backoff.
   */
  reconnect(timeout) {
    if (this.client.status == ClientStatus.Initialized) {
      this.reconnectTimer = null;
      return;
    }
    timeout = Math.min(timeout * 1.5, 300);
    log(`${this.name} disconnected - reconnecting (${timeout}s)`);
    if (this.client.status == ClientStatus.Disconnected) {
      this.createClient();
    }
    this.reconnectTimer = setTimeout((t) => this.reconnect(t), timeout * 1000, timeout);
  }

  /**
   * Stop signal received from application (ctrl-c).
   */
  stop() {
    log(`${this.name} stop`);
    this.client.disconnect();
    this.client.close();
    if (this.reconnectTimer !== null) {
      log(this.name, ' reconnection stopped');
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Disconnect signal received from bedrock client.
   */
  disconnect() {
    log(`${this.name} disconnected`);
    console.log(`disconnect ${this.name}`);
    if (this.active) {
      this.reconnectTimer = setTimeout(() => this.reconnect(10), 500);
    }
  }

  /**
   * Handle a relayed message from discord.
   * @param {string} channel
   * @param {{object}} message
   * @returns null
   */
  relayMessage(channel, message) {
    if (this.relay[channel] === undefined) return;
    if (this.relay[channel].sendOnly) return;
    prom.CHAT.inc({
      instance: this.name,
      source: message.source,
    });
    this.sendText(common.format(this.format, message));
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
    this.client.queue('text', {
      type: 'chat',
      needs_translation: false,
      source_name: this.client.username,
      xuid: '',
      platform_chat_id: '',
      message: message,
    });
  }
}

/**
 * Start watchdog and initialize Agent objects.
 */
function init() {
  let ms = 10000;
  if (config.minecraft.connectTimeout !== undefined) {
    ms = Math.max(ms, config.minecraft.connectTimeout * 1.5);
  }
  watchdogTimer = setInterval(watchdog, ms);

  Object.entries(config.minecraft.servers).forEach(([name, options]) => {
    log(`Starting ${name}`);
    agents.push(new Agent(name, options));
  });
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
