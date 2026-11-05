"""Native dialog readiness is independent of successful window creation."""

import pytest

from scripts.windows_uninstall_checks import wait_for_controls


def test_waits_for_all_controls_without_accepting_partial_dialog(monkeypatch):
    monkeypatch.setattr("scripts.windows_uninstall_checks.time.sleep", lambda _: None)
    snapshots = iter([{"Cancel": 1}, {"Cancel": 1, "Settings": 2}])
    assert wait_for_controls(
        lambda: next(snapshots), ["Cancel", "Settings"], attempts=2
    ) == {"Cancel": 1, "Settings": 2}


def test_missing_controls_remain_a_failure(monkeypatch):
    monkeypatch.setattr("scripts.windows_uninstall_checks.time.sleep", lambda _: None)
    with pytest.raises(AssertionError, match="Missing granular removal option"):
        wait_for_controls(lambda: {"Cancel": 1}, ["Cancel", "Settings"], attempts=2)
