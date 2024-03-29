const database = require('./src/database');
const discord = require('./src/discord');
const minecraft = require('./src/minecraft');
const prom = require('./src/prom');
const routing = require('./src/routing');
const actions = require('./src/actions');

async function init() {
  routing.init();
  await database.init();
  await prom.init();
  minecraft.init();
  discord.init();
  actions.init();
}

init();