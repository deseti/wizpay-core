.PHONY: build test deploy anvil format clean

build:
	forge build

test:
	forge test

deploy:
	forge script script/DeployWizPayMainnetV2.s.sol --rpc-url https://rpc.mainnet.arc.io --broadcast

anvil:
	anvil

format:
	forge fmt

clean:
	rm -rf out broadcast cache_forge
