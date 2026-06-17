.PHONY: install serve serve-gemma4-12b serve-qwen3.6-27b serve-qwen3.6-35b health presets install-service uninstall-service logs status restart

ROCKY := uv run rocky
PORT   ?= 7777
HOST   ?= 127.0.0.1

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

install-service:
	launchctl load ~/Library/LaunchAgents/dev.rocky.llm.plist

uninstall-service:
	launchctl unload ~/Library/LaunchAgents/dev.rocky.llm.plist

restart:
	launchctl unload ~/Library/LaunchAgents/dev.rocky.llm.plist
	sleep 2
	launchctl load ~/Library/LaunchAgents/dev.rocky.llm.plist

status:
	launchctl list dev.rocky.llm

logs:
	tail -f ~/.rocky/logs/rocky-llm.err.log
