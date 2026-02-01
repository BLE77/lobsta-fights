// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../contracts/LobstaFights.sol";

/**
 * @title DeployLobstaFights
 * @notice Deployment script for Lobsta Fights Association
 * @dev Run: forge script script/DeployLobstaFights.s.sol --rpc-url $BASE_SEPOLIA_RPC --broadcast
 */
contract DeployLobstaFights is Script {
    
    // Configuration
    uint256 constant AGENT_FEE_BPS = 500;      // 5%
    uint256 constant SPECTATOR_FEE_BPS = 300;  // 3%
    
    function run() external {
        // Load private key from env
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        
        require(treasury != address(0), "Set TREASURY_ADDRESS in .env");
        
        vm.startBroadcast(deployerPrivateKey);
        
        // Deploy main contract
        LobstaFights lobstaFights = new LobstaFights(
            AGENT_FEE_BPS,
            SPECTATOR_FEE_BPS,
            treasury
        );
        
        vm.stopBroadcast();
        
        // Log deployment
        console.log("=== Lobsta Fights Association Deployed ===");
        console.log("Contract: ", address(lobstaFights));
        console.log("Treasury: ", treasury);
        console.log("Agent Fee: ", AGENT_FEE_BPS, "bps (5%)");
        console.log("Spectator Fee: ", SPECTATOR_FEE_BPS, "bps (3%)");
        console.log("==========================================");
        
        // Write deployment info to file
        string memory deploymentInfo = string.concat(
            "LOBSTA_FIGHTS_CONTRACT=", vm.toString(address(lobstaFights)), "\n",
            "TREASURY=", vm.toString(treasury), "\n",
            "AGENT_FEE_BPS=", vm.toString(AGENT_FEE_BPS), "\n",
            "SPECTATOR_FEE_BPS=", vm.toString(SPECTATOR_FEE_BPS), "\n",
            "DEPLOYED_AT=", vm.toString(block.timestamp), "\n"
        );
        
        vm.writeFile(".deployment", deploymentInfo);
    }
}

/**
 * @title DeployAndTest
 * @notice Deploy + create a test match
 */
contract DeployAndTest is Script {
    
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address playerA = vm.envAddress("TEST_PLAYER_A");
        address playerB = vm.envAddress("TEST_PLAYER_B");
        
        vm.startBroadcast(deployerPrivateKey);
        
        // Deploy
        LobstaFights lfc = new LobstaFights(500, 300, msg.sender);
        
        // Create profiles for test players
        lfc.createProfile("Red chrome lobster with golden gloves, flame shorts");
        
        // Create a private match
        bytes32 inviteCode = keccak256(abi.encodePacked("test-match-1"));
        uint256 matchId = lfc.createPrivateMatch{value: 0.01 ether}(inviteCode);
        
        vm.stopBroadcast();
        
        console.log("Deployed:", address(lfc));
        console.log("Test Match:", matchId);
    }
}