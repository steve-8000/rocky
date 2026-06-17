# SPDX-License-Identifier: Apache-2.0
"""
Runtime log namespace rebrand: ``rocky.*`` -> ``rocky.*``.

The Python package directory is still ``rocky/`` (renaming would touch
every import in the repo and every external integration), but the product,
PyPI distribution, and CLI are all called ``rocky``. Without this shim,
``logging.getLogger(__name__)`` returns ``rocky.<submodule>`` and every
log line a user copies into a bug report or LLM reads as a stale, internal
name.

We use ``logging.setLogRecordFactory`` rather than a logger- or
handler-attached filter for three reasons:

1. **Logger filters don't propagate to children** -- a filter on the
   ``rocky`` logger would NOT see records emitted by ``rocky.scheduler``
   etc. (Python docs: "Filters added to a logger are not used by descendant
   loggers.")
2. **Handler filters are fragile** -- uvicorn, pytest's caplog, and any
   library that installs its own handler bypass a filter pinned to the root
   logger's basicConfig StreamHandler.
3. **Factory runs once per record at creation time** -- ``record.name`` is
   already ``rocky.<sub>`` when the factory runs, so we can rewrite it
   before any handler (stream, file, caplog) sees it. Third-party namespaces
   are left untouched because the prefix check filters them out.

This is install-once, idempotent, and removable in one line (revert the
``setLogRecordFactory`` call). No churn across the 70+ ``getLogger(__name__)``
sites in the codebase.
"""

from __future__ import annotations

import logging

_OLD_PREFIX = "rocky"
_NEW_PREFIX = "rocky"

# Sentinel so install_log_namespace_rebrand() can detect "I already wrapped
# the *currently active* factory". We deliberately store the wrapper
# callable on the logging module rather than a bare boolean: that way, if
# some other component (structlog, a test fixture, etc.) calls
# ``logging.setLogRecordFactory`` AFTER us, the next install_… call sees
# that the active factory is no longer our wrapper and re-wraps on top of
# the new one. A bare True/False sentinel would silently leave the new
# foreign factory un-rebranded -- which is exactly the "wrap, don't
# replace" promise the docstring makes.
_INSTALLED_SENTINEL = "_rocky_log_namespace_rebrand_installed_factory"


def _rewrite_name(name: str) -> str:
    """Map ``rocky[.*]`` -> ``rocky[.*]``; leave everything else alone.

    - Exact ``rocky`` becomes ``rocky``.
    - ``rocky.server`` becomes ``rocky.server``.
    - ``rockyfoo`` (no separator) is NOT rewritten -- defensive against any
      future logger naming collision with a different package.
    - Anything not starting with the prefix is returned as-is.
    """
    if name == _OLD_PREFIX:
        return _NEW_PREFIX
    if name.startswith(_OLD_PREFIX + "."):
        return _NEW_PREFIX + name[len(_OLD_PREFIX) :]
    return name


def install_log_namespace_rebrand() -> None:
    """Install a LogRecord factory that rebrands ``rocky.*`` -> ``rocky.*``.

    Safe to call multiple times. The idempotency check compares the *currently
    active* factory against the wrapper we last installed: if they match, do
    nothing; if they differ (because some other component swapped the factory
    after us), wrap the new factory so its records get rebranded too.

    Wraps any existing factory so other components (e.g. structlog,
    third-party libraries) that have set their own factory continue to work;
    their work runs first, then we rebrand on top.
    """
    current_factory = logging.getLogRecordFactory()
    if getattr(logging, _INSTALLED_SENTINEL, None) is current_factory:
        return

    previous_factory = current_factory

    def _factory(*args, **kwargs):
        record = previous_factory(*args, **kwargs)
        # ``logging.makeLogRecord(d)`` (used by socket / queue receivers that
        # reconstruct records from a wire-format dict) calls the factory with
        # ``name=None`` and patches ``record.__dict__`` afterwards. Touching
        # ``record.name.startswith(...)`` would AttributeError there. Guard
        # for any non-string ``name``, then short-circuit on the cheap prefix
        # check so we don't pay a function call per uvicorn / asyncio /
        # httpx record.
        name = record.name
        if isinstance(name, str) and name.startswith(_OLD_PREFIX):
            record.name = _rewrite_name(name)
        return record

    logging.setLogRecordFactory(_factory)
    setattr(logging, _INSTALLED_SENTINEL, _factory)
