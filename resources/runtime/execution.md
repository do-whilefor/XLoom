# Efficient HTTP work in Execute

The `powershell` tool parses the supplied command before executing it in the same
PowerShell process. Invalid source has no command side effects. Valid source runs
once, with its original command-mode exit status, environment and working directory;
parsing and execution share one timeout. Invoked scripts still have their own errors.

## Automatic HTTP evidence

Execute can call the existing `powershell` tool with `http` instead of `command`:

```json
{"http":{"requests":[{"url":"http://127.0.0.1:8080/"},{"url":"http://127.0.0.1:8080/api","method":"POST","headers":{"Content-Type":"application/json"},"body":"{}"}]}}
```

These requests run in order inside Xloom, without starting a shell. Every response
is saved as a new JSON artifact with request headers/body, response headers/body,
timing and completion state. Returned `evidence` objects are ready for an Execute
submission; use their `ref` in facts. They are observations, not automatically
committed facts or verified findings. Original binary bodies are stored as base64.
The tool returns a 2000-byte body preview, SHA-256 and artifact path; request
`previewBytes` from 0 to 8000, or read the full artifact when needed.

There is no redirect following, cookie jar or retry. Supply identities explicitly.
HTTP errors such as 403 are complete responses. Transport errors, timeouts and
bodies exceeding 16 MiB produce incomplete evidence and stop the remaining batch.
Use `timeoutSeconds` per request (default 30) and optional tool `timeout` for the
whole batch. At most 16 requests are accepted; the entire input is validated before
network work. Evidence write failures stop execution after the affected request.
Inspect any uncertain side effects before manually retrying. Tunnels, protocol
upgrades, larger transfers and algorithmic loops can use command mode.

## Scripted HTTP loops

Use the bundled PowerShell helper for repeated HTTP requests. Dot-source its absolute `httpHelper` path once and create one client per script. Run the script once through `powershell`; keep the request loop inside that process. Python's in-process HTTP clients are also suitable when installed. Do not spawn curl/PowerShell for each request in a large loop.

```powershell
. 'ABSOLUTE_HTTP_HELPER_PATH'
$client = New-XloomHttpClient
try {
    $response = Invoke-XloomHttp -Client $client -Uri 'http://127.0.0.1:8080/' -EvidenceFile 'ABSOLUTE_CURRENT_ARTIFACTS/http.jsonl'
    $response.Status
    $response.Body
} finally { $client.Dispose() }
```

`-Method`, `-Headers`, `-Body` (byte array), and `-TimeoutSeconds` are explicit per-request inputs. The helper returns HTTP error responses too. It follows no redirects and shares no cookies: supply an explicit Cookie header for the identity being tested. There is no application retry loop. A timeout or transport error may follow a partial side effect; inspect state before any repeat. Dispose clients in `finally`.

With `-EvidenceFile`, each completed response is appended immediately as one JSONL record containing time, duration, supplied request fields, response headers, and body bytes in base64. This is an application-level record, not a packet capture: auto-generated transport headers are not recorded, and `Body` is only a UTF-8 convenience view. Use `BodyBase64` for exact bytes. Preserve identity/object/control comparisons and errors, not just the expected value. A failed evidence write throws after the request; it must not trigger an automatic replay.

Save scripts and incremental extraction results in this run's artifacts. Check prior recorded results before repeating requests. Resume only under verified matching endpoint, identity, request shape and state; old scripts/results do not establish current validity. Inspect any `reusableArtifacts` from completed prerequisite Steps, copy/adapt useful scripts into this run, and retain their source attribution. Never read prior private logs or transcripts.

Choose extraction bounds from observed data, retain partial values with their tested positions, and stop an individual extraction when its requested field is complete. Avoid re-reading complete tables just to obtain one missing field. Keep the assigned Step and task completion rules unchanged. When a long operation cannot return promptly, submit existing observations as a checkpoint between bounded batches; no timer, token count or helper result can declare task completion.
