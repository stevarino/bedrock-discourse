const Discord = require('discord.js');

const actions = require('./actions');
const config = require('./config').get();
const common = require('./common');
const routing = require('./routing');

const channelsById = {};
const guildNicks = {};
const permissions = '378024314880';
const channelUrl = new RegExp('^https://discord\\.com/channels/([0-9]+)/([0-9]+)$');

/**
 * Initialize discord client, if configured.
 * @returns {null}
 */
function init() {
  if (config.discord === undefined) {
    return;
  }
  log(`Add to server: https://discord.com/api/oauth2/authorize?client_id=${config.discord.app_id}&permissions=${permissions}&scope=bot`);

  const client = new Discord.Client({
    partials: ['CHANNEL'],
    intents: [
      Discord.Intents.FLAGS.GUILD_MESSAGES,
      Discord.Intents.FLAGS.GUILDS,
      Discord.Intents.FLAGS.DIRECT_MESSAGES,
    ],
  });

  Object.entries(config.discord.channels).forEach(([name, channel]) => {
    channel.name = name;
    if (channel.url !== undefined) {
      const result = channelUrl.exec(channel.url);
      if (result === null) throw new Error(`Unrecognized URL: ${channel.url}`);
      channel.guild = result[1];
      channel.channel = result[2];
    }
    channelsById[channel.channel] = channel;
    if (channel.nick !== undefined) {
      guildNicks[channel.guild] = channel.nick;
    }
  });

  common.messenger.on(common.MessageType.DiscordRelay, (channel, message) => {
    Object.values(channelsById).forEach(c => {
      if (c.name == channel) {
        c.channelObj.send(message);
      }
    });
  });

  common.messenger.on(common.MessageType.DiscordChat, (channel, message) => {
    Object.values(channelsById).forEach(c => {
      if (c.name == channel) {
        c.channelObj.send(message);
      }
    });
  });

  common.messenger.on(common.MessageType.DiscordDM, async (snowflake, message) => {
    const user = await client.users.fetch(snowflake);
    user.send(message);
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
    if (message.author.bot || (channelsById[message.channelId] === undefined && message.channel.type != 'DM')) {
      return;
    }
    // https://discord.js.org/#/docs/discord.js/stable/typedef/TextBasedChannelTypes
    if (message.channel.type == 'DM') {
      actions.parseMessage(new common.Message({
        source: null,
        type: common.MessageType.DiscordDM,
        from: message.author.id,
        fromFriendly: `${message.author.username}#${message.author.discriminator}`,
        message: message.content,
    }));
      return;
    }
    const author = await message.guild.members.fetch(message.author);
    const user_id = `${author.user.username}#${author.user.discriminator}`;
    const channel = channelsById[message.channelId].name;
    routing.route(new common.Message({
      source: channel,
      type: common.MessageType.DiscordChat,
      from: author.id,
      fromFriendly: author.nickname ?? user_id,
      message: message.content,
    }));
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