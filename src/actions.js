const common = require('./common');
const database = require('./database');
const util = require('node:util');
const configLib = require('./config');
const exec = util.promisify(require('node:child_process').exec);

class Action {
  constructor({ name, action, isPriveliged = null, allowDiscord = false,
                allowMinecraft = false, allowAll = false, groups = null,
                config = null, isSilent = false } = {}) {
    this.name = name;
    this.action = action;
    this.priveliged = isPriveliged == null ? Boolean(groups) : isPriveliged;
    this.allowDiscord = allowDiscord || allowAll;
    this.allowMinecraft = allowMinecraft || allowAll || !allowDiscord;
    this.groups = groups;
    this.isSilent = isSilent;
    this.config = config
  }

  /**
   * Checks if user is authorized to run command.
   *
   * @param {common.Message} msg Message to check
   * @param {string} destination Optional destination (minecraft or discord id)
   * @param {Action} action Optional action being
   * @returns {bool}
   */
  isAuthorized(msg, destination) {
    let [authorized, reason] = this._authCheck(msg, destination);
    if (authorized) {
      return true;
    }
    this._log(msg, 'Unauthorized:', reason);
    return false;
  }

  /**
   * @param {common.Message} msg
   * @param {string} destination
   * @typedef {[bool, string]} AccessWithReason
   * @returns {AccessWithReason} authorizeded, reason
   */
  _authCheck(msg, destination) {
    if (!this.priveliged) return true;
    const key = msg.getXBoxId();
    if (!key) return false;
    // IFF action acl (if set)
    // AND channel acl (if set)
    // AND user defined (will always be true if prev true).
    if (this.groups) {
      if (!this._checkGroups(key, this.groups)) {
        return [false, `${key} not in Action ${this.name} ACL (${JSON.stringify(this.groups)})`];
      }
    }
    let groups = {
      ...(this.config.minecraft?.servers || {}),
      ...(this.config.discord || {}),
    }[destination]?.groups
    if (groups) {
      if (!this._checkGroups(key, groups)) {
        return [false, `${key} not in ${destination} ACL (${JSON.stringify(this.groups)})`];
      }
    }
    const allUsers = Object.values(this.config.groups || {}).flat();
    return [allUsers.includes(key), `${key} not defined in any groups.`];
  }

  /**
   * Checks if a key exists in a list of groups.
   *
   * @param {string} key
   * @param {array[string]} groups
   * @returns {bool}
   */
  _checkGroups(key, groups) {
    for (const g of groups) {
      if (this.config.groups[g].includes(key)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Performs a detailed log entry with metadata.
   *
   * @param {common.Message} msg Originating message.
   * @param  {...any} args Other logs to be logged.
   */
  _log(msg, ...args) {
    if (this.isSilent) return;
    log(`[${this.name} by ${msg.from} (${msg.fromFriendly})]`, ...args)
  }
}

class Command extends Action {
  constructor({ name, format, command, isPriveliged = true, allowDiscord = false,
                allowMinecraft = false, allowAll = true, groups = null,
                config = null, fullStringMatch = false, isSilent = false } = {}) {
    let re = new RegExp(fullStringMatch ? `^${format}$`: format);
    /**
     * Command action.
     *
     * @param {common.Message} msg
     * @param {string} rest
     * @returns {null}
     */
    let action = async function(msg, rest) {
      let match = re.exec(rest);
      if (match === null) {
        this._log(msg, `Format error: '${rest}' does not match ${format}`)
        msg.error(`${this.name}: Format error.`);
      }
      let args = Object.assign({}, match.groups || {});
      for (let i=0; i<match.length; i++) {
        args[`${i}`] = match[i];
      }
      let cmd = common.format(command, args);
      this._log(msg, `Executing: ${cmd}`);
      let stdout, stderr;
      try {
        ({ stdout, stderr } = await exec(cmd));
      } catch (err) {
        this._log(msg, `error: ${JSON.stringify(err)}`);
        msg.error('Error during execution. See log for details.');
        return;
      }
      this._log(msg, `stdout: ${stdout}`);
      this._log(msg, `stderr: ${stderr}`);
      msg.context.command = { stdout, stderr };
      msg.reply(`Success${stdout?.trim() ? `:  ${stdout}` : ''}`);
    }
    super({name, action, isPriveliged, config, allowDiscord, allowMinecraft, allowAll, isSilent, groups });
    return this;
  }
}

function wordPop(str) {
  const firstWordPtn = /^\s*([^\s]+)\s*(.*)$/;
  const result = firstWordPtn.exec(str);
  return [result[1], result[2]];
}

/**
 * Attempt to perform a requested action
 *
 * @param {common.Message} message
 */
function parseMessage(message) {
  const [command, rest] = wordPop(message.message);
  for (const action of ACTIONS) {
    if (action.name == command) {
      if (!action.isAuthorized(message)) continue;
      if (!action.allowDiscord && message.isDiscord()) continue;
      if (!action.allowMinecraft && message.isMinecraft()) {
        log(`channel not allowed ${action.name} - ${message.from}`);
        continue;
      }
      action.action(message, rest);
      return;
    }
  }
  message.template('error', `Command "${command}" not found.`);
}

const [
  isPriveliged,
  allowDiscord, // eslint-disable-line no-unused-vars
  allowMinecraft,
  allowAll,
] = Array(4).fill(true);

const _actions = [
  { name: 'ping', allowAll, action: (msg) => msg.reply('pong') },

  { name: 'help', allowAll,
    action: function(msg) {
      const reply = ['Available commands:'];
      ACTIONS.forEach(action => {
        if (!action.isAuthorized(msg)) return;
        if (!action.allowDiscord && msg.isDiscord()) return;
        if (!action.allowMinecraft && msg.isMinecraft) return;
        const help = common.template(msg.context.language, `action__${action.name}__help`);
        reply.push(` - ${action.name}: ${help}`);
      });
      msg.reply(reply.join('\n'));
    },
  },

  { name: 'say', isPriveliged, allowAll,
    action: function(msg, rest) {
      const [channel, relayedMessage] = wordPop(rest);
      const filteredSend = (msgType) => {
        return (([name, def]) => {
          if (name == channel) {
            this.isAuthorized(msg, def);
            common.messenger.emit(msgType, name, relayedMessage);
          }
        });
      };
      Object.entries(config.minecraft.servers).forEach(filteredSend(common.MessageType.MinecraftChat));
      Object.entries(config.discord.channels).forEach(filteredSend(common.MessageType.DiscordChat));
    },
  },

  { name: 'read', allowMinecraft,
    action: async function(msg) {
      // TODO: checking from discord
      // TODO: "read all"
      // TODO: "read message_foo"
      const mail = await database.instance().getPlayerMessage(msg.source, msg.from);
      if (mail === null) {
        msg.template(['inbox_empty']);
        return;
      }
      const templates = ['mail'];
      templates.unshift(mail.isServer ? 'mail_server' : 'mail_player');
      msg.template(templates, {
        from: mail.from,
        when: mail.createdAt.toISOString().split('T')[0],
        message: mail.message,
      });
    },
  },

  { name: 'account', allowAll,
    action: async function(msg) {
      const player = msg.getPlayer();
      if (player === undefined) return msg.template('error');
      return msg.reply(JSON.stringify(player, null, 2));
    },
  },

  { name: 'check', allowMinecraft,
    action: async function(msg) {
      const messageCount = await database.instance().countPlayerMessages(msg.source, msg.from);
      let templates = ['inbox'];
      if (messageCount == 0) templates.unshift('inbox_empty');
      if (messageCount == 1) templates.unshift('inbox_one');
      templates = common.getPlatformTemplates('minecraft', templates);
      msg.template(templates, { messageCount });
    },
  },

  { name: 'send', allowMinecraft,
    action: async function(msg, rest) {
      const [name, mail] = wordPop(rest);
      const xboxId = await database.instance().playerNameToXBoxId(name);
      if (xboxId === undefined) {
        return msg.template('unknown_player', { player: name });
      }
      await database.instance().sendPlayerMessage(msg.from, xboxId, mail);
      msg.template('mail_sent');
    },
  },

  { name: 'nick', allowMinecraft,
    action: async function(msg, rest) {
      if (await database.instance().registerNick(msg.from, rest)) {
        return msg.template('success');
      }
      msg.template('error');
    },
  },

  { name: 'set_nick', isPriveliged,
    action: async function(msg, rest) {
      const player = wordPop(rest);
      if (await database.instance().registerNick(player, rest)) {
        return msg.template('success');
      }
      msg.template('error');
    },
  },

  { name: 'link', allowAll,
    action: async function(msg, rest) {
      if (msg.type == common.MessageType.MinecraftWhisper) {
        if (rest.trim() == '') {
          const code = await database.instance().initDiscordLink(msg.from);
          return msg.template('action__link__step1', { code });
        }
      } else if (msg.type == common.MessageType.DiscordDM) {
        if (/^[0-9]+$/.test(rest)) {
          const user = await database.instance().finalizeDiscordLink(rest, msg.from);
          return msg.template('action__link__step2', { user });
        }
      }
      msg.template('error');
    },
  },

  { name: 'list_players', allowAll, isPriveliged,
    action: async function(msg, rest) {
      const players = database.instance().getPlayers();
      if (msg.isMinecraft()) {
        players[msg.source];
      }
      if (msg.type == common.MessageType.MinecraftWhisper) {
        if (rest.trim() == '') {
          const code = await database.instance().initDiscordLink(msg.from);
          return msg.template('action__link__step1', { code });
        }
      } else if (msg.type == common.MessageType.DiscordDM) {
        if (/^[0-9]+$/.test(rest)) {
          const user = await database.instance().finalizeDiscordLink(rest, msg.from);
          return msg.template('action__link__step2', { user });
        }
      }
      msg.template('error');
    },
  },
  { name: 'reload_config', allowAll, isPriveliged,
    action: async function(msg) {
      let config = configLib.processConfig();
      if (config.groups) {
        configLib.get().groups = config.groups;
      }
      if (config.commands) {
        configLib.get().commands = config.commands;
      }
      init();
      msg.reply('OK.')
    }
  }
];

const ACTIONS = [];

function init(config = null) {
  if (!config) {
    config = configLib.get();
  }
  let actions = [];
  ACTIONS.length = 0;
  let names = new Set();
  _actions.forEach(a => {
    let action = Object.assign({}, a, { config });
    names.add(a.name);
    actions.push(new Action(action));
  });
  Object.entries(config.commands || {}).forEach(([name, cmd]) => {
    if (name in names) {
      throw new Error(`Command ${name} already defined`);
    }
    let action = Object.assign({}, cmd, {name, config});
    names.add(name);
    actions.push(new Command(action));
  });
  ACTIONS.push(...actions);
  return actions;
}


function log(...args) {
  common.log('actions', ...args);
}

module.exports = { init, parseMessage, Action, Command };
