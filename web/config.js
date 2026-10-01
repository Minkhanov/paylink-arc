// PayLink front-end configuration.
// After deploying the contract, paste its address into `payLink` for the matching network.
// The page picks the network from the invoice link (`c=` parameter), then from `?chain=` in the
// page URL, then falls back to `defaultChainId`.
window.PAYLINK_CONFIG = {
  defaultChainId: 5042,
  repoUrl: "https://github.com/Minkhanov/paylink-arc",
  networks: {
    5042: {
      name: "Arc",
      rpc: "https://rpc.mainnet.arc.io",
      explorer: "https://explorer.arc.io",
      payLink: "0x29d6C718405f7bd61156C4C184f2A6080f0275de", // Arc mainnet, block 23738412
    },
    5042002: {
      name: "Arc Testnet",
      rpc: "https://rpc.testnet.arc.io",
      explorer: "https://explorer.testnet.arc.io",
      payLink: "0x0000000000000000000000000000000000000000", // optional: testnet address
    },
    31337: {
      name: "Local Anvil",
      rpc: "http://127.0.0.1:8545",
      explorer: "",
      // First contract deployed by anvil's default account #0 always lands here.
      payLink: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    },
  },
};
