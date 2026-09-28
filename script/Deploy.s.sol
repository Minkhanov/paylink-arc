// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PayLink} from "../src/PayLink.sol";

/// @notice Deploys PayLink. The contract has no constructor arguments and no owner.
///         forge script script/Deploy.s.sol:Deploy --rpc-url arc --private-key $PRIVATE_KEY --broadcast
contract Deploy is Script {
    function run() external returns (PayLink payLink) {
        vm.startBroadcast();
        payLink = new PayLink();
        vm.stopBroadcast();
        console2.log("PayLink deployed at:", address(payLink));
        console2.log("Chain id:", block.chainid);
        console2.log("Deployment block:", block.number);
    }
}
