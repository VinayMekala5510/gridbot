// pm2 process definition used on the server: pm2 startOrReload ecosystem.config.cjs
module.exports = {
  apps: [{
    name: "gridbot",
    script: "node_modules/tsx/dist/cli.mjs",
    args: "server.ts",
    interpreter: "node",
    cwd: __dirname,
    env: { NODE_ENV: "production" },
    max_memory_restart: "450M",
    kill_timeout: 5000,
    time: true,
  }],
};
