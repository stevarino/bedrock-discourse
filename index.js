const discord = require('./src/discord');
const prom = require('./src/prom');
const minecraft = require('./src/minecraft');

function init() {
  prom.init();
  minecraft.init();
  discord.init();

  process.on('SIGINT', () => {
    minecraft.stop();
  });
}

init();