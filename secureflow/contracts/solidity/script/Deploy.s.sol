// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/SecureFlow.sol";

contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        // Platform fee collector (using deployer for now) and 2.5% fee
        address feeCollector = vm.addr(deployerPrivateKey);
        uint256 platformFeeBP = 250;

        SecureFlow secureFlow = new SecureFlow(feeCollector, platformFeeBP);

        console.log("SecureFlow deployed to:", address(secureFlow));

        vm.stopBroadcast();
    }
}
