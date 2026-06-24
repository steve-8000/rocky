.PHONY: install serve serve-gemma4-12b serve-qwen3.6-27b serve-qwen3.6-35b embed health presets install-service uninstall-service logs status restart

EMBED_PORT    ?= 7778
PORT          ?= 7777
HOST          ?= 127.0.0.1
RUNTIME_ROOT  ?= $(CURDIR)/.rocky
PLIST_DIR     ?= $(CURDIR)/launchd

ROCKY := uv run rocky

install:
	uv sync

serve: install
	$(ROCKY) serve --host $(HOST) --port $(PORT)

serve-gemma4-12b: install
	$(ROCKY) serve gemma4-12b --host $(HOST) --port $(PORT)

serve-qwen3.6-27b: install
	$(ROCKY) serve qwen3.6-27b --host $(HOST) --port $(PORT)

serve-qwen3.6-35b: install
	$(ROCKY) serve qwen3.6-35b --host $(HOST) --port $(PORT)

health:
	curl -sf http://$(HOST):$(PORT)/health | python3 -m json.tool

presets: install
	$(ROCKY) presets

embed: install
	$(ROCKY) embed qwen3-embed-4b --host $(HOST) --port $(EMBED_PORT)

install-service:
	mkdir -p $(RUNTIME_ROOT)/logs
	-launchctl unload $(PLIST_DIR)/dev.rocky.llm.plist
	-launchctl unload $(PLIST_DIR)/dev.rocky.embedding.plist
	launchctl load $(PLIST_DIR)/dev.rocky.llm.plist
	launchctl load $(PLIST_DIR)/dev.rocky.embedding.plist

uninstall-service:
	-launchctl unload $(PLIST_DIR)/dev.rocky.llm.plist
	-launchctl unload $(PLIST_DIR)/dev.rocky.embedding.plist

restart:
	mkdir -p $(RUNTIME_ROOT)/logs
	$(MAKE) uninstall-service
	sleep 2
	launchctl load $(PLIST_DIR)/dev.rocky.llm.plist
	launchctl load $(PLIST_DIR)/dev.rocky.embedding.plist

status:
	launchctl list dev.rocky.llm
	launchctl list dev.rocky.embedding

logs:
	tail -f $(RUNTIME_ROOT)/logs/rocky-llm.err.log $(RUNTIME_ROOT)/logs/rocky-embedding.err.log
