# Pocket Prattle

A Minecraft Bedrock (aka Pocket Edition) bot that provides server monitoring, Discord relay features, and general server administration features.

What Pocket Prattle is not:

 - Not a minecraft mining bot
 - Not a minecraft combat bot
 - Not a minecraft bot that has any physical interaction with the minecraft world.

 What Pocket Prattle is:

  - Chat relay, allowing users on consoles to use their phones to communicate to your Minecraft worlds.
  - Chat logger, allowing you to keep detailed statistics and logs of Minecraft activity (log in, out, chat messages, deaths, and other messages).
  - Server performance monitor, including accurate server ticks per second (TPS) monitor.
  - An in-game email server, allowing for asyncronous email via announcements.
  - A command-line client, allowing arbitrary commands to be run from either discord or in-game. These require server specific commands to be configured, but possible examples include:
      - Editing the allowlist
      - Allowing teleport, creative mode, and other minecraft server commands, regardless of cheats settings.
      - Monitoring server health remotely.
      - Restarting Minecraft server.
      - Updating Minecraft server.

See the [configuration file example](config-example.yaml) for an overview of the features and the [configuration schema](data/config_schema.yaml) for detailed documentation of all the features. 

A minimal `config.yaml` file consists of just a single Minecraft server entry. To run the bot, enter the following command:

```
nodejs index.js config.yaml
```

For more explanation of the different parts, read below.

## Minecraft Integration

The minecraft agent is very simple, just logs in to your world. However when combined with the other features below, it can achieve things typically not possible.

## Prometheus Client Web Server

When the `web`configuration is supplied, Pocket Prattle creates a web server on the specified host/port combination. This will allow the collection of all types of data, including:

 - Current tick
 - Estimated tps
 - Time and Weather
 - Counter of who has slept
 - Counter of who has died and by what (or whom)
 - Counter of who has chatted

All this data is exposed in a text format designed for Prometheus ingestion.

[Prometheus](https://prometheus.io/) is an open source time-sequenced metric database - it makes graphs. It is not required for this project as the web endpoint Pocket Prattle exposes can be directly read.

## Discord Proxying and Fowarding

The bot can connect to multiple discord servers (guilds) and channels. Custom routing rules can be set up so a single Pocket Prattle instance can monitor multiple Bedrock Servers, relaying messages to corresponding discord channels.

## SQLite database

Used for permanence of players, statistics, and certain messages.

## ACLs and Commands

Pocket Prattle allows for complex ACLs via the `groups` settings. Actions and Commands can be arbitrarily ACL'd to a specific server, and/or for a specific command.

Actions are generic interactions with the bot. A sub set of actions are Commands, which are configuration-defined command-line operations.