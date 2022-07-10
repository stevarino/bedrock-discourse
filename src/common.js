const EventEmitter = require('events').EventEmitter;

const commonFormat = '[{sender}@{source}]: {content}';
const messenger = new EventEmitter();

const MessageType = {
  MinecraftWhisper: 'MinecraftWhisper',
  MinecraftChat: 'MinecraftChat',
  MinecraftRelay: 'MinecraftRelay',
  DiscordDM: 'DiscordDM',
  DiscordChat: 'DiscordChat',
  DiscordRelay: 'DiscordRelay',
};

class Message {
  constructor(type, from, fromFriendly, message) {
    this.type = type;
    this.from = from;
    this.fromFriendly = fromFriendly;
    this.message = message;
  }

  /**
   * Respond to the message.
   *
   * @param {str} response
   * @returns null;
   */
  reply(response) {
    switch (this.type) {
    case MessageType.MinecraftWhisper:
      return messenger.emit(MessageType.MinecraftWhisper, this.from, response);
    case MessageType.DiscordDM:
      return messenger.emit(MessageType.DiscordDM, this.from, response);
    }
  }
}


/**
 * Applies a name-based formatting replacement, similar to python's str.format method.
 * @param {string} formatString a string of the format "hello, {subject}!"
 * @param {object} replacements an object to be formatted {subject: "world"}
 * @returns string
 */
function format(formatString, replacements) {
  if (formatString === undefined) {
    formatString = commonFormat;
  }
  // https://stackoverflow.com/a/61634647/4001895
  return formatString.replace(
    /{(\w+)}/g, (placeholderWithDelimiters, placeholderWithoutDelimiters) =>
      // https://eslint.org/docs/rules/no-prototype-builtins
      Object.prototype.hasOwnProperty.call(replacements, placeholderWithoutDelimiters) ?
        replacements[placeholderWithoutDelimiters] : placeholderWithDelimiters);
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

['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => messenger.emit('stop'));
});

module.exports = {
  format, messenger, log, Message, MessageType,
};