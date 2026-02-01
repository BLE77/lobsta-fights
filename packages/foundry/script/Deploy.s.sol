// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../contracts/UndergroundClawFights.sol";

/**
 * @title DeployUCF
 * @notice Deploy Underground Claw Fights to Base Mainnet
 * @dev Run: forge script script/Deploy.s.sol --rpc-url $BASE_MAINNET_RPC --broadcast --verify
 */
contract DeployUCF is Script {

    // Fee configuration
    uint256 constant AGENT_FEE_BPS = 500;      // 5%
    uint256 constant SPECTATOR_FEE_BPS = 300;  // 3%

    function run() external returns (UndergroundClawFights) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address treasury = vm.envAddress("TREASURY_ADDRESS");

        require(treasury != address(0), "Set TREASURY_ADDRESS in .env");

        vm.startBroadcast(deployerPrivateKey);

        UndergroundClawFights ucf = new UndergroundClawFights(
            AGENT_FEE_BPS,
            SPECTATOR_FEE_BPS,
            treasury
        );

        vm.stopBroadcast();

        console.log("=================================================");
        console.log("  UCF - UNDERGROUND CLAW FIGHTS DEPLOYED");
        console.log("=================================================");
        console.log("Contract Address: ", address(ucf));
        console.log("Treasury:         ", treasury);
        console.log("Agent Fee:        5% (500 bps)");
        console.log("Spectator Fee:    3% (300 bps)");
        console.log("=================================================");

        string memory deploymentInfo = string.concat(
            "UCF_CONTRACT=", vm.toString(address(ucf)), "\n",
            "TREASURY=", vm.toString(treasury), "\n",
            "AGENT_FEE_BPS=500\n",
            "SPECTATOR_FEE_BPS=300\n",
            "DEPLOYED_AT=", vm.toString(block.timestamp), "\n",
            "NETWORK=base-mainnet\n"
        );

        vm.writeFile(".deployment", deploymentInfo);

        return ucf;
    }
}

/**
 * @title DeployToSepolia
 * @notice Deploy to Base Sepolia testnet
 */
contract DeployToSepolia is Script {

    uint256 constant AGENT_FEE_BPS = 500;
    uint256 constant SPECTATOR_FEE_BPS = 300;

    function run() external returns (UndergroundClawFights) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address treasury = vm.envAddress("TREASURY_ADDRESS");

        require(treasury != address(0), "Set TREASURY_ADDRESS in .env");

        vm.startBroadcast(deployerPrivateKey);

        UndergroundClawFights ucf = new UndergroundClawFights(
            AGENT_FEE_BPS,
            SPECTATOR_FEE_BPS,
            treasury
        );

        vm.stopBroadcast();

        console.log("=================================================");
        console.log("  UCF DEPLOYED TO BASE SEPOLIA");
        console.log("=================================================");
        console.log("Contract Address: ", address(ucf));
        console.log("=================================================");

        return ucf;
    }
}
