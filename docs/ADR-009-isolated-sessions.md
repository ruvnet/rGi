# ADR 009: Persistent process isolation for evaluation agents

Status: accepted for reviewed local plugins.

## Context

An agent loaded in the scorer process can inspect host memory, environment variables, and hidden answers. A promise timeout also cannot interrupt a synchronous infinite loop. Recreating a process for every prediction increases overhead and destroys the experience whose retention we want to measure.

## Decision

Each evaluation session owns one long lived Node child process. The parent copies only the worker and a single standalone ESM agent bundle into a private temporary directory. The bundle must be a regular file of at most 1 MiB. When an expected artifact digest is supplied, it must match the actual copied bytes before execution; mission evaluation always supplies this digest. Read access is limited to those two copied files through Node permissions. The child receives only three fixed environment variables and has no file write, subprocess, addon, or worker permissions. No shell is invoked.

The plugin exports `createAgent(mode)` and implements `learn`, `predict`, `snapshot`, and `restore`. JSONL requests carry monotonically increasing IDs. The parent allows one outstanding request, validates the reply shape and ID, and imposes a byte limit between 256 bytes and 1 MiB. Nonfinite numbers and lossy JSON values are rejected. Initialization and every request have a parent deadline; expiry sends `SIGKILL`, including when plugin JavaScript spins synchronously. Invalid replies, output floods and plugin failures also end the session. Closing waits for process exit and removes the temporary directory.

Learning and predictions reuse the process, amortizing launch cost. Restart experiments explicitly close it, create a fresh session, and optionally restore a serialized snapshot. A new child starts without prior JavaScript state. Results compare the same bundle and protocol with different permitted state handling.

## Boundary and limitations

This is file and process separation for reviewed plugins, not an operating system security sandbox. Node permissions in this deployment do not deny network access. They also do not establish hard memory, CPU quota or OS syscall limits. Native vulnerabilities, external services, network carried state and deliberate protocol forgery require stronger containment. Run hostile candidates in an OS sandbox with network disabled, resource quotas and a separate scorer identity before making adversarial isolation claims.

The [Node permission model documentation](https://nodejs.org/api/permissions.html) explicitly states that malicious code is outside its security guarantees. Our integration applies the restrictions to reviewed code and tests the specific denied operations rather than presenting these flags as hostile code containment.

The plugin receives its mode, so an adversarial plugin could deliberately behave differently by arm. Review the frozen bundle and keep evaluation logic outside the plugin. The parent exposes only explicit request payloads, never scorer files or inherited host secrets. Provenance hashes demonstrate which bytes were used; they do not prove the plugin is unbiased or the tasks were independently selected.

The runtime package must include `src/isolated-worker.mjs`. Plugins must bundle their dependencies because only that bundle and the worker are readable. Parent deadlines limit elapsed execution subject to OS scheduling, not the total amount of compute consumed before termination.

## Acceptance evidence

The tests execute actual child processes and verify state retention, clean restart, explicit restoration, denied scorer reads and writes, denied subprocess creation, stripped environment, synchronous loop termination, startup timeout, output limits, reply ID rejection, single outstanding request, and temporary directory removal. They validate the stated boundary without claiming network isolation or AGI capability.
