// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/Atelier.sol";

/**
 * Whitelist USDC on a deployment.
 *
 *   SECUREFLOW_ADDRESS=<PROXY> forge script script/WhitelistUSDC.s.sol \
 *     --rpc-url arc_testnet --broadcast
 *
 * Without this, createEscrow reverts with TokenNotWhitelisted for every job —
 * so it is the difference between a deployed contract and a usable one.
 *
 * The address used to be hardcoded to the pre-ETHOnline deployment, which meant
 * running this after a redeploy quietly configured the OLD contract and left the
 * new one unusable, with a successful-looking transaction to prove it. It reads
 * the target from the environment now.
 */
contract WhitelistUSDCScript is Script {
    // Circle USDC on Arc. Note the contract treats address(0) as native USDC and
    // always accepts it; this is the ERC20 the frontend actually points at.
    address constant USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address payable atelierAddress = payable(vm.envAddress("SECUREFLOW_ADDRESS"));

        vm.startBroadcast(deployerPrivateKey);
        Atelier(atelierAddress).whitelistToken(USDC);
        vm.stopBroadcast();

        console.log("contract:", atelierAddress);
        console.log("USDC whitelisted:", USDC);
    }
}
