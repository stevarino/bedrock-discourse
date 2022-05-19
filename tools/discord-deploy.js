const { SlashCommandBuilder } = require('@discordjs/builders');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const config = require('../src/config');

const commands = [
  new SlashCommandBuilder().setName('allow').setDescription('Manage allowlist for a given server (add/remove users)'),
  new SlashCommandBuilder().setName('broadcast').setDescription('Manage allowlist for a given server (add/remove users)'),
]
  .map(command => command.toJSON());
const rest = new REST({ version: '9' }).setToken(config.discord.token);

Object.entries(config.channels).forEach(([channel, channelConfig]) => {
  rest.put(
    Routes.applicationGuildCommands(
      config.discord.app_id, channelConfig.guild,
    ), { body: commands })
    .then(() => console.log(`Successfully registered application commands for ${channel}.`))
    .catch(console.error);
});
