// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/SecureFlow.sol";

contract WhitelistUSDCScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        // Hardcode the deployed contract address
        address payable secureFlowAddress = payable(0x6142bf4855D4F9dbC1cD8109377d4F4E2AF1ab59);
        
        vm.startBroadcast(deployerPrivateKey);

        SecureFlow secureFlow = SecureFlow(secureFlowAddress);
        
        // Arc Testnet USDC address (address(0) represents native USDC)
        address usdcAddress = 0x3600000000000000000000000000000000000000;
        
        // Whitelist USDC
        secureFlow.whitelistToken(usdcAddress);
        
        console.log("USDC whitelisted:", usdcAddress);

        vm.stopBroadcast();
    }
}
