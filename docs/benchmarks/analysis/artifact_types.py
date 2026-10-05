"""Typed schema and exact arithmetic for the Zodiac FX benchmark artifacts.

Shared by analyze_depth.py and build_timeline.py. Artifacts are JSON written by scripts/zodiac-dataplane-bench.ts
with 64-bit integers encoded as {"$bigint": "..."} (Council Invariant 2). This module:

- declares the artifact shapes as TypedDicts (only the fields the analysis reads),
- loads an artifact and fails loudly on a corrupt file (Council Invariant 1: never swallow errors),
- decodes the integer encoding, and
- does every derived number with integers or fractions.Fraction, so there is no floating-point arithmetic anywhere
  in the analysis; decimal strings are produced by integer rounding in fixed().
"""
import json
import sys
from fractions import Fraction
from typing import Dict, List, NotRequired, Optional, Tuple, TypedDict, Union, cast

BigInt = TypedDict('BigInt', {'$bigint': str})
Num = Union[int, BigInt]


class Metrics(TypedDict):
    switchPort1RxPps: Num
    switchPort2TxPps: Num
    iperfLossPpm: Optional[Num]


class Trial(TypedDict):
    metrics: Optional[Metrics]


class Step(TypedDict):
    depth: int
    offeredPps: Num
    trial: Trial
    sessionLost: bool
    stopped: Optional[str]
    echoRecoveryNs: Optional[Num]


class Sample(TypedDict):
    rules: int
    p1RxPps: Num


class SessionLoss(TypedDict):
    reconnectNs: Num
    reinstallNs: Num


class Window(TypedDict):
    index: int
    samples: List[Sample]
    sessionLosses: List[SessionLoss]
    flushToVerifiedNs: Optional[Num]


class BlackoutRecord(TypedDict):
    depth: int
    mode: str
    loaded: bool
    maxGapUs: Optional[Num]
    flushToVerifiedNs: Optional[Num]
    error: Optional[str]


class SessionEvent(TypedDict):
    event: str
    detail: Union[str, Num]


class LadderParams(TypedDict):
    layout: str
    udpPayloadBytes: int
    stepSeconds: int


class WorkdayParams(TypedDict):
    profile: str
    udpLoadPercent: int
    udpPps: Num
    targetRulesPerWindow: int
    windows: int
    tcpMbps: NotRequired[int]


class BlackoutParams(TypedDict):
    loadPps: NotRequired[int]


class Provenance(TypedDict):
    origin: str
    startedAtIso: str
    startedMonotonicNs: Num
    finishedMonotonicNs: Num
    command: NotRequired[str]


class LadderArtifact(TypedDict):
    provenance: Provenance
    params: LadderParams
    steps: List[Step]
    sessionEvents: NotRequired[List[SessionEvent]]


class WorkdayArtifact(TypedDict):
    provenance: Provenance
    params: WorkdayParams
    windows: List[Window]
    completedWindows: NotRequired[int]
    sessionEvents: NotRequired[List[SessionEvent]]


class BlackoutArtifact(TypedDict):
    provenance: Provenance
    params: BlackoutParams
    records: List[BlackoutRecord]
    sessionEvents: NotRequired[List[SessionEvent]]


class TrialsArtifact(TypedDict):
    """The sweep and the original three-depth run: only the trial count is read."""
    provenance: Provenance
    trials: List[Dict[str, object]]
    sessionEvents: NotRequired[List[SessionEvent]]


AnyArtifact = Union[LadderArtifact, WorkdayArtifact, BlackoutArtifact, TrialsArtifact]


class Incident(TypedDict):
    id: str
    category: str
    start: str
    end: str
    cause: str


class ExtraRun(TypedDict):
    name: str
    start: str
    end: str
    status: str
    note: str


class Spans(TypedDict):
    calendar_start: str
    calendar_end: str


class RunStatus(TypedDict):
    note: str
    runs: Dict[str, List[str]]
    incidents: List[Incident]
    extra_runs: List[ExtraRun]
    spans: Spans


def read_json(path: str) -> object:
    """Parse a JSON file; a corrupt file stops the run with the filename and the parse error."""
    try:
        with open(path, encoding='utf-8') as fh:
            data: object = json.load(fh)
    except ValueError as e:
        print(f'error: cannot parse {path}: {e}', file=sys.stderr)
        raise SystemExit(2)
    return data


def kind(art: AnyArtifact) -> str:
    """The command that produced an artifact; the original three-depth run predates the field."""
    return art['provenance'].get('command', 'dataplane')


def read_artifact(path: str) -> Optional[AnyArtifact]:
    """Load a benchmark artifact, or None if the file is valid JSON but not a physical-run artifact.

    This is the single place where untyped JSON is accepted as a typed artifact: the required provenance fields are
    checked here and the body is cast to the shape selected by the producing command.
    """
    raw = read_json(path)
    if not isinstance(raw, dict):
        return None
    prov = raw.get('provenance')
    if not isinstance(prov, dict) or prov.get('origin') != 'physical_bench_run':
        return None
    for key in ('startedAtIso', 'startedMonotonicNs', 'finishedMonotonicNs'):
        if key not in prov:
            print(f'error: {path}: provenance lacks {key}', file=sys.stderr)
            raise SystemExit(2)
    command = prov.get('command', 'dataplane')
    if command == 'ladder':
        return cast(LadderArtifact, raw)
    if command == 'workday':
        return cast(WorkdayArtifact, raw)
    if command == 'blackout':
        return cast(BlackoutArtifact, raw)
    return cast(TrialsArtifact, raw)


def read_run_status(path: str) -> RunStatus:
    raw = read_json(path)
    if not isinstance(raw, dict):
        print(f'error: {path} is not a JSON object', file=sys.stderr)
        raise SystemExit(2)
    return cast(RunStatus, raw)


def u(x: Num) -> int:
    """Decode the artifact's {"$bigint": "..."} integers; plain integers pass through."""
    if isinstance(x, dict):
        return int(x['$bigint'])
    return x


# ---- exact arithmetic ---------------------------------------------------------------------------

def median(xs: List[int]) -> Fraction:
    """Exact median of integers; an even count averages the middle pair."""
    s = sorted(xs)
    n = len(s)
    mid = n // 2
    return Fraction(s[mid]) if n % 2 else Fraction(s[mid - 1] + s[mid], 2)


def median_frac(xs: List[Fraction]) -> Fraction:
    s = sorted(xs)
    n = len(s)
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2


def fixed(x: Fraction, places: int) -> str:
    """Decimal string with `places` digits, rounded half-to-even by integer arithmetic."""
    scale = 10 ** places
    scaled = round(x * scale)
    sign = '-' if scaled < 0 else ''
    whole, frac = divmod(abs(scaled), scale)
    return f'{sign}{whole}.{frac:0{places}d}' if places else f'{sign}{whole}'


def least_squares(points: List[Tuple[Fraction, Fraction]]) -> Optional[Tuple[Fraction, Fraction]]:
    """Exact least-squares line y = a + b*x over (x, y) pairs of Fractions; None if under-determined."""
    n = len(points)
    if n < 2:
        return None
    mx = sum((x for x, _ in points), Fraction(0)) / n
    my = sum((y for _, y in points), Fraction(0)) / n
    den = sum(((x - mx) ** 2 for x, _ in points), Fraction(0))
    if den == 0:
        return None
    b = sum(((x - mx) * (y - my) for x, y in points), Fraction(0)) / den
    return my - b * mx, b
