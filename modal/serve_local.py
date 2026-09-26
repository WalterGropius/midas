"""Run the MIDAS intel API without Modal (dev boxes, CPU hosts).

    pip install fastapi uvicorn "timesfm[torch]==3.0.2" laya==0.3.20
    MIDAS_MODAL_TOKEN=dev-token python modal/serve_local.py --port 8787
    # engine: MIDAS_MODAL_URL=http://127.0.0.1:8787 MIDAS_MODAL_TOKEN=dev-token

Same routes and contract as the Modal deployment. Models load in a background thread at
startup (requests wait for them; /health shows progress). Env MIDAS_INTEL_MODELS picks
which models to serve (default "timesfm,laya"); disabled ones answer 501.
"""

import argparse
import logging
import os
import sys
import threading

KNOWN_MODELS = ("timesfm", "laya")


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default=os.environ.get("MIDAS_INTEL_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("MIDAS_INTEL_PORT", "8787")))
    p.add_argument("--device", choices=("cpu", "cuda", "auto"), default=os.environ.get("MIDAS_INTEL_DEVICE", "cpu"))
    p.add_argument("--models", default=os.environ.get("MIDAS_INTEL_MODELS", ",".join(KNOWN_MODELS)))
    p.add_argument("--no-warm", action="store_true", help="load models on first request instead of at startup")
    p.add_argument("--insecure-no-auth", action="store_true", help="allow POSTs when MIDAS_MODAL_TOKEN is unset")
    args = p.parse_args(argv)

    models = {m.strip().lower() for m in args.models.split(",") if m.strip()}
    if unknown := models - set(KNOWN_MODELS):
        p.error(f"unknown models {sorted(unknown)}; choose from {list(KNOWN_MODELS)}")
    if not os.environ.get("MIDAS_MODAL_TOKEN") and not args.insecure_no_auth:
        p.error("set MIDAS_MODAL_TOKEN (bearer token for POST routes) or pass --insecure-no-auth")

    # Must happen before torch is imported: TimesFM 2.5 picks cuda:0 whenever it is visible.
    if args.device == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
        os.environ.setdefault("MIDAS_TIMESFM_BATCH", "4")  # TimesFM pads every call to this batch
    os.environ.setdefault("MIDAS_LAYA_DEVICE", args.device)
    os.environ.setdefault("MIDAS_TIMESFM_DEVICE", "" if args.device == "auto" else args.device)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import uvicorn

    import intel_app as ia

    tfm = ia.TimesFMRuntime() if "timesfm" in models else None
    laya = ia.LayaRuntime() if "laya" in models else None
    app = ia.create_app(
        ia.LocalForecaster(tfm) if tfm else None,
        ia.LocalDecider(laya) if laya else None,
        allow_no_auth=args.insecure_no_auth,
        deployment="local",
    )
    if not args.no_warm:
        runtimes = [r for r in (tfm, laya) if r is not None]
        threading.Thread(target=ia.warm, args=(runtimes,), name="warm", daemon=True).start()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
