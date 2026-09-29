"""The historical half of the Where NYC Walks pipeline.

This package publishes NYC DOT's **manual bi-annual pedestrian screenline
counts** (Socrata `cqsj-cfgu`, "Bi-Annual Pedestrian Counts"): 114 sites, two
or three surveys a year, since 2007.

It is NOT the automated 15-minute counter program (`ct66-47at` / `6up2-gnw8`).
A count from one program is never added to, compared with, or presented beside
as if it were a count from the other — they measure different things on
different schedules, and the disagreement between them is a fact about DOT's
budget rather than about pedestrian volume. The sensor half is a sibling
package; the only shared code is `scripts/walk/_common.py`.

Modules, in pipeline order:

    fetch      download the raw snapshot and its fetch metadata
    transform  raw rows -> historical-locations.geojson + historical-patterns.json
    validate   assert the published artifacts against the frozen contract

Standard library only. See requirements.txt.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

#: The shared walk contract this package builds on.
CONTRACT_PATH = Path(__file__).resolve().parent.parent / "_common.py"

#: Where a displaced `scripts/_common.py` is parked. See `bind_contract`.
EAT_CONTRACT_ALIAS = "_common_eat"


def bind_contract() -> object:
    """Make `import _common` inside this package resolve to the WALK contract.

    There are two modules named `_common` in this repository:
    `scripts/_common.py` for the eat pipeline and `scripts/walk/_common.py` for
    this one. Python keys `sys.modules` by bare name, not by path, so whichever
    is imported first wins for the entire process. `tests/python/conftest.py`
    imports the eat one at collection time, so a plain `import _common` in a
    walk module would silently receive the eat pipeline's contract — no
    `history_columns`, no `HISTORY_PROPERTY_*`, a different id recipe. The
    failure mode is the nasty one: it works right up until it quietly applies
    the wrong rules.

    So the package claims the name for its own contract, and parks whatever it
    displaced under `_common_eat` so nothing becomes unreachable. The eat
    modules keep working because they bind `_common` to their own `C` at import
    time; this only changes what a LATER `import _common` resolves to.

    NOTE for whoever owns the walk side of this: the collision is real and this
    is a mitigation, not a fix. The durable repair is for the walk contract to
    be importable under a name only it uses. The sibling sensor package needs
    the same treatment, and between them they should agree on the name.
    """
    existing = sys.modules.get("_common")
    if existing is not None:
        origin = getattr(existing, "__file__", None)
        if origin is not None and Path(origin).resolve() == CONTRACT_PATH:
            return existing
        sys.modules.setdefault(EAT_CONTRACT_ALIAS, existing)

    spec = importlib.util.spec_from_file_location("_common", CONTRACT_PATH)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise ImportError(f"cannot load the walk contract from {CONTRACT_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["_common"] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        # Never leave a half-executed contract in place for the next importer.
        sys.modules["_common"] = existing
        raise
    return module


bind_contract()
