"""Tab View plugin — serves Guitar Pro files converted from Rocksmith arrangements."""

import sys
import tempfile
import shutil
from pathlib import Path
from fastapi import FastAPI
from fastapi.responses import Response

# Ensure Rocksmith lib is importable
_lib = str(Path(__file__).resolve().parent.parent.parent / "lib")
if _lib not in sys.path:
    sys.path.insert(0, _lib)

from song import load_song
from psarc import unpack_psarc
import sloppak as sloppak_mod


def setup(app: FastAPI, context: dict):
    get_dlc_dir = context["get_dlc_dir"]
    get_sloppak_cache_dir = context.get("get_sloppak_cache_dir")

    from rs2gp import rocksmith_to_gp5

    @app.get("/api/plugins/tabview/gp5/{filename:path}")
    def tabview_gp5(filename: str, arrangement: int = 0):
        dlc = get_dlc_dir()
        if not dlc:
            return Response("DLC folder not configured", status_code=500)

        source_path = Path(dlc) / filename
        if not source_path.exists():
            return Response("File not found", status_code=404)

        tmp = None
        try:
            if sloppak_mod.is_sloppak(source_path):
                if not get_sloppak_cache_dir:
                    return Response("Sloppak support unavailable", status_code=500)
                loaded = sloppak_mod.load_song(filename, Path(dlc), get_sloppak_cache_dir())
                song = loaded.song
            else:
                tmp = tempfile.mkdtemp(prefix="rs_tabview_")
                unpack_psarc(str(source_path), tmp)
                song = load_song(tmp)

            if not song.arrangements:
                return Response("No arrangements found", status_code=404)

            idx = max(0, min(arrangement, len(song.arrangements) - 1))
            gp5_bytes = rocksmith_to_gp5(song, idx)

            return Response(
                content=gp5_bytes,
                media_type="application/octet-stream",
                headers={"Content-Disposition": 'attachment; filename="tab.gp5"'},
            )
        except Exception as e:
            import traceback
            traceback.print_exc()
            return Response(f"Conversion error: {e}", status_code=500)
        finally:
            if tmp:
                shutil.rmtree(tmp, ignore_errors=True)
