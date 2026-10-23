"""
scripts/cic-ids2017-labels.py
==============================
Reconstructs per-packet labels for the CIC-IDS2017 public intrusion-detection benchmark from its released
CICFlowMeter CSVs ("GeneratedLabelledFlows.zip"), so raw packets streamed from the dataset's pcapng captures
(see scripts/cic-ids2017-adapter.py) can be joined against a benign/attack label.

Why this file exists and what it assumes
-----------------------------------------
The CSVs give a 5-tuple (source IP, destination IP, source port, destination port, protocol), a flow start
"Timestamp" and a "Flow Duration" (microseconds), and a "Label". Two things make the join non-trivial, and both
are measured here rather than assumed:

1. **The Timestamp column has no AM/PM marker and no seconds** (confirmed by sampling: every row matches
   `D/M/YYYY H:MM`, hour 1-12). CIC's own single-day files span more than 12 hours of wall clock (first packet to
   last packet of Wednesday's and Friday's raw captures, independently measured from the pcapng files themselves,
   span about 8 hours each but starting at different hours - the afternoon Heartbleed attack on Wednesday reads as
   literal "3:12" in the CSV, which is 15:12, in the very same file as a correctly-read-as-AM "10:00" DoS Slowloris
   row). `disambiguate_12h` resolves this by picking whichever of the AM/PM reading lands inside the capture's own
   observed [first-packet, last-packet] epoch window (with slack), which is unambiguous here because that window is
   under 12 hours wide. The caller must supply that window measured from the actual pcapng file, not a documented or
   assumed one.
2. **Minute resolution only.** With no seconds field, a flow's start time is only known to within a minute, so the
   match uses a slack window (default `DEFAULT_LABEL_SLACK_S`) added to the flow's [start, start+duration] interval
   before comparing to a packet's own (sub-second, pcap-derived) arrival time.

Timezone: **-3 (Atlantic Daylight Time), not -4 (US Eastern).** The first version of this file assumed US Eastern
(EDT, UTC-4), reasoning only that "CIC-IDS2017's documented capture site uses US Eastern time." That assumption was
wrong and is corrected here from direct measurement, not from re-reading documentation: picking one labelled flow
each from the Friday PortScan CSV and the Wednesday DoS Hulk CSV, searching the corresponding raw pcap for packets
matching that flow's *exact* 5-tuple regardless of timestamp, found real packets at that tuple on both days
consistently about one hour *earlier* than the CSV's disambiguated start time (-3598.2s and -3576.8s respectively,
both within the ±59s slop expected from the CSV's minute-only resolution of an exact -3600s/-1h). The ISCX lab is at
the University of New Brunswick in Fredericton - Atlantic Canada, not the US Eastern zone - and Atlantic Daylight
Time in July 2017 is UTC-3, one hour ahead of EDT. That matches the measured skew exactly, which is why `-3` is used
below; whether the true mechanism is literally "ADT" or some other one-hour misconfiguration in how CICFlowMeter's
host recorded its clock is not verified further than that, and does not change the correction.
"""
import csv
import re
from collections import namedtuple

# Measured, not documented (see the module docstring): two independent exact-5-tuple checks, one per day, each
# against a different attack type, both landed within a minute of -3600s/-1h of what -4 (EDT) would have predicted,
# and 0s of what -3 predicts. The adapter's coverage report is the ongoing check that this constant is right for a
# given file: the fraction of flows whose disambiguated time lands inside that file's own measured capture window,
# and - more importantly, since that check alone cannot rule out a wrong-by-exactly-one-hour constant - the overall
# label join rate jumping from under 2% (TZ_OFFSET_HOURS = -4) to the rate reported once this fix landed.
TZ_OFFSET_HOURS = -3

# Minute-only timestamp resolution plus independent pcap/flow-meter clocks: this is the slack added on each side of
# a flow's [start, start+duration] interval before a packet's arrival time is compared to it.
DEFAULT_LABEL_SLACK_S = 90.0

_TS_RE = re.compile(r'^(\d{1,2})/(\d{1,2})/(\d{4})\s+(\d{1,2}):(\d{2})$')

FlowLabel = namedtuple(
    'FlowLabel',
    ['src_ip', 'dst_ip', 'sport', 'dport', 'protocol', 'start_epoch', 'end_epoch', 'label', 'source_file', 'row'],
)


def _epoch_utc(year, month, day, hour, minute, tz_offset_hours):
    """Epoch seconds for a naive local (year, month, day, hour, minute) at UTC offset tz_offset_hours (e.g. -4 for
    EDT), using calendar.timegm so the host's own local timezone never enters the calculation (Invariant-adjacent:
    no implicit environment-dependent state)."""
    import calendar
    return calendar.timegm((year, month, day, hour, minute, 0, 0, 0, 0)) - tz_offset_hours * 3600.0


def disambiguate_12h(day, month, year, hour12, minute, window_start_epoch, window_end_epoch,
                      tz_offset_hours=TZ_OFFSET_HOURS, slack_s=DEFAULT_LABEL_SLACK_S):
    """Resolve a CICFlowMeter timestamp's missing AM/PM marker.

    hour12 is 1-12 as literally printed. Build the AM reading (hour12 mod 12) and the PM reading (that + 12, mod 24),
    convert each to an epoch, and return whichever lands inside [window_start_epoch - slack_s, window_end_epoch +
    slack_s] - the capture's own measured span, not a documented one. Returns (epoch, reason):
      reason == 'ok'              exactly one reading fit; epoch is that reading.
      reason == 'ambiguous_both'  both readings fit (only possible if the window is >= 12h wide); epoch is the AM
                                   reading, arbitrarily, and the caller should treat this flow as unreliable.
      reason == 'neither_fits'    neither reading fit the window; epoch is None.
    """
    am_hour = hour12 % 12
    pm_hour = am_hour + 12
    am_epoch = _epoch_utc(year, month, day, am_hour, minute, tz_offset_hours)
    pm_epoch = _epoch_utc(year, month, day, pm_hour, minute, tz_offset_hours)
    lo, hi = window_start_epoch - slack_s, window_end_epoch + slack_s
    am_fits = lo <= am_epoch <= hi
    pm_fits = lo <= pm_epoch <= hi
    if am_fits and pm_fits:
        return am_epoch, 'ambiguous_both'
    if am_fits:
        return am_epoch, 'ok'
    if pm_fits:
        return pm_epoch, 'ok'
    return None, 'neither_fits'


def parse_timestamp(raw, window_start_epoch, window_end_epoch, tz_offset_hours=TZ_OFFSET_HOURS,
                     slack_s=DEFAULT_LABEL_SLACK_S):
    """raw like '5/7/2017 8:42' (day/month/year hour:minute, hour 1-12, no AM/PM). Returns (epoch, reason); reason is
    'parse_error' if raw does not match the expected shape at all."""
    m = _TS_RE.match(raw.strip())
    if not m:
        return None, 'parse_error'
    day, month, year, hour12, minute = (int(x) for x in m.groups())
    return disambiguate_12h(day, month, year, hour12, minute, window_start_epoch, window_end_epoch,
                             tz_offset_hours, slack_s)


# Columns used; a legacy (ML-ready, e.g. "MachineLearningCSV.zip") export that strips Flow ID/IP/port/timestamp
# columns cannot be used here at all - this is why the adapter is documented to require GeneratedLabelledFlows.zip.
REQUIRED_COLUMNS = ('Source IP', 'Destination IP', 'Source Port', 'Destination Port', 'Protocol', 'Timestamp',
                    'Flow Duration', 'Label')


def load_flow_csv(path, window_start_epoch, window_end_epoch, tz_offset_hours=TZ_OFFSET_HOURS,
                   slack_s=DEFAULT_LABEL_SLACK_S, encoding='latin1'):
    """Parses one CICFlowMeter CSV into (flows, stats). flows is a list of FlowLabel. stats counts what happened to
    every row, so a caller can report join/parse quality honestly instead of assuming a clean parse:
      rows, parsed_ok, ambiguous_both, neither_fits, parse_error, missing_columns
    A row that fails to disambiguate (ambiguous_both / neither_fits / parse_error) is left out of flows, not guessed
    at - better a lower-coverage join than a wrong one."""
    stats = {'rows': 0, 'parsed_ok': 0, 'ambiguous_both': 0, 'neither_fits': 0, 'parse_error': 0,
              'missing_columns': 0}
    flows = []
    with open(path, encoding=encoding, newline='') as fh:
        reader = csv.reader(fh)
        header = [h.strip() for h in next(reader)]
        idx = {h: i for i, h in enumerate(header)}
        missing = [c for c in REQUIRED_COLUMNS if c not in idx]
        if missing:
            raise ValueError(f'{path}: missing required column(s) {missing} - is this GeneratedLabelledFlows.zip?')
        for row_i, row in enumerate(reader):
            if not row:
                continue
            stats['rows'] += 1
            if len(row) <= max(idx.values()):
                stats['missing_columns'] += 1
                continue
            epoch, reason = parse_timestamp(row[idx['Timestamp']], window_start_epoch, window_end_epoch,
                                             tz_offset_hours, slack_s)
            stats[reason if reason != 'ok' else 'parsed_ok'] += 1
            if epoch is None or reason != 'ok':
                continue
            try:
                duration_us = float(row[idx['Flow Duration']])
                sport = int(row[idx['Source Port']])
                dport = int(row[idx['Destination Port']])
                protocol = int(row[idx['Protocol']])
            except ValueError:
                stats['parse_error'] += 1
                stats['parsed_ok'] -= 1
                continue
            flows.append(FlowLabel(
                src_ip=row[idx['Source IP']], dst_ip=row[idx['Destination IP']], sport=sport, dport=dport,
                protocol=protocol, start_epoch=epoch, end_epoch=epoch + duration_us / 1_000_000.0,
                label=row[idx['Label']].strip(), source_file=path, row=row_i,
            ))
    return flows, stats


class FlowIndex:
    """Looks up a packet's label by 5-tuple + arrival time. Indexes both the flow's own direction and its reverse
    (a packet can arrive from either endpoint of a bidirectional flow), each keyed by (ip, ip, port, port,
    protocol)."""

    def __init__(self, flows, slack_s=DEFAULT_LABEL_SLACK_S):
        self.slack_s = slack_s
        self._index = {}
        for f in flows:
            self._index.setdefault((f.src_ip, f.dst_ip, f.sport, f.dport, f.protocol), []).append(f)
            self._index.setdefault((f.dst_ip, f.src_ip, f.dport, f.sport, f.protocol), []).append(f)

    def __len__(self):
        return sum(len(v) for v in self._index.values()) // 2  # each flow indexed twice (fwd + rev)

    def lookup(self, src_ip, dst_ip, sport, dport, protocol, t_epoch):
        """Returns the Label string of the first flow in the bucket whose [start-slack, end+slack] contains
        t_epoch, or None. Candidates are usually 0 or 1 per 5-tuple within a single capture; if more than one
        matches (a 5-tuple reused close in time), the first by file order wins - ties are rare and not resolved by
        packet count alone here."""
        candidates = self._index.get((src_ip, dst_ip, sport, dport, protocol))
        if not candidates:
            return None
        lo_slack = self.slack_s
        for f in candidates:
            if f.start_epoch - lo_slack <= t_epoch <= f.end_epoch + lo_slack:
                return f.label
        return None
