// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/Atelier.sol";
import "../src/yield/AtelierYield.sol";
import "../src/yield/SponsoredVault.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * Wire up productive escrow on Arc TESTNET, end to end, in one transaction batch.
 *
 *   PROXY_ADDRESS=0x… YIELD_TOKEN=0x… SPONSOR_AMOUNT=25000000 \
 *     forge script script/DeployYieldTestnet.s.sol --rpc-url arc_testnet --broadcast
 *
 * WHY THIS IS SEPARATE FROM DeployYield.s.sol
 *
 * That script deliberately configures no venue, because pointing an escrow at a
 * yield venue is a decision about somebody else's capital and should not be a
 * side effect of a deploy. This one makes that decision explicitly, for testnet,
 * and the venue it picks is {SponsoredVault} — which earns nothing and says so.
 *
 * Mainnet uses {UniswapV4StableAdapter} against a real pool, and must not use
 * this script. The guard below refuses to run anywhere but Arc testnet, because
 * the failure mode of getting that wrong is real money in a venue that returns
 * only what somebody chose to gift it.
 */
contract DeployYieldTestnetScript is Script {
    uint256 internal constant ARC_TESTNET = 5042002;

    function run() external {
        require(block.chainid == ARC_TESTNET, "SponsoredVault is testnet-only");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address payable proxy = payable(vm.envAddress("PROXY_ADDRESS"));
        address token = vm.envAddress("YIELD_TOKEN");
        uint256 sponsorAmount = vm.envOr("SPONSOR_AMOUNT", uint256(0));

        vm.startBroadcast(pk);

        AtelierYield controller = new AtelierYield(proxy);
        Atelier(proxy).setYieldController(address(controller));

        SponsoredVault venue = new SponsoredVault(token, address(controller));
        controller.setYieldAdapter(token, address(venue));

        /*
         * Seed the return. Without this the venue gives back exactly what it
         * was given, every job earns zero, and the split has nothing to split.
         *
         * Optional, and left out of the first run on purpose: Arc's USDC calls
         * a blocklist precompile at 0x18…01 on every transfer, and forge cannot
         * execute that locally — the simulation halts with StackUnderflow long
         * before it reaches anything of ours. So the deploy and the wiring,
         * which do simulate, go first; sponsor separately once the addresses
         * are real. Leave SPONSOR_AMOUNT unset to skip it.
         */
        if (sponsorAmount > 0) {
            if (token == address(0)) {
                venue.sponsor{value: sponsorAmount}(sponsorAmount);
            } else {
                IERC20(token).approve(address(venue), sponsorAmount);
                venue.sponsor(sponsorAmount);
            }
        }

        vm.stopBroadcast();

        console.log("AtelierYield:     ", address(controller));
        console.log("SponsoredVault:   ", address(venue));
        console.log("attached to:      ", proxy);
        console.log("token:            ", token);
        console.log("freelancer share: ", controller.freelancerShareBP());
        console.log("sponsored:        ", sponsorAmount);
        console.log("venue holds:      ", venue.totalAssets());
    }
}
