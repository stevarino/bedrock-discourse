const Discord = require('discord.js');
const config = require('./config');
const common = require('./common');

const channelsById = {};
const guildNicks = {};

/**
 * Initialize discord client, if configured.
 * @returns null
 */
function init() {
  if (config.discord === undefined) {
    return;
  }

  common.messenger.on('discord', (channel, message) => {
    Object.values(channelsById).forEach(c => {
      if (c.name == channel) {
        c.channelObj.send(common.format(c.format, message));
      }
    });
  });

  const client = new Discord.Client({ intents: [Discord.Intents.FLAGS.GUILD_MESSAGES, Discord.Intents.FLAGS.GUILDS] });

  Object.entries(config.discord.channels).forEach(([name, channel]) => {
    channel.name = name;
    channelsById[channel.channel] = channel;
    if (channel.nick !== undefined) {
      guildNicks[channel.guild] = channel.nick;
    }
  });

  common.messenger.on('stop', () => {
    log('received stop; disconnecting.');
    client.destroy();
  });

  client.on('ready', () => {
    log(`Logged in as ${client.user.tag}!`);
    client.channels.cache.forEach(channel => {
      const props = channelsById[channel.id];
      if (props === undefined) {
        // not a defined channel, skip.
        return;
      }
      props.channelObj = channel;
    });

    // check for configured channels not authorized.
    Object.values(channelsById).forEach(c => {
      if (c.channelObj === undefined) {
        log(`Warning: Not registered with channel ${c.name} (${c.guild})`);
      }
    });

    // register client nicknames
    client.guilds.cache.forEach(guild => {
      const nick = guildNicks[guild.id] || config.discord.nick;
      if (nick !== undefined) {
        const m = guild.members.resolve(config.discord.app_id);
        m.setNickname(nick).then(() => {
          log(`Set nickname to '${nick}' for guild '${guild.name}' (${guild.id}).`);
        });
      }
    });
  });

  client.on('messageCreate', async message => {
    if (message.author.bot) {
      return;
    }
    const author = await message.guild.members.fetch(message.author);
    const user_id = `${author.user.username}#${author.user.discriminator}`;
    const channel = channelsById[message.channelId].name;
    const messageObj = {
      source: channel,
      sender: author.nickname ?? user_id,
      content: message.content,
      senderid: user_id,
      type: message.type,
    };
    common.messenger.emit('minecraft', channel, messageObj);
  });

  client.login(config.discord.token);
}

function log(...args) {
  common.log('discord', ...args);
}

if (require.main === module) {
  init();
}

Object.assign(module.exports, {
  init,
});