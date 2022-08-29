const common = require('./common');
const sequelize = require('sequelize');
const { Sequelize, DataTypes, Op } = sequelize;

let db = null;

/** @type {object<string, common.Player>} */
const playerCache = {};

class Mail {
  /**
   * A peer or server messsage.
   *
   * @param {string} from who sent the message
   * @param {bool} isPeer if the message is sent from another player
   * @param {string} source source of message
   * @param {string} message message contents
   * @param {Date} createdAt When the message was sent
   */
  constructor(from, isServer, source, message, createdAt) {
    this.from = from;
    this.isServer = isServer;
    this.source = source;
    this.message = message;
    this.createdAt = createdAt;
  }
}

class Counter {
  /**
   * A structure to hold a Counter value.
   *
   * @param {object<string, string>} fields Mapping of fields + values.
   * @param {number} value Counter value
   */
  constructor(fields, value) {
    this.fields = fields;
    this.value = value;
  }
}

class DatabaseWrapper {
  /**
   * Constructor.
   * @param {object} databaseConfig
   */
  constructor(databaseConfig) {
    this.serverCache = {};
    /** @type Object<array<string>> */
    this.gamertagCache = {};
    this.sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: (databaseConfig?.path || './database.sqlite3'),
      logging: (databaseConfig?.logging) ? (...msg) => common.log('database', ...msg) : false,
      transactionType: 'IMMEDIATE',
    });

    this.Setting = this.sequelize.define('Setting', {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      key: DataTypes.STRING,
      value: DataTypes.STRING,
    }, {
      indexes: [
        { fields: ['key'], unique: true },
      ],
    });

    this.Player = this.sequelize.define('Player', {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      xboxId: DataTypes.STRING,
      gamertag: DataTypes.STRING,
      nickname: DataTypes.STRING,
      discord: DataTypes.STRING,
      timezone: DataTypes.STRING,
      language: {
        type: DataTypes.STRING,
        defaultValue: 'en',
      },
      hidden: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      code: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      codeExpiration: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    }, {
      indexes: [
        { fields: ['xboxId'], unique: true },
        { fields: ['gamertag'] },
        { fields: ['nickname'], unique: true },
        { fields: ['discord'] },
      ],
    });

    this.PeerMessage = this.sequelize.define('PeerMessage', {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      message: DataTypes.STRING,
      source: DataTypes.STRING,
      read: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
    });

    this.Player.hasMany(this.PeerMessage, {
      as: 'sender', allowNull: false, foreignKey: 'senderId',
    });
    this.Player.hasMany(this.PeerMessage, {
      as: 'receiver', allowNull: false, foreignKey: 'receiverId',
    });
    this.PeerMessage.belongsTo(this.Player, {
      as: 'sender', foreignKey: 'senderId',
    });
    this.PeerMessage.belongsTo(this.Player, {
      as: 'receiver', foreignKey: 'receiverId',
    });

    this.Server = this.sequelize.define('Server', {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      server: DataTypes.STRING,
    });

    this.ServerMessage = this.sequelize.define('ServerMessage', {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      from: DataTypes.STRING,
      source: DataTypes.STRING,
      message: DataTypes.STRING,
    });

    this.Server.hasMany(this.ServerMessage);
    this.ServerMessage.belongsTo(this.Server);

    this.PlayerServerMessage = this.sequelize.define('PlayerServerMessage', {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      lastChecked: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
      },
    });

    this.Server.hasMany(this.PlayerServerMessage);
    this.PlayerServerMessage.belongsTo(this.Server);
    this.Player.hasMany(this.PlayerServerMessage);
    this.PlayerServerMessage.belongsTo(this.Player);

    this.Counter = this.sequelize.define('Counter', {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      name: DataTypes.STRING,
      fields: DataTypes.JSON,
      value: DataTypes.NUMBER,
    }, {
      indexes: [
        { fields: ['name'] },
      ],
    });
  }

  async sync() {
    await this.sequelize.sync();
  }

  async close() {
    await this.sequelize.close();
  }

  /**
   * Returns a map of server => gamertags seen in the last 30 days.
   *
   * @param {bool} updateCache whether to query the database prior to returning.
   * @returns {object<string, array<string>>} Mapping of servers to gamertags.
   */
  async getPlayers(updateCache = false) {
    // let needsUpdate = false;
    if (!updateCache) {
      return Object.assign({}, this.gamertagCache);
    }
    const playerServer = await this.PlayerServerMessage.findAll(
      {
        where: {
          '$Player.hidden$': false,
          '$Player.updatedAt$': { [Op.gt]: new Date(new Date() - 30 * 24 * 60 * 60 * 1000) },
        },
        include: [
          { model: this.Player, required: true },
          { model: this.Server, required: true },
        ],
      },
    );
    playerServer.forEach(ps => {
      if (this.gamertagCache[ps.Server.server] === undefined) {
        this.gamertagCache[ps.Server.server] = [];
      }
      if (!this.gamertagCache[ps.Server.server].includes(ps.Player.gamertag)) {
        // needsUpdate = true;
        this.gamertagCache[ps.Server.server].push(ps.Player.gamertag);
      }
      if (playerCache[ps.Player.xboxId] === undefined) {
        playerCache[ps.Player.xboxId] = new common.Player();
      }
      playerCache[ps.Player.xboxId].merge(ps.Player);
    });
    this.updatePlayerList();
    // if (needsUpdate) {
    //   common.emit('playerList', this.gamertagCache);
    // }
    return Object.assign({}, this.gamertagCache);
  }


  /**
   *
   * @param {string} server server to update
   * @param {Object<string, array<string>>} players mapping of xbox-id to gamertag
   */
  async checkInPlayers(server, players) {
    if (this.serverCache[server] === undefined) {
      [this.serverCache[server]] = await this.Server.findOrCreate({
        where: { server: server },
      });
      this.gamertagCache[server] = [];
    }
    for (const [xboxId, tag] of Object.entries(players)) {
      const [player, created] = await this.Player.findOrCreate({
        where: { xboxId: xboxId },
        defaults: { gamertag: tag },
      });
      if (!created) {
        player.changed('updatedAt', true);
        player.gamertag = tag;
        await player.save();
      }
      await this.PlayerServerMessage.findOrCreate({
        where: {
          PlayerId: player.id,
          ServerId: this.serverCache[server].id },
      });
      if (playerCache[xboxId] === undefined) {
        playerCache[xboxId] = new common.Player();
      }
      playerCache[xboxId].merge({ server }, player.toJSON());
    }
    this.updatePlayerList();
  }

  updatePlayerList() {
    common.emit(common.MessageType.EventPlayerList, Object.values(playerCache));
  }

  /**
   * Mark a set of xbox uuid's as hidden, preventing them from appearing on metrics.
   *
   * @param {array<string>} xboxIds XBox UUIDs to mark hidden.
   */
  async markPlayersHidden(xboxIds) {
    await this.Player.update(
      { hidden: true },
      { where: { xboxId: { [Op.in]: xboxIds } } },
    );
    await this.Player.update(
      { hidden: false },
      { where: { xboxId: { [Op.notIn]: xboxIds } } },
    );
  }

  /**
   * Given a string name, attempts to find a player either by gamertag or nickname.
   *
   * @param {string} playerName name of player to lookup.
   */
  async playerNameToXBoxId(playerName) {
    const name = playerName.toLowerCase();
    const player = await this.Player.findOne({
      where: { [Op.or]: [
        sequelize.where(sequelize.fn('lower', sequelize.col('gamertag')), name),
        sequelize.where(sequelize.fn('lower', sequelize.col('nickname')), name),
      ] },
    });
    return player?.xboxId;
  }

  /**
   * Attempt to register a nickname.
   *
   * @param {string} xboxId player xbox-id
   * @param {string} nickname nickname
   * @returns {bool} if registration successful
   */
  async registerNick(xboxId, nickname) {
    if (!/[a-zA-Z0-9_-]{3,}/.test(nickname)) return false;
    if (await this.playerNameToXBoxId(nickname) !== undefined) {
      return false;
    }
    const player = await this.Player.findOne({ where: { xboxId } });
    await player.update({ nickname });
    playerCache[player.xboxId].merge(player.toJSON());
    this.updatePlayerList();
    return true;
  }

  /**
   * Send a message to all players on a server.
   *
   * @param {common.Message} message Message object
   */
  async sendServerMessage(message) {
    const server = await this.Server.findOne({ where: {
      server: message.context.server } });
    if (server === null) {
      throw new Error(`Server not found: ${server.server}`);
    }
    await this.ServerMessage.create({
      message: message.message, from: message.from, ServerId: server.id,
      source: message.source });
    common.emit(common.MessageType.EventServerHasMail, server.server);
  }

  /**
   * Send a messsage to a player from another player
   *
   * @param {string} xboxFrom Message Sender
   * @param {string} xboxTo Message Receiver
   * @param {string} message Message to send
   */
  async sendPlayerMessage(xboxFrom, xboxTo, message) {
    const to = await this.Player.findOne({ where: { xboxId: xboxTo } });
    const from = await this.Player.findOne({ where: { xboxId: xboxFrom } });
    await this.PeerMessage.create({
      senderId: from.id, receiverId: to.id, message: message,
    });
    common.emit(common.MessageType.EventPlayerHasMail, xboxTo);
  }

  /**
   * Returns how many messages are unread for a given (player, server) tuple.
   *
   * @param {string} server server to search over
   * @param {string} xboxId player to search over
   * @returns {number}
   */
  async countPlayerMessages(server, xboxId) {
    const inbox = await this.PlayerServerMessage.findOne(
      {
        attributes: {
          include: [
            [
              sequelize.literal(`(
                SELECT Count(*)
                FROM PeerMessages as pm
                WHERE 
                  pm.receiverId = PlayerServerMessage.PlayerId 
                  AND pm.read = false
              )`),
              'peerMessageCount',
            ],
            [
              sequelize.literal(`(
                SELECT Count(*)
                FROM ServerMessages as sm
                WHERE
                  sm.createdAt > PlayerServerMessage.lastChecked
                  AND sm.ServerId = PlayerServerMessage.ServerId
              )`),
              'serverMessageCount',
            ],
          ],
        },
        include: [
          { model: this.Player, required: true, where: { xboxId: xboxId } },
          { model: this.Server, required: true, where: { server: server } },
        ],
      },
    );
    // TODO: figure out why toJSON() is needed.
    return inbox.toJSON().peerMessageCount + inbox.toJSON().serverMessageCount;
  }

  /**
   * Returns the latest message, or null. Takes 3 lookup queries (1 indexed) and 1 write
   * query. Could be reduced to a single lookup and single write but that would require
   * literal queries and abandoning the ORM.
   *
   * @param {string} server server to lookup
   * @param {string} xboxId user to check messages for
   * @returns {Mail} message on success, or null on no mail
   */
  async getPlayerMessage(server, xboxId) {
    const serverPlayer = await this.PlayerServerMessage.findOne(
      { include: {
        model: this.Player,
        required: true,
        where: { xboxId: xboxId },
      } },
      { include: {
        model: this.Server,
        required: true,
        where: { server: server },
      } },
    );
    const peerMessage = await this.PeerMessage.findOne(
      {
        include: 'sender',
        where: { receiverId: serverPlayer.PlayerId, read: false },
        order: [[ 'createdAt', 'ASC' ]],
      },
    );
    const serverMessage = await this.ServerMessage.findOne({
      where: { createdAt: { [Op.gt]: serverPlayer.lastChecked } },
      order: [[ 'createdAt', 'ASC' ]],
    });
    if (peerMessage === null && serverMessage === null) {
      return null;
    }
    if (serverMessage === null || (peerMessage !== null && peerMessage.createdAt <= serverMessage.createdAt)) {
      await peerMessage.update({ read: true });
      return new Mail(
        peerMessage.sender.gamertag, false, peerMessage.source, peerMessage.message, peerMessage.createdAt,
      );
    }
    await serverPlayer.update({ lastChecked: serverMessage.createdAt });
    return new Mail(
      serverMessage.from, true, serverMessage.source, serverMessage.message, serverMessage.createdAt,
    );
  }

  /**
   * Pulls counter data from database.
   *
   * @param {string} name identifier of the counter
   * @returns {array<Counter>}
   */
  async getCounter(name) {
    const counters = await this.Counter.findAll({ where: { name: name } });
    return counters.map(cnt => new Counter(cnt.fields, cnt.value));
  }

  /**
   * Updates a counter value.
   *
   * @param {string} name Counter identifier
   * @param {array<string>} fields Counter fields
   * @param {number} value Value
   * @returns bool
   */
  async setCounter(name, fields, value) {
    const [counter, created] = await this.Counter.findOrCreate({
      where: { name: name, fields: fields },
      defaults: { value: value },
    });
    if (created) return;
    counter.value = value;
    counter.save();
    return created;
  }

  /**
   * Begin link process between minecraft and discord.
   *
   * @param {string} xboxId User to update.
   * @returns {string} Update code.
   */
  async initDiscordLink(xboxId) {
    const chars = '0123456789';
    const code = Array(4).fill('').map(
      () => chars.charAt(Math.floor(Math.random() * chars.length)),
    ).join('');
    await this.Player.update(
      { code: code, codeExpiration: new Date((new Date().getTime() + 300_000)) },
      { where: { xboxId: xboxId } },
    );
    return code;
  }

  /**
   * Finish linking minecraft and discord accounts.
   *
   * @param {string} code Update code.
   * @param {string} handle Discord handle.
   * @returns {bool} True on success.
   */
  async finalizeDiscordLink(code, handle) {
    const players = await this.Player.findAll(
      { where: {
        code: code,
        codeExpiration: { [Op.gt]: new Date() },
      } },
    );
    if (players.length !== 1) return null;
    const player = players[0];
    await player.update({
      code: '',
      discord: handle,
    });
    Object.assign(playerCache[player.xboxId] ?? {}, { discord: handle });
    this.updatePlayerList();
    return player.nickname ?? player.gamertag;
  }
}

/**
 * @returns {DatabaseWrapper}
 */
function instance() {
  if (db === null) {
    throw new Error('database is uninitialized!');
  }
  return db;
}

async function init() {
  const config = require('./config');
  db = new DatabaseWrapper(config.database);
  await db.sync();
  const [ version ] = await db.Setting.findOrCreate({
    where: { key: 'version' },
    defaults: { value: '1' },
  });
  switch (version.value) {
  case '1':
    // TODO: upgrade db to v2
    break;
  default:
    throw new Error(`Unreconized database version: ${version.value}`);
  }
  if (config.database?.hiddenXuids) {
    await db.markPlayersHidden(config.database.hiddenXuids);
  }
  await db.getPlayers(true);
  common.messenger.on(common.MessageType.EventServerSendMail, (msg) => db.sendServerMessage(msg));
}

module.exports = {
  init, DatabaseWrapper, instance,
};
