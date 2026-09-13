# Overseer Audit & Idea Bounce Workflow
**Trigger:** `@overseer`, `overseer review`, `audit determinism`, or `/grill-me`

## Objective
Provide an interactive, Senior Staff (Google L7+ / Fellow track) dialectic session to evaluate an architectural design, PR diff, or networking concept against the tenets of Jeff Dean, Sanjay Ghemawat, and Demis Hassabis.

---

## Steps

### Step 1: Establish Problem Boundary
1. Ask:
   - What is the exact state transformation, packet contract, or telemetry metric?
   - What are the line rate, latency, and consistency targets?
2. Strip out all implementation assumptions—focus on data flows, state machines, and invariants.

### Step 2: Invariant & Determinism Audit
1. Inspect the critical state variables:
   - Are packet counters and bandwidth rates exact integers (`BigInt`) or susceptible to IEEE-754 drift?
   - Are routing rules, firewall evaluations, and DNS queries fail-closed (default DROP)?
   - Are timestamps monotonic (`hrtime`) across measurement intervals?
   - **Goodhart's Law / Epistemic Provenance**: Does telemetry originate from verified physical silicon/sockets, or is synthetic data masquerading as live state? Do disconnected states evaluate to 0 rates and null thermals?
2. Check for anti-patterns:
   - Are errors being swallowed (`catch (e) {}` on socket I/O)?
   - Are unbounded queues used for packet buffers without backpressure?
   - Are mock command outputs returned without clear `[SIMULATION / CLOUD TWIN SANDBOX]` disclaimers?

### Step 3: Back-of-the-Napkin Systems Analysis
1. Estimate:
   - Memory allocation per packet / flow entry.
   - Line rate processing budget: At 10 Gbps, 64-byte packets arrive every 51.2 nanoseconds. Can our code execute within that budget?
   - Timeout and retry convergence under link flapping.
2. Identify the single point of failure (SPOF) in the critical path.

### Step 4: Ghemawat Simplification Challenge
1. Ask:
   - Can we delete 30–50% of the proposed code?
   - Can a flat lookup table or bitmask replace a layered hierarchy of classes?
   - Does this abstraction pay for itself in clarity, or does it merely add indirection?

### Step 5: Verification Proof
1. Define the executable automated test that proves the invariant holds.
2. Execute `npm run check-types` and `npm run test` to verify no regressions exist.
3. Provide a clear, actionable synthesis with prioritized recommendations.
