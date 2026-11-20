#!/usr/bin/env python3
"""Alef's persistent Piper worker (spawned by server/features/piper.ts, never by hand).

Loads one Piper voice once (~0.5 s), then synthesizes each request in ~0.1 s instead of paying
the model load on every sentence. Protocol, one JSON object per line:
  stdin : {"id": "<id>", "text": "<sentence>", "out": "<absolute .wav path>"}
  stdout: {"id": "<id>", "ok": true, "ms": 93}  or  {"id": "<id>", "ok": false, "error": "..."}
The first stdout line is {"ready": true} once the voice is loaded.
"""

import json
import sys
import time
import wave


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] != "--model":
        print(json.dumps({"ready": False, "error": "usage: piper-worker.py --model <voice.onnx>"}), flush=True)
        return 2
    try:
        from piper import PiperVoice

        voice = PiperVoice.load(sys.argv[2])
    except Exception as err:  # noqa: BLE001 - report any load failure to the parent
        print(json.dumps({"ready": False, "error": str(err)[:300]}), flush=True)
        return 1
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = ""
        try:
            req = json.loads(line)
            req_id = str(req.get("id", ""))
            text = str(req["text"])
            out = str(req["out"])
            t0 = time.time()
            with wave.open(out, "wb") as wav:
                voice.synthesize_wav(text, wav)
            print(json.dumps({"id": req_id, "ok": True, "ms": round((time.time() - t0) * 1000)}), flush=True)
        except Exception as err:  # noqa: BLE001 - one bad request must not kill the worker
            print(json.dumps({"id": req_id, "ok": False, "error": str(err)[:300]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
