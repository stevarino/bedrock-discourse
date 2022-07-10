const common = require('./common');
const config = require('./config');

const SUPERGROUP = [];

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
 * @param {common.Message} message
 */
function parseMessage(message) {
  const [command, rest] = wordPop(message.message);
  if (actions[command] !== undefined) {
    actions[command](message, rest);
  }
}

/**
 * Checks if a given sender has group authority for a given role.
 * @param {common.Message} message: Originating message object
 * @param {object} destination: discord channel or minecraft server config
 */
function checkAuth(message, destination) {
  let key = '';
  if (
    [
      common.MessageType.MinecraftChat, common.MessageType.MinecraftRelay,
      common.MessageType.MinecraftWhisper].includes(message.type)) {
    key = `m:${message.from}`;
  }
  else {
    key = `d:${message.from}`;
  }
  if (destination.groups) {
    for (const g in destination.groups) {
      if (config.groups[g].includes(key)) {
        return true;
      }
    }
  }
  else {
    return SUPERGROUP.includes(key);
  }
  return false;
}

const actions = {
  ping: function(message) {
    message.reply('pong');
  },
  say: function(message, rest) {
    const [channel, relayedMessage] = wordPop(rest);
    const filteredSend = (msgType) => {
      return (([name, def]) => {
        if (name == channel) {
          checkAuth(message, def);
          common.messenger.emit(msgType, name, relayedMessage);
        }
      });
    };
    Object.entries(config.minecraft.servers).forEach(filteredSend(common.MessageType.MinecraftChat));
    Object.entries(config.discord.channels).forEach(filteredSend(common.MessageType.DiscordChat));
  },
};

Object.assign(module.exports, {
  parseMessage,
});
