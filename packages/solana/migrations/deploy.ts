// Migrations are an early feature. Currently, they're nothing more than this
// temporary script that deploys the ICHOR token program.

const anchor = require("@coral-xyz/anchor");

module.exports = async function (provider) {
  // Configure client to use the provider.
  anchor.setProvider(provider);

  // Deploy the ichor_token program.
  // Program deployment is handled by `anchor deploy`.
};
