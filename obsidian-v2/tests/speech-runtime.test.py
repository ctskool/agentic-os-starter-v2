"""No models, microphone or OS hotkeys: fake capture and in-process ASGI only."""
import json
import os
import pathlib
import struct
import sys
import threading
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'runner'))
from speech_runtime import CaptureController, HotkeyListener, parse_hotkey
from speech import create_app, speech_chunks, streaming_wav_header


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
    def app(self, available=True, platform='win32', engines=(object(), object()), speech=None, words_file=None):
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
        return create_app('unused', engines=engines, capture_factory=Capture,
            hotkey_factory=Hotkey, platform=platform, speech=speech, words_file=words_file), captures, hotkeys

    # Member report: the service was fixed to English, and the English-only model wrote down
    # English-looking words for Portuguese, which were then answered as if they had been said.
    def test_language_setting_reaches_hearing_speaking_and_health(self):
        from fastapi.testclient import TestClient
        import numpy as np
        calls = []
        class Segment:
            text = ' Teste de voz '
        class Whisper:
            def transcribe(self, audio, language=None, vad_filter=False, initial_prompt=None):
                calls.append(('hear', language))
                return [Segment()], None
        class Kokoro:
            def create(self, text, voice=None, speed=1.0, lang=None):
                calls.append(('speak', voice, lang))
                return np.zeros(2400, dtype=np.float32), 24000
        portuguese = {'language': 'pt', 'model': 'small', 'voice': 'pf_dora', 'kokoro_lang': 'pt-br'}
        app, _, _ = self.app(engines=(Whisper(), Kokoro()), speech=portuguese)
        with TestClient(app) as client:
            self.assertEqual(client.get('/health').json()['language'], {'code': 'pt', 'wanted': 'pt', 'error': None})
            self.assertEqual(client.get('/speak', params={'text': 'Teste de voz'}).status_code, 200)
            self.assertEqual(client.post('/stt', content=b'0' * 2000).json(), {'text': 'Teste de voz'})
        self.assertEqual(calls, [('speak', 'pf_dora', 'pt-br'), ('hear', 'pt')])
        # No setting at all: English, exactly as before the setting existed.
        calls.clear()
        app, _, _ = self.app(engines=(Whisper(), Kokoro()))
        with TestClient(app) as client:
            self.assertEqual(client.get('/health').json()['language'], {'code': 'en', 'wanted': 'en', 'error': None})
            client.get('/speak', params={'text': 'Voice check'})
            client.post('/stt', content=b'0' * 2000)
        self.assertEqual(calls, [('speak', 'bm_george', 'en-gb'), ('hear', 'en')])

    # Members without a graphics card waited for the whole reply to be built before hearing a word.
    def test_stream_speaks_sentence_by_sentence_and_plain_speak_is_unchanged(self):
        from fastapi.testclient import TestClient
        import numpy as np
        spoken, paces = [], []
        class Kokoro:
            def create(self, text, voice=None, speed=1.0, lang=None):
                spoken.append(text)
                paces.append(speed)
                if text.startswith('Broken'):
                    raise RuntimeError('voice engine failed')
                return np.full(240, 0.5, dtype=np.float32), 24000
        reply = 'First sentence.  Second one is short. Third is also quite short, really.\nA fourth, long enough to stand by itself as its own piece of speech.'
        app, _, _ = self.app(engines=(object(), Kokoro()))
        with TestClient(app) as client:
            whole = client.get('/speak', params={'text': reply})
            self.assertEqual(whole.status_code, 200)
            self.assertEqual(spoken, [reply])  # one call, the text exactly as given
            self.assertEqual(whole.content[:4], b'RIFF')
            self.assertEqual(len(whole.content), 44 + 240 * 2)  # a complete file with a true length
            spoken.clear()
            streamed = client.get('/speak', params={'text': reply, 'stream': 1})
            self.assertEqual(streamed.status_code, 200)
            self.assertEqual(spoken, ['First sentence.',
                'Second one is short. Third is also quite short, really. A fourth, long enough to stand by itself as its own piece of speech.'])
            self.assertEqual(streamed.content[:44], streaming_wav_header(24000))
            breath = int(24000 * 0.12) * 2
            self.assertEqual(len(streamed.content), 44 + 2 * 240 * 2 + breath)
            sample = int(0.5 * 32767).to_bytes(2, 'little', signed=True)
            self.assertEqual(streamed.content[44:46], sample)
            self.assertEqual(streamed.content[44 + 480:44 + 480 + breath], bytes(breath))
            self.assertEqual(client.get('/speak', params={'text': ' ', 'stream': 1}).status_code, 400)
            # The chosen speed applies to every sentence, not only the first one.
            paces.clear()
            self.assertEqual(client.get('/speak', params={'text': reply, 'stream': 1, 'speed': 1.2}).status_code, 200)
            self.assertEqual(paces, [1.2, 1.2])
            paces.clear()
            client.get('/speak', params={'text': reply, 'stream': 1})
            self.assertEqual(paces, [1.0, 1.0])
        # A first sentence that cannot be spoken is an error response, not a silent empty stream.
        with TestClient(app, raise_server_exceptions=False) as client:
            self.assertEqual(client.get('/speak', params={'text': 'Broken first. Then more.', 'stream': 1}).status_code, 500)

    # Members asked to pick the voice; it was locked to one. A choice the service cannot speak falls back.
    def test_voice_and_speed_choices_fall_back_instead_of_failing(self):
        from fastapi.testclient import TestClient
        import numpy as np
        calls = []
        class Kokoro:
            def get_voices(self):
                return ['pf_dora', 'bm_lewis', 'af_heart', 'bm_george', 'ef_dora', 'notavoice']
            def create(self, text, voice=None, speed=1.0, lang=None):
                calls.append((voice, speed, lang))
                return np.zeros(240, dtype=np.float32), 24000
        app, _, _ = self.app(engines=(object(), Kokoro()))
        with TestClient(app) as client:
            self.assertEqual(client.get('/voices').json(), {'language': 'en', 'default': 'bm_george', 'voices': ['af_heart', 'bm_george', 'bm_lewis']})
            client.get('/speak', params={'text': 'Hi.'})
            client.get('/speak', params={'text': 'Hi.', 'voice': 'af_heart', 'speed': 1.2})
            client.get('/speak', params={'text': 'Hi.', 'voice': 'pf_dora', 'speed': 9})
            client.get('/speak', params={'text': 'Hi.', 'voice': 'bm_lewis', 'speed': 0.9, 'stream': 1})
        self.assertEqual(calls, [('bm_george', 1.0, 'en-gb'), ('af_heart', 1.2, 'en-us'), ('bm_george', 1.0, 'en-gb'), ('bm_lewis', 0.9, 'en-gb')])
        calls.clear()
        app, _, _ = self.app(engines=(object(), Kokoro()), speech={'language': 'pt', 'model': 'small', 'voice': 'pf_dora', 'kokoro_lang': 'pt-br'})
        with TestClient(app) as client:
            self.assertEqual(client.get('/voices').json()['voices'], ['pf_dora'])
            client.get('/speak', params={'text': 'Oi.', 'voice': 'af_heart'})
        self.assertEqual(calls, [('pf_dora', 1.0, 'pt-br')])
        # An engine that cannot list its voices offers none and still speaks in its default voice.
        class Plain:
            def create(self, text, voice=None, speed=1.0, lang=None):
                calls.append((voice, speed, lang))
                return np.zeros(240, dtype=np.float32), 24000
        calls.clear()
        app, _, _ = self.app(engines=(object(), Plain()))
        with TestClient(app) as client:
            self.assertEqual(client.get('/voices').json()['voices'], [])
            self.assertEqual(client.get('/speak', params={'text': 'Hi.', 'voice': 'af_heart'}).status_code, 200)
        self.assertEqual(calls, [('bm_george', 1.0, 'en-gb')])

    # One member's "Jev" kept arriving as "Jeff". The names in a vault are given to speech-to-text as a hint.
    def test_the_vaults_words_reach_speech_to_text_and_a_bad_file_is_ignored(self):
        from fastapi.testclient import TestClient
        import tempfile
        from speech import vocabulary_reader
        hints = []
        class Segment:
            text = 'Open the Jev plan'
        class Whisper:
            def transcribe(self, audio, language=None, vad_filter=False, initial_prompt=None):
                hints.append(initial_prompt)
                return [Segment()], None
        with tempfile.TemporaryDirectory() as folder:
            words = os.path.join(folder, 'voice-words.json')
            app, _, _ = self.app(engines=(Whisper(), object()), words_file=words)
            with TestClient(app) as client:
                client.post('/stt', content=b'0' * 2000)
                self.assertEqual(client.get('/health').json()['vocabulary'], {'words': 0})
                with open(words, 'w', encoding='utf-8') as handle:
                    json.dump({'prompt': 'Jev, Zettelkasten, Skool.', 'words': ['Jev', 'Zettelkasten', 'Skool']}, handle)
                client.post('/stt', content=b'0' * 2000)
                self.assertEqual(client.get('/health').json()['vocabulary'], {'words': 3})
                with open(words, 'w', encoding='utf-8') as handle:
                    handle.write('{"prompt": ')
                os.utime(words, (1, 1))
                client.post('/stt', content=b'0' * 2000)
            self.assertEqual(hints, [None, 'Jev, Zettelkasten, Skool.', None])
            # Not a string, empty, or far too long: no hint.
            read = vocabulary_reader(words)
            for index, bad in enumerate([{'prompt': 5}, {'prompt': ''}, {'prompt': 'x' * 2000}, []]):
                with open(words, 'w', encoding='utf-8') as handle:
                    json.dump(bad, handle)
                os.utime(words, (10 + index, 10 + index))
                self.assertIsNone(read())

    def test_speech_chunks(self):
        self.assertEqual(speech_chunks('One sentence only'), ['One sentence only'])
        self.assertEqual(speech_chunks('Hi. Ok. Yes.'), ['Hi.', 'Ok. Yes.'])
        self.assertEqual(speech_chunks('Really? Yes! It works… and then some more words to pass sixty characters in total. End.'),
            ['Really?', 'Yes! It works… and then some more words to pass sixty characters in total.', 'End.'])
        self.assertEqual(speech_chunks('Version 2.5 is out. Done.'), ['Version 2.5 is out.', 'Done.'])
        self.assertEqual(''.join(speech_chunks('A. B. C. D.')).replace(' ', ''), 'A.B.C.D.')

    def test_missing_language_model_falls_back_to_english_and_says_so(self):
        from fastapi.testclient import TestClient
        import speech as module
        loads = []
        def load(assets, model='small.en', language='en'):
            loads.append((model, language))
            if model != 'small.en':
                raise RuntimeError('model not downloaded')
            return object(), object()
        original, module.load_engines = module.load_engines, load
        try:
            app, _, _ = self.app(engines=None, speech={'language': 'pt', 'model': 'small', 'voice': 'pf_dora', 'kokoro_lang': 'pt-br'})
            with TestClient(app) as client:
                language = client.get('/health').json()['language']
            self.assertEqual(loads, [('small', 'pt'), ('small.en', 'en')])
            self.assertEqual((language['code'], language['wanted']), ('en', 'pt'))
            self.assertIn('setup --voice yes', language['error'])
            # English itself failing to load is a real fault and is never hidden.
            def broken(assets, model='small.en', language='en'):
                raise RuntimeError('no model at all')
            module.load_engines = broken
            with self.assertRaises(RuntimeError):
                self.app(engines=None)
        finally:
            module.load_engines = original

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
