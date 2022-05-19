# Pocket Prattle

A Minecraft Bedrock (aka Pocket Edition) bot that provides server monitoring statistics and Discord relay features.

## Minecraft Integration

The minecraft agent is very simple, just logs in to your world. However when combined with the other features below, it can achieve things typically not possible.

See the [configuration file example](config-example.yaml) as an overview of the features. Typically all that is needed is a custom config file, and the bot can be run directly vai:

```
nodejs index.js config.yaml
```

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