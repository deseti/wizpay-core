// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IArcRegistry} from "./ArcRegistry.sol";

/**
 * @title INamespaceRegistrar
 * @notice ERC721 registrar interface for second-level names beneath a managed namespace.
 */
interface INamespaceRegistrar is IERC721 {
    event ControllerAdded(address indexed controller);
    event ControllerRemoved(address indexed controller);
    event NameRegistered(uint256 indexed id, address indexed owner, uint256 expires);
    event NameRenewed(uint256 indexed id, uint256 expires);

    function available(uint256 id) external view returns (bool isAvailable);
    function register(uint256 id, address owner, uint256 duration) external returns (uint256 expires);
    function renew(uint256 id, uint256 duration) external returns (uint256 expires);
    function reclaim(uint256 id, address owner) external;
    function nameExpires(uint256 id) external view returns (uint256 expires);
    function registry() external view returns (IArcRegistry registryContract);
    function baseNode() external view returns (bytes32 node);
}

/**
 * @title NamespaceRegistrar
 * @notice Sovereign ERC721 registrar for second-level names beneath one namespace.
 * @dev Trust boundary: after RootRegistry transfers ownership, the namespace owner may authorize extra controllers for this namespace only.
 */
contract NamespaceRegistrar is ERC721, Ownable, INamespaceRegistrar {
    uint256 public constant GRACE_PERIOD = 90 days;

    IArcRegistry public immutable registry;
    bytes32 public immutable baseNode;

    mapping(uint256 id => uint256 expiry) private _expiries;
    mapping(address controller => bool) public controllers;

    error NotController(address caller);
    error InvalidRegistrant(address owner);
    error InvalidDuration(uint256 duration);
    error NameUnavailable(uint256 id);
    error NameNotRenewable(uint256 id);

    constructor(
        IArcRegistry registry_,
        bytes32 baseNode_,
        string memory tokenName_,
        string memory tokenSymbol_,
        address initialOwner
    ) ERC721(tokenName_, tokenSymbol_) Ownable(initialOwner) {
        registry = registry_;
        baseNode = baseNode_;
    }

    modifier onlyController() {
        if (!controllers[msg.sender]) {
            revert NotController(msg.sender);
        }
        _;
    }

    function ownerOf(uint256 tokenId) public view override(ERC721, IERC721) returns (address ownerAddress) {
        if (_expiries[tokenId] <= block.timestamp) {
            revert ERC721NonexistentToken(tokenId);
        }

        return super.ownerOf(tokenId);
    }

    function addController(address controller) external onlyOwner {
        controllers[controller] = true;
        emit ControllerAdded(controller);
    }

    function removeController(address controller) external onlyOwner {
        controllers[controller] = false;
        emit ControllerRemoved(controller);
    }

    function setResolver(address resolver) external onlyOwner {
        registry.setResolver(baseNode, resolver);
    }

    function available(uint256 id) public view returns (bool isAvailable) {
        uint256 expiry = _expiries[id];
        return expiry == 0 || expiry + GRACE_PERIOD < block.timestamp;
    }

    function register(uint256 id, address ownerAddress, uint256 duration)
        external
        onlyController
        returns (uint256 expires)
    {
        return _register(id, ownerAddress, duration);
    }

    function renew(uint256 id, uint256 duration) external onlyController returns (uint256 expires) {
        if (duration == 0) {
            revert InvalidDuration(duration);
        }

        uint256 currentExpiry = _expiries[id];
        if (currentExpiry == 0 || currentExpiry + GRACE_PERIOD < block.timestamp) {
            revert NameNotRenewable(id);
        }

        expires = currentExpiry + duration;
        _expiries[id] = expires;

        emit NameRenewed(id, expires);
    }

    function reclaim(uint256 id, address ownerAddress) external {
        if (ownerAddress == address(0)) {
            revert InvalidRegistrant(address(0));
        }

        address currentOwner = ownerOf(id);
        if (!_isAuthorized(currentOwner, msg.sender, id)) {
            revert ERC721InsufficientApproval(msg.sender, id);
        }

        registry.setSubnodeOwner(baseNode, bytes32(id), ownerAddress);
    }

    function nameExpires(uint256 id) external view returns (uint256 expires) {
        return _expiries[id];
    }

    function isLive(uint256 id) external view returns (bool isActive) {
        return _expiries[id] > block.timestamp;
    }

    function _register(uint256 id, address ownerAddress, uint256 duration) internal returns (uint256 expires) {
        if (ownerAddress == address(0)) {
            revert InvalidRegistrant(address(0));
        }
        if (duration == 0) {
            revert InvalidDuration(duration);
        }
        if (!available(id)) {
            revert NameUnavailable(id);
        }

        if (_ownerOf(id) != address(0)) {
            _burn(id);
        }

        expires = block.timestamp + duration;
        _expiries[id] = expires;
        _mint(ownerAddress, id);

        emit NameRegistered(id, ownerAddress, expires);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        if (auth != address(0) && _expiries[tokenId] <= block.timestamp) {
            revert ERC721NonexistentToken(tokenId);
        }

        from = super._update(to, tokenId, auth);

        if (to != address(0)) {
            registry.setSubnodeOwner(baseNode, bytes32(tokenId), to);
        }
    }
}