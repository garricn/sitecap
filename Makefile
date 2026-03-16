.PHONY: help setup lint test check clean generate

help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

setup: ## Install deps + pre-commit hooks
	npm install
	pre-commit install

lint: ## Lint code with eslint
	npx eslint .

test: ## Run tests
	npm test

generate: ## Generate API surfaces from operation schemas
	npm run generate

check: generate lint test ## Run all checks (generate, lint, test)

clean: ## Clean build artifacts and caches
	rm -rf node_modules/ output/
