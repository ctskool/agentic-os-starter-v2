"""No models, microphone or OS hotkeys: fake capture and in-process ASGI only."""
import pathlib
import struct
import sys
import threading
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'runner'))
from speech_runtime import CaptureController, HotkeyListener, parse_hotkey
from speech import create_app


class Stream:
    def __init__(self, levels):
        self.levels, self.reads, self.now, self.closed = iter(levels), 0, 0.0, False
    def __enter__(self):
        return self
    def __exit__(self, *_):
        self.closed = True
    def read(self, count):
        self.reads += 1
        self.now += .08
        return struct.pack(f'<{count}h', *([next(self.levels, 0)] * count)), False


class CaptureTests(unittest.TestCase):
    def test_speech_then_silence_and_capture_lock(self):
        stream, events, entered, release = Stream([0, 0, 0, 2000] + [0] * 30), [], threading.Event(), threading.Event()
        def transcribe(pcm):
            self.assertGreater(len(pcm), 1280 * 2)
            entered.set()
            release.wait(1)
            return 'Open daily note'
        capture = CaptureController(transcribe, events.append, lambda: stream, clock=lambda: stream.now)
        self.assertTrue(capture.trigger())
        self.assertTrue(entered.wait(1))
        self.assertFalse(capture.trigger())
        release.set()
        capture._thread.join(1)
        self.assertFalse(capture.busy)
        self.assertTrue(stream.closed)
        self.assertGreaterEqual(stream.reads, 24)
        self.assertEqual([e['type'] for e in events], ['wake', 'transcript'])
        self.assertEqual(events[-1]['text'], 'Open daily note')

    def test_no_speech_times_out_without_transcription(self):
        stream, events = Stream([0] * 100), []
        capture = CaptureController(lambda _: self.fail('No speech must not transcribe'), events.append,
            lambda: stream, clock=lambda: stream.now)
        capture.trigger('api')
        capture._thread.join(1)
        self.assertEqual([e['type'] for e in events], ['wake', 'wake_timeout'])
        self.assertTrue(stream.closed)

    def test_capture_failure_is_visible_and_releases_lock(self):
        events = []
        def unavailable():
            raise RuntimeError('fake device failure')
        capture = CaptureController(lambda _: '', events.append, unavailable)
        capture.trigger()
        capture._thread.join(1)
        self.assertEqual([e['type'] for e in events], ['wake', 'wake_error'])
        self.assertFalse(capture.busy)
        capture.stop()
        self.assertFalse(capture.trigger())


class HotkeyTests(unittest.TestCase):
    def test_parse_and_registration_cleanup_without_real_os_calls(self):
        self.assertEqual(parse_hotkey('ctrl+alt+j'), (0x4003, ord('J')))
        with self.assertRaises(ValueError):
            parse_hotkey('ctrl+a+b')
        calls, fired = [], threading.Event()
        class Backend:
            sent = False
            def register(self, mask, key): calls.append(('register', mask, key))
            def fired(self):
                if self.sent: return False
                self.sent = True
                return True
            def unregister(self): calls.append(('unregister',))
        listener = HotkeyListener(lambda source: fired.set(), backend_factory=Backend)
        listener.start()
        listener.start()
        self.assertTrue(listener.ok)
        self.assertTrue(fired.wait(1))
        listener.stop()
        self.assertFalse(listener.ok)
        self.assertEqual(calls, [('register', 0x4003, ord('J')), ('unregister',)])

    def test_disabled_or_conflicting_hotkey_is_not_reported_healthy(self):
        class Conflict:
            def register(self, *_): raise RuntimeError('Already owned by another app')
        listener = HotkeyListener(lambda _: None, backend_factory=Conflict)
        listener.start()
        self.assertFalse(listener.ok)
        self.assertIn('Already owned', listener.error)
        disabled = HotkeyListener(lambda _: None, combo='off', backend_factory=lambda: self.fail('Disabled'))
        disabled.start()
        self.assertFalse(disabled.enabled)
        self.assertFalse(disabled.ok)


class ServerTests(unittest.TestCase):
    def app(self, available=True, platform='win32'):
        captures, hotkeys = [], []
        class Capture:
            busy = False
            error = None if available else 'Microphone dependency unavailable'
            def __init__(self, transcribe, emit, **_):
                self.emit, self.available, self.stopped = emit, available, False
                captures.append(self)
            def trigger(self, source):
                self.emit({'type': 'wake', 'source': source})
                self.emit({'type': 'transcript', 'text': 'Open daily note'})
                return True
            def stop(self): self.stopped = True
        class Hotkey:
            ok, enabled, error = False, True, None
            def __init__(self, trigger, combo):
                self.trigger, self.starts = trigger, 0
                hotkeys.append(self)
            def start(self): self.starts += 1; self.ok = True
            def stop(self): self.ok = False
        return create_app('unused', engines=(object(), object()), capture_factory=Capture,
            hotkey_factory=Hotkey, platform=platform), captures, hotkeys

    def test_event_protocol_capabilities_and_shutdown(self):
        from fastapi.testclient import TestClient
        app, captures, hotkeys = self.app()
        self.assertEqual(hotkeys[0].starts, 0)
        with TestClient(app) as client:
            self.assertEqual(client.post('/listen').status_code, 409)
            health = client.get('/health').json()
            self.assertTrue(health['hotkey']['ok'])
            self.assertFalse(health['wake']['enabled'])
            with client.websocket_connect('/events') as ws:
                self.assertEqual(ws.receive_json()['type'], 'hello')
                self.assertEqual(client.get('/health').json()['events']['clients'], 1)
                self.assertEqual(client.post('/listen').json(), {'ok': True})
                self.assertEqual(ws.receive_json()['type'], 'wake')
                self.assertEqual(ws.receive_json(), {'type': 'transcript', 'text': 'Open daily note'})
            self.assertEqual(client.get('/health').json()['events']['clients'], 0)
        self.assertTrue(captures[0].stopped)
        self.assertFalse(hotkeys[0].ok)
        self.assertEqual(hotkeys[0].starts, 1)

    def test_unavailable_capture_and_cross_origin_clients_are_rejected(self):
        from fastapi.testclient import TestClient
        from starlette.websockets import WebSocketDisconnect
        app, _, hotkeys = self.app(available=False)
        with TestClient(app) as client:
            self.assertFalse(client.get('/health').json()['hotkey']['ok'])
            self.assertEqual(hotkeys[0].starts, 0)
            self.assertEqual(client.post('/listen').status_code, 503)
            self.assertEqual(client.post('/listen', headers={'origin': 'https://example.com'}).status_code, 403)
            with self.assertRaises(WebSocketDisconnect):
                with client.websocket_connect('/events', headers={'origin': 'https://example.com'}):
                    self.fail('Foreign web page connected')

    def test_mac_shortcut_and_api_request_surface_capture_without_python_microphone(self):
        from fastapi.testclient import TestClient
        app, captures, hotkeys = self.app(available=False, platform='darwin')
        self.assertEqual(captures, [])  # No Python capture dependency or device is opened.
        with TestClient(app) as client:
            health = client.get('/health').json()
            self.assertEqual(health['capture'], {'method': 'surface', 'available': None, 'busy': None, 'error': None})
            self.assertTrue(health['hotkey']['ok'])
            self.assertIsNone(health['hotkey']['error'])
            self.assertEqual(hotkeys[0].starts, 1)
            self.assertEqual(client.post('/listen').status_code, 409)
            self.assertFalse(hotkeys[0].trigger('hotkey'))
            with client.websocket_connect('/events') as ws:
                self.assertTrue(ws.receive_json()['hotkey'])
                self.assertTrue(hotkeys[0].trigger('hotkey'))
                self.assertEqual(ws.receive_json(), {'type': 'capture-request', 'source': 'hotkey'})
                self.assertEqual(client.post('/listen').json(), {'ok': True})
                self.assertEqual(ws.receive_json(), {'type': 'capture-request', 'source': 'api'})
                self.assertEqual(client.post('/listen', headers={'origin': 'https://example.com'}).status_code, 403)
        self.assertFalse(hotkeys[0].ok)
        self.assertEqual(captures, [])


if __name__ == '__main__':
    unittest.main()
