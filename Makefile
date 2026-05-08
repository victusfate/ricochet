DATA_DIR      := data
ML100K_DIR    := $(DATA_DIR)/ml-100k
ML100K_ZIP    := $(DATA_DIR)/ml-100k.zip
ML100K_DATA   := $(ML100K_DIR)/u.data
ML100K_URL    := https://files.grouplens.org/datasets/movielens/ml-100k.zip
NODE_MODULES  := node_modules/.package-lock.json

.PHONY: install build test data clean-data eval help

## Install Node dependencies
install: $(NODE_MODULES)

$(NODE_MODULES):
	npm install

## Build library output to dist/
build: $(NODE_MODULES)
	npm run build

## Run unit and integration tests
test: $(NODE_MODULES)
	npm test

## Download and extract MovieLens 100K into data/ml-100k/
data: $(ML100K_DATA)

$(ML100K_DATA): $(ML100K_ZIP)
	unzip -o $(ML100K_ZIP) -d $(DATA_DIR)
	@echo "MovieLens 100K ready at $(ML100K_DIR)/"

$(ML100K_ZIP):
	mkdir -p $(DATA_DIR)
	curl -L --fail --progress-bar -o $(ML100K_ZIP) $(ML100K_URL)

## Run offline BiasedMF evaluation (downloads data first if needed)
eval: $(NODE_MODULES) $(ML100K_DATA)
	npm run eval:movielens

## Remove downloaded dataset (keeps synthetic cache)
clean-data:
	rm -rf $(ML100K_DIR) $(ML100K_ZIP)

## Show available targets
help:
	@grep -E '^##' Makefile | sed 's/## //'
