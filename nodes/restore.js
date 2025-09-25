module.exports = function HubitatRestoreModule(RED) {
  const fetch = require("node-fetch");
  const doneWithId = require("./utils/done-with-id");

  function HubitatRestoreNode(config) {
    RED.nodes.createNode(this, config);

    const node = this;
    node.hubitat = RED.nodes.getNode(config.server);
    node.name = config.name;

    function configuredDeviceList() {
      if (Array.isArray(config.devices) && config.devices.length) return config.devices.slice();
      if (config.deviceId) return Array.isArray(config.deviceId) ? config.deviceId.slice() : [config.deviceId];
      return [];
    }

    node.devices = configuredDeviceList();

    if (!node.hubitat) {
      node.error("Hubitat server not configured");
      return;
    }

    node.on("input", async function (msg, send, done) {
      try {
        const toRestore = configuredDeviceList();
        if (!Array.isArray(toRestore) || toRestore.length === 0) {
          node.warn("No devices selected");
          send(msg);
          if (done) done();
          return;
        }

        const flowContext = node.context().flow;

        await Promise.all(toRestore.map(async (deviceId) => {
          const key = `hubitat_device_state_${deviceId}`;
          const state = flowContext.get(key);

          if (!state) {
            node.warn(`No saved state for ${deviceId}`);
            return;
          }

          let commands = [];

          // Switch-only devices
          if (state.switch !== undefined && state.level === undefined && state.colorMode === undefined) {
            commands.push({ deviceId, command: state.switch });
          }

          // Dimmers (switch + level)
          if (state.level !== undefined && state.colorMode === undefined) {
            if (state.switch === "off") {
              commands.push({ deviceId, command: "off" });
            } else {
              commands.push({ deviceId, command: "on" });
              commands.push({ deviceId, command: "setLevel", arguments: [state.level] });
            }
          }

          // Color bulbs
          if (state.colorMode !== undefined) {
            if (state.switch === "off") {
              commands.push({ deviceId, command: "off" });
            } else if (state.switch === "on") {
              if (state.colorMode === "CT" && state.colorTemperature !== undefined) {
                commands.push({
                  deviceId,
                  command: "setColorTemperature",
                  arguments: [state.colorTemperature, state.level]
                });
              } else if (state.colorMode === "RGB" && state.hue !== undefined && state.saturation !== undefined) {
                commands.push({
                  deviceId,
                  command: "setColor",
                  arguments: [{
                    hue: state.hue,
                    saturation: state.saturation,
                    level: state.level
                  }]
                });
              }
            }
          }

          // cleanup after restore
          flowContext.set(key, undefined);

          // update node status
          const now = new Date();
          const formattedTime = now.toLocaleString();
          node.status({ fill: "green", shape: "dot", text: `restored ${state.name || deviceId} ${formattedTime}` });


            // execute each command directly (command.js logic inlined)
            for (const cmd of commands) {
              let deviceId = String(cmd.deviceId);
              let command = String(cmd.command);
              let commandArgs =
                cmd.arguments && cmd.arguments.length
                  ? JSON.stringify(
                      cmd.arguments.reduce((acc, cur) => {
                        if (typeof cur === "object" && !Array.isArray(cur)) {
                          return { ...acc, ...cur };
                        }
                        return acc;
                      }, {})
                    )
                  : "";

              let commandWithArgs = command;
              if (commandArgs) {
                commandWithArgs = `${command}/${encodeURIComponent(commandArgs)}`;
              }

              const baseUrl = `${node.hubitat.baseUrl}/devices/${deviceId}/${commandWithArgs}`;
              const url = `${baseUrl}?access_token=${node.hubitat.token}`;
              const options = { method: "GET" };

              try {
                await node.hubitat.acquireLock();
                const output = {
                  ...msg,
                  deviceId,
                  command,
                  requestArguments: commandArgs,
                };
                const response = await fetch(url, options);
                output.responseStatus = response.status;
                if (response.status >= 400) {
                  node.status({ fill: "red", shape: "ring", text: "response error" });
                  output.response = await response.text();
                  const message = `${baseUrl}: ${output.response}`;
                  send(output);
                  doneWithId(node, done, message);
                  return;
                }
                output.response = await response.json();
                send(output);
                if (done) done();
              } catch (err) {
                node.status({ fill: "red", shape: "ring", text: err.code });
                if (done) done(err);
              } finally {
                if (node.hubitat.delayCommands) {
                  setTimeout(() => {
                    node.hubitat.releaseLock();
                  }, node.hubitat.delayCommands);
                } else {
                  node.hubitat.releaseLock();
                }
              }
            }
          })
        );
     } catch (err) {
        node.error(`Error restoring devices: ${err.message}`, msg);
        if (done) done(err);
      }
    });

    node.on("close", function (removed, done) {
      try {
        if (removed) {
          const flowContext = node.context().flow;
          const cleanup = configuredDeviceList();
          if (Array.isArray(cleanup)) {
            cleanup.forEach(id => flowContext.set(`hubitat_device_state_${id}`, undefined));
          }
        }
        done();
      } catch (err) {
        node.error(`Error during close cleanup: ${err.message}`);
        done();
      }
    });
  }

  RED.nodes.registerType("hubitat restore", HubitatRestoreNode);
};
