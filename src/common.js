const EventEmitter = require('events').EventEmitter;
const fs = require('fs');
const yaml = require('yaml');
const path = require('path');

const commonFormat = '[{sender}@{source}]: {content}';
const messenger = new EventEmitter();
const playerCache = [];

const MessageType = {
  MinecraftWhisper: 'MinecraftWhisper',
  MinecraftChat: 'MinecraftChat',
  MinecraftRelay: 'MinecraftRelay',
  DiscordDM: 'DiscordDM',
  DiscordChat: 'DiscordChat',
  DiscordRelay: 'DiscordRelay',
  EventServerHasMail: 'EventServerHasMail',
  EventPlayerHasMail: 'EventPlayerHasMail',
  EventServerSendMail: 'EventServerSendMail',
  EventPlayerList: 'EventPlayerList',
  Test: 'Test',
};

class Message {
  /**
   * @param {string} source Message source (discord channel, minecraft server)
   * @param {string} type MessageType value
   * @param {string} from Identifier of sender
   * @param {string} [fromFriendly] Sender identifier intended for output
   * @param {string} message Message
   * @param {object} context Optional ambiguous context
   */
  constructor({source, type, from, fromFriendly=null, message, context=null} = {}) {
    this.source = source;
    this.type = type;
    this.from = from;
    this.fromFriendly = fromFriendly || from;
    this.message = message;
    this.context = context ?? {};
  }

  /**
   * Returns the xboxId, if available.
   *
   * @returns {string}
   */
  getXBoxId() {
    return this.getPlayer()?.xboxId;
  }

  /**
   * Returns the player object of the message, if available.
   *
   * @returns {Player}
   */
  getPlayer() {
    const isDiscord = this.isDiscord();
    const isMinecraft = this.isMinecraft();
    for (const player of playerCache) {
      if (isDiscord && player.discord === this.from) {
        return player;
      }
      if (isMinecraft && player.xboxId === this.from) {
        return player;
      }
    }
    return this.context.player;
  }

  /**
   * Respond to the message.
   *
   * @param {str} response
   * @returns {null}
   */
  reply(response) {
    switch (this.type) {
    case MessageType.MinecraftWhisper:
      return messenger.emit(MessageType.MinecraftWhisper, this.from, response);
    case MessageType.DiscordDM:
      return messenger.emit(MessageType.DiscordDM, this.from, response);
    case MessageType.Test:
      this.context.response = response;
    }
  }

  /**
   * Reply to a message with a templated response.
   *
   * @param {array[string]} templates A list of templates to use
   * @param {object} values Fields to replace objects with
   */
  template(templates, values = {}) {
    if (!Array.isArray(templates)) {
      templates = [templates];
    }
    if (this.isMinecraft() || this.isDiscord()) {
      templates = getPlatformTemplates(
        this.isMinecraft() ? 'minecraft' : 'discord', templates);
    }
    this.reply(template(this.context.language, templates, values));
  }

  /**
   * Reply to a message with an error response.
   * @param {string} response
   */
  error(response) {
    this.template('error', response);
  }

  isDiscord() {
    return this.type.startsWith('Discord');
  }

  isMinecraft() {
    return this.type.startsWith('Minecraft');
  }
}

class Player {
  /**
   * A player struct
   *
   * @param {object} options Player properties
   * @param {string} options.gamertag XBox gamertag
   * @param {string} options.xboxId XBox UUID
   * @param {string} options.nickname Short alias
   * @param {string} options.discord Discord handle
   * @param {string} options.server Server (if any)
   */
  constructor(options = {}) {
    this.gamertag = options.gamertag;
    this.xboxId = options.xboxId;
    this.nickname = options.nickname;
    this.discord = options.discord;
    this.server = options.server;
  }

  /**
   * Updates player fields from a set of objects.
   *
   * @param  {...object} updates Objects to update the player fields.
   */
  merge(...updates) {
    for (const update of updates) {
      for (const key in update) {
        if (Object.prototype.hasOwnProperty.call(this, key)) {
          this[key] = update[key];
        }
      }
    }
  }
}

let templateCache = {};

/**
 * Return a formatted string from a template.
 *
 * @param {string} language Language to use ('en')
 * @param {array[string]} templateNames Names of templates to use
 * @param {object} replacements Fields to replace objects with
 * @returns {string}
 */
function template(language, templateNames, replacements = {}) {
  language = language || 'en';
  if (!Array.isArray(templateNames)) {
    templateNames = [templateNames];
  }
  if (Object.keys(templateCache).length == 0) {
    const filename = path.resolve(__dirname, '../data/templates.yaml');
    const file = fs.readFileSync(filename, 'utf8');
    templateCache = yaml.parse(file);
  }
  const cache = templateCache['messages'][language];
  if (cache === undefined) {
    throw new TypeError(`Unrecognized language: '${language}'`);
  }
  for (const templateName of templateNames) {
    if (cache[templateName] === undefined) {
      continue;
    }
    const fmt = cache[templateName];
    if (Array.isArray(fmt)) {
      return format(fmt[Math.floor(Math.random() * fmt.length)], replacements, cache);
    }
    return format(fmt, replacements, cache);
  }
  throw new TypeError(`Unrecognized templates [${templateNames.join(', ')}] for language '${language}'`);
}

/**
 * Add platform specific template options.
 *
 * @param {string} platform Platform (minecraft/discord)
 * @param {array<string>} templates List of templates
 */
function getPlatformTemplates(platform, templates) {
  platform = platform.toLowerCase();
  if (!Array.isArray(templates)) {
    templates = [templates];
  }
  const platformTemplates = [];
  templates.forEach(t => {
    platformTemplates.push(`${t}__${platform}`);
    platformTemplates.push(t);
  });
  return platformTemplates;
}

/**
 * Applies a name-based formatting replacement, similar to python's str.format method.
 *
 * A placeholder starting with an exclamation point `{!foo}` will perform a recursive
 * format operation.
 *
 * @param {string} formatString a string of the format "hello, {subject}!"
 * @param {object} replacements an object to be formatted {subject: "world"}
 * @param {object} cache language specific template cache
 * @returns {string}
 */
function format(formatString, replacements, cache) {
  if (formatString === undefined) {
    formatString = commonFormat;
  }
  // https://stackoverflow.com/a/61634647/4001895
  return formatString.replace(
    /{(!?)(\w+)}/g, (placeholder, placeholderRecursive, placeholderName) => {
      // https://eslint.org/docs/rules/no-prototype-builtins
      if (placeholderRecursive && cache !== undefined) {
        if (cache[placeholderName] === undefined) {
          console.warn(`Recursive template "${placeholderName.slice(1)}" not found`);
        } else {
          return format(cache[placeholderName], replacements, cache);
        }
      }
      if (Object.prototype.hasOwnProperty.call(replacements, placeholderName)) {
        const replacement = replacements[placeholderName];
        if (typeof replacement === 'object') {
          return JSON.stringify(replacement);
        }
        if (typeof replacement === 'function') {
          return replacement(replacements);
        }
        return replacement;
      }
      return placeholder;
    });
}

let LOG_SOURCE_LENGTH = 0;

/**
 * A consistently formatted log. Because this is important to me.
 * @param {string} source name of logging source
 * @param  {...any} args objects to be logged
 */
function log(source, ...args) {
  LOG_SOURCE_LENGTH = Math.max(LOG_SOURCE_LENGTH, source.length);
  const ts = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
  console.log(`${ts} [${source.padEnd(LOG_SOURCE_LENGTH)}]`, ...args);
}

function emit(...args) {
  messenger.emit(...args);
}

/**
 * Capitalizes first character.
 *
 * @param {string} str string to capitalize
 * @returns {string} The input string with the first character capitalized.
 */
function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => messenger.emit('stop'));
});

messenger.on(MessageType.EventPlayerList, (players) => {
  playerCache.splice(0, playerCache.length, ...players);
});

module.exports = {
  format, messenger, log, Message, MessageType, template, emit, capitalize,
  getPlatformTemplates, Player, playerCache,
};