const common = require('./common');
const config = require('./config');
const database = require('./database');

const SUPERGROUP = [];

class Action {
  constructor({ name, action, isPriveleged = false, allowDiscord = false, allowMinecraft = false, allowAll = false } = {}) {
    this.name = name;
    this.action = action;
    this.priveleged = isPriveleged;
    this.allowDiscord = allowDiscord || allowAll;
    this.allowMinecraft = allowMinecraft || allowAll || !allowDiscord;
  }
}

Object.values(config.groups || {}).forEach(members => {
  members.forEach(member => SUPERGROUP.push(member));
});

function wordPop(str) {
  const firstWordPtn = /^\s*([^\s]+)\s*(.*)$/;
  const result = firstWordPtn.exec(str);
  return [result[1], result[2]];
}

/**
 * Attempt to read a command
 *
 * @param {common.Message} message
 */
function parseMessage(message) {
  const [command, rest] = wordPop(message.message);
  for (const action of actions) {
    if (action.name == command) {
      if (!action.allowDiscord && message.isDiscord()) continue;
      if (!action.allowMinecraft && message.isMinecraft()) continue;
      action.action(message, rest);
      break;
    }
  }
}

/**
 * Checks if a given sender has group authority for a given role.
 *
 * @param {common.Message} message: Originating message object
 * @param {object} destination: discord channel or minecraft server config
 */
function checkAuth(message, destination) {
  const key = message.getXBoxId();
  if (destination.groups) {
    for (const g in destination.groups) {
      if (config.groups[g].includes(key)) {
        return true;
      }
    }
  } else {
    return SUPERGROUP.includes(key);
  }
  return false;
}

const [
  isPriveleged,
  allowDiscord, // eslint-disable-line no-unused-vars
  allowMinecraft,
  allowAll,
] = Array(4).fill(true);

const actions = [
  new Action({ name: 'ping', allowAll, action: (msg) => msg.reply('pong') }),

  new Action({ name: 'help', allowAll, action: (msg) => {
    const reply = ['Available commands:'];
    actions.forEach(action => {
      if (action.priveleged && !SUPERGROUP.includes(msg.getXBoxId())) return;
      if (!action.allowDiscord && msg.isDiscord()) return;
      if (!action.allowMinecraft && msg.isMinecraft) return;
      const help = common.template(msg.context.language, `action__${action.name}__help`);
      reply.push(` - ${action.name}: ${help}`);
    });
    msg.reply(reply.join('\n'));
  } }),

  new Action({ name: 'say', isPriveleged, allowAll, action: (msg, rest) => {
    const [channel, relayedMessage] = wordPop(rest);
    const filteredSend = (msgType) => {
      return (([name, def]) => {
        if (name == channel) {
          checkAuth(msg, def);
          common.messenger.emit(msgType, name, relayedMessage);
        }
      });
    };
    Object.entries(config.minecraft.servers).forEach(filteredSend(common.MessageType.MinecraftChat));
    Object.entries(config.discord.channels).forEach(filteredSend(common.MessageType.DiscordChat));
  } }),

  new Action({ name: 'read', allowMinecraft, action: async (msg) => {
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
  } }),

  new Action({ name: 'account', allowAll, action: async (msg) => {
    const player = msg.getPlayer();
    if (player === undefined) return msg.template('error');
    return msg.reply(JSON.stringify(player, null, 2));
  } }),

  new Action({ name: 'check', allowMinecraft, action: async (msg) => {
    const messageCount = await database.instance().countPlayerMessages(msg.source, msg.from);
    let templates = ['inbox'];
    if (messageCount == 0) templates.unshift('inbox_empty');
    if (messageCount == 1) templates.unshift('inbox_one');
    templates = common.getPlatformTemplates('minecraft', templates);
    msg.template(templates, { messageCount });
  } }),

  new Action({ name: 'send', allowMinecraft, action: async (msg, rest) => {
    const [name, mail] = wordPop(rest);
    const xboxId = await database.instance().playerNameToXBoxId(name);
    if (xboxId === undefined) {
      return msg.template('unknown_player', { player: name });
    }
    await database.instance().sendPlayerMessage(msg.from, xboxId, mail);
    msg.template('mail_sent');
  } }),

  new Action({ name: 'nick', allowMinecraft, action: async (msg, rest) => {
    if (await database.instance().registerNick(msg.from, rest)) {
      return msg.template('success');
    }
    msg.template('error');
  } }),

  new Action({ name: 'set_nick', isPriveleged, action: async (msg, rest) => {
    const player = wordPop(rest);
    if (await database.instance().registerNick(player, rest)) {
      return msg.template('success');
    }
    msg.template('error');
  } }),

  new Action({ name: 'link', allowAll, action: async (msg, rest) => {
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
  } }),
];

module.exports = { parseMessage };
