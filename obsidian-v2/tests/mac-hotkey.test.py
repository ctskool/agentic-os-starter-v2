"""Fake Carbon and disposable protocol children; never registers a real shortcut."""
import ctypes
from collections import deque
import pathlib
import sys
import threading
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'runner'))
from macos_hotkey import CarbonHotkey, EventType, HOTKEY_ID, HotkeyID, PRESSED, RELEASED, carbon_key, parent_alive, run
from speech_runtime import HotkeyListener, MacHotkeyBackend, parse_hotkey


class HelperTests(unittest.TestCase):
    def carbon(self):
        backend = object.__new__(CarbonHotkey)
        backend.api, backend.reference, backend.handler = Mock(), ctypes.c_void_p(123), ctypes.c_void_p(456)
        backend.pending, backend.error, backend.callback = deque(), None, Mock()
        backend.events = (EventType * 2)()
        backend.api.InstallEventHandler.return_value = 0
        backend.api.SendEventToEventTarget.side_effect = lambda event, _: backend._handle_event(None, event, None)
        return backend

    def test_default_shortcut_and_unsafe_combinations(self):
        self.assertEqual(carbon_key(*parse_hotkey('ctrl+alt+j')), (4096 + 2048, 38))
        self.assertEqual(carbon_key(*parse_hotkey('win+shift+5')), (256 + 512, 23))
        for combo in ('j', 'alt+j', 'shift+j'):
            with self.assertRaisesRegex(ValueError, 'require Control or Command'):
                carbon_key(*parse_hotkey(combo))

    def test_press_edges_foreign_events_and_parent_exit(self):
        events = [(PRESSED, (0, 2)), (PRESSED, HOTKEY_ID), (PRESSED, HOTKEY_ID),
            (RELEASED, (0, 2)), (PRESSED, HOTKEY_ID), None,
            (RELEASED, HOTKEY_ID), (PRESSED, HOTKEY_ID)]
        backend, output = Mock(), []
        backend.next_event.side_effect = lambda: events.pop(0)
        run(0x4003, ord('J'), backend, lambda: bool(events), output.append)
        self.assertEqual(output, [{'type': 'ready'}, {'type': 'pressed'}, {'type': 'pressed'}])
        backend.unregister.assert_called_once()

    def test_registration_and_event_errors_release_registration(self):
        for stage in ('register', 'next_event'):
            backend = Mock()
            getattr(backend, stage).side_effect = RuntimeError('native failure')
            with self.assertRaisesRegex(RuntimeError, 'native failure'):
                run(0x4003, ord('J'), backend, lambda: True, lambda _: None)
            backend.unregister.assert_called_once()
        backend = Mock()
        with self.assertRaises(BrokenPipeError):
            run(0x4003, ord('J'), backend, lambda: True, Mock(side_effect=BrokenPipeError))
        backend.unregister.assert_called_once()

    def test_parent_pid_and_stdin_lease(self):
        source = Mock()
        with patch('macos_hotkey.os.getppid', return_value=42), \
                patch('macos_hotkey.select.select', return_value=([], [], [])) as select_call:
            self.assertTrue(parent_alive(42, source))
            self.assertFalse(parent_alive(41, source))
            self.assertFalse(parent_alive(1, source))
            select_call.assert_called_once()
        with patch('macos_hotkey.os.getppid', return_value=42), \
                patch('macos_hotkey.select.select', return_value=([source], [], [])), \
                patch('macos_hotkey.os.read', return_value=b''):
            self.assertFalse(parent_alive(42, source))

    def test_carbon_registers_exclusively_and_releases_pulled_events(self):
        backend = self.carbon()
        backend.api.RegisterEventHotKey.return_value = 0
        backend.register(*parse_hotkey('ctrl+alt+j'))
        arguments = backend.api.RegisterEventHotKey.call_args.args
        self.assertEqual(arguments[:2], (38, 6144))
        self.assertEqual(arguments[4], 1)  # Exclusive, so conflicts are visible.
        backend.api.ReceiveNextEvent.return_value = 0
        backend.api.GetEventParameter.return_value = -9870
        with self.assertRaisesRegex(RuntimeError, 'invalid'):
            backend.next_event()
        backend.api.ReleaseEvent.assert_called_once()
        backend.unregister()
        backend.unregister()
        backend.api.UnregisterEventHotKey.assert_called_once()
        backend.api.RemoveEventHandler.assert_called_once()

    def test_carbon_timeout_is_not_a_press_or_error(self):
        backend = self.carbon()
        backend.api.ReceiveNextEvent.return_value = -9875
        self.assertIsNone(backend.next_event())
        backend.api.ReleaseEvent.assert_not_called()

    def test_carbon_passes_native_event_identity_and_releases_event(self):
        backend = self.carbon()
        backend.api.ReceiveNextEvent.return_value = 0
        backend.api.GetEventKind.return_value = PRESSED
        def parameter(*arguments):
            identifier = ctypes.cast(arguments[-1], ctypes.POINTER(HotkeyID)).contents
            identifier.signature, identifier.id = HOTKEY_ID
            return 0
        backend.api.GetEventParameter.side_effect = parameter
        self.assertEqual(backend.next_event(), (PRESSED, HOTKEY_ID))
        backend.api.ReleaseEvent.assert_called_once()


class ProtocolTests(unittest.TestCase):
    def backend(self, script, **options):
        backend = MacHotkeyBackend(command=[sys.executable, '-u', '-c', script], **options)
        self.addCleanup(backend.unregister)
        return backend

    def test_ready_press_and_eof_shutdown(self):
        backend = self.backend("import sys; print('{\"type\":\"ready\"}'); print('{\"type\":\"pressed\"}'); sys.stdin.read()")
        backend.register(*parse_hotkey('ctrl+alt+j'))
        deadline = time.monotonic() + 1
        while not backend.fired():
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.01)
        self.assertFalse(backend.fired())
        backend.unregister()
        self.assertEqual(backend.process.poll(), 0)
        self.assertFalse(backend.reader.is_alive())

    def test_registration_failure_and_bad_protocol_leave_no_child(self):
        scripts = ["print('{\"type\":\"error\",\"error\":\"Already owned\"}')",
            "print('not json')", "print('{\"type\":\"pressed\"}')", "pass"]
        for script in scripts:
            backend = self.backend(script)
            with self.assertRaises(RuntimeError):
                backend.register(*parse_hotkey('ctrl+alt+j'))
            self.assertIsNotNone(backend.process.poll())
            self.assertFalse(backend.reader.is_alive())

    def test_registration_timeout_and_unresponsive_shutdown_are_bounded(self):
        backend = self.backend('import time; time.sleep(20)', startup_timeout=.05, stop_timeout=.1)
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, 'timed out'):
            backend.register(*parse_hotkey('ctrl+alt+j'))
        self.assertLess(time.monotonic() - started, 3)
        self.assertIsNotNone(backend.process.poll())
        self.assertFalse(backend.reader.is_alive())

    def test_helper_death_clears_listener_health(self):
        backend = self.backend("import sys; print('{\"type\":\"ready\"}'); sys.stdin.read()")
        listener = HotkeyListener(lambda _: self.fail('No key was pressed'), backend_factory=lambda: backend)
        self.addCleanup(listener.stop)
        listener.start()
        self.assertTrue(listener.ok)
        backend.process.terminate()
        listener._thread.join(2)
        self.assertFalse(listener.ok)
        self.assertIn('stopped', listener.error)
        self.assertFalse(backend.reader.is_alive())

    @unittest.skipIf(sys.platform == 'win32', 'Windows terminate is already an unconditional process exit')
    def test_unresponsive_helper_is_killed_after_ignoring_termination(self):
        backend = self.backend("import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "print('{\"type\":\"ready\"}'); time.sleep(20)", stop_timeout=.1)
        backend.register(*parse_hotkey('ctrl+alt+j'))
        backend.unregister()
        self.assertIsNotNone(backend.process.poll())
        self.assertFalse(backend.reader.is_alive())

    def test_late_registration_cannot_start_recording_after_stop(self):
        entered, finish = threading.Event(), threading.Event()
        backend = Mock()
        def register(*_):
            entered.set()
            finish.wait(1)
        backend.register.side_effect = register
        listener = HotkeyListener(lambda _: self.fail('Listener stopped'), backend_factory=lambda: backend)
        starter = threading.Thread(target=listener.start)
        starter.start()
        self.assertTrue(entered.wait(1))
        listener._stop.set()
        finish.set()
        starter.join(1)
        listener.stop()
        self.assertFalse(listener.ok)
        backend.fired.assert_not_called()
        backend.unregister.assert_called_once()


if __name__ == '__main__':
    unittest.main()
