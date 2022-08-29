const common = require('./common');

class RelayNetwork {
  constructor() {
    this.relay = {};
    this.log = {};
  }

  add(type, name, options) {
    if (this[type][name] === undefined) {
      this[type][name] = {};
    }
    Object.assign(this[type][name], options);
  }
}

/**
 * {from} -> RelayNetwork -> relay -> {to} -> {options}
 *                        -> log   -> {to} -> {options}
 * @type {object<string, RelayNetwork>} from -> to mapping
 */
const NETWORKS = {};

/**
 * @type {object<string, array<object>>} from -> to mapping
 */
const MAILERS = {};

/**
 * Determines type of routing destination (minecraft/discord).
 *
 * @param {object} config Config object
 * @param {string} name Routing destination name
 * @returns {string} platform
 */
function getPlatform(config, name) {
  return config.minecraft.servers[name] !== undefined ? 'minecraft' : 'discord';
}

/**
 * Formats a message into a mail message.
 *
 * @param {common.Message} msg Message to format.
 * @param {object} options Routing options.
 */
function formatMail(msg, options) {
  if (options?.headline === true) {
    let isBold = false;
    const output = [];
    msg.split('\n').forEach(line => {
      const parts = [];
      let first = true;
      line.split(/\*\*/).forEach(text => {
        if (!first) isBold = !isBold;
        first = false;
        if (isBold) parts.push(text.trim());
      });
      output.push(parts.join(' '));
    });
    msg = output.join('\n');
  }
  return msg;
}

/**
 * Populate networks and mailers collections from a config file format.
 *
 * @param {object} config config file object
 * @returns {<array<object>>} networks and mailers.
 */
function generateNetworks(config) {
  const types = {};
  const networks = {};
  const mailers = {};
  Object.entries(config.minecraft.servers).forEach(([server, options]) => {
    let network = NETWORKS[server];
    if (network === undefined) {
      network = new RelayNetwork();
      network.relay[server] = { platform: 'minecraft' };
      networks[server] = network;
    }
    Object.entries(options.routing).forEach(([routeName, routeOptions]) => {
      routeOptions.type = routeOptions.type ?? 'relay';
      if (types[routeName] !== undefined && types[routeName] !== routeOptions.type) {
        throw new Error(`Inconsistent routing types: ${types[routeName]} / ${routeOptions.type}`);
      }
      types[routeName] = routeOptions.type;
      if (routeOptions.type == 'relay') {
        routeOptions.platform = getPlatform(config, routeName);
        network.add(routeOptions.type, routeName, routeOptions);
        if (networks[routeName] === undefined) {
          networks[routeName] = network;
        } else {
          // defined, need to merge networks
          const oldNetwork = networks[routeName];
          for (const nodeType of ['relay', 'log']) {
            Object.entries(oldNetwork[nodeType]).forEach(([other, otherOptions]) => {
              network[nodeType][other] = Object.assign(network[nodeType][other] ?? {}, otherOptions);
              networks[other] = network;
            });
          }
        }
      } else if (routeOptions.type == 'log') {
        routeOptions.platform = getPlatform(config, routeName);
        network.add('log', routeName, routeOptions);
      } else if (routeOptions.type == 'mail') {
        if (mailers[routeName] === undefined) mailers[routeName] = [];
        mailers[routeName].push({ server: server, options: routeOptions });
      } else {
        throw new Error(`Unrecognized routeOption: ${routeOptions.type}`);
      }
    });
  });
  return [networks, mailers];
}

/**
 * Messages can be relayed, broadcast (mail), or logged (one-way).
 *
 * @param {common.Message} message Message to route.
 * @param {Object<string, CacheItem>} networks Set of cache items (optional).
 */
function route(message, networks, mailers) {
  if (networks === undefined) networks = NETWORKS;
  if (mailers === undefined) mailers = MAILERS;
  if (message.getPlayer()?.nickname) {
    message.fromFriendly = message.getPlayer().nickname;
  }
  // RELAYS
  Object.entries(networks[message.source]?.relay ?? {}).forEach(([dest, options]) => {
    if (dest == message.source) return;
    if (!['MinecraftChat', 'DiscordChat'].includes(message.type)) return;
    common.emit(
      common.capitalize(options.platform) + 'Relay', dest,
      common.template('', common.getPlatformTemplates(options.platform, 'relay'), message),
    );
  });
  // LOGS
  Object.entries(networks[message.source]?.log ?? {}).forEach(([dest, options]) => {
    if (dest == message.source) return;
    if (message.isMinecraft()) return;
    if (['MinecraftChat', 'DiscordChat'].includes(message.type)) return;
    common.emit(
      common.capitalize(options.platform) + 'Chat', dest,
      common.template('', common.getPlatformTemplates(options.platform, 'log'), message),
    );
  });
  // MAILERS
  if (mailers[message.source] !== undefined) {
    mailers[message.source].forEach(dest => {
      message.message = formatMail(message.message, dest?.options);
      if (!message.message.length || message.message.length < (dest?.options?.minLength ?? 20)) return;
      common.emit(
        common.MessageType.EventServerSendMail,
        // NOTE: only use fromFriendly as discord id's are useless.
        new common.Message(
          message.source, common.MessageType.EventServerSendMail,
          message.fromFriendly, message.fromFriendly, message.message,
          { server: dest.server },
        ),
      );
    });
  }
}

function init() {
  const config = require('./config');
  const [networks, mailers] = generateNetworks(config);
  Object.assign(NETWORKS, networks);
  Object.assign(MAILERS, mailers);
}

module.exports = { init, route, generateNetworks, formatMail };