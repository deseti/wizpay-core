.PHONY: build test deploy anvil format clean

build:
	forge build

test:
	forge test

deploy:
	forge script script/Deploy.s.sol:Deploy --rpc-url $$ARC_TESTNET_RPC_URL --broadcast

anvil:
	anvil

format:
	forge fmt

clean:
	rm -rf out broadcast cache_forge
