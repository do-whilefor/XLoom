# Efficient HTTP work in Execute

## Repairing a rejected submission

All research roles can repair the last rejected `submit` proposal in the current
run without rewriting it. Use `repair:[{"path":"/steps/0/from","value":[]}]`
to set a field, or `repair:[{"path":"/conclusion","remove":true}]` to omit an
invalid optional field. Choose `value` or `remove:true` for each JSON Pointer.
Removal requires an existing target; removing an array entry shifts later indices.
Repairs run in order on a copy. An invalid path applies none of the batch. A valid
batch is fully revalidated and, if rejected, becomes the next repair candidate.
Removing a required field still fails validation. Nothing commits until acceptance.

## PowerShell process

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
`previewBytes` from 0 to 8000, or read the full artifact when needed. Text previews
end at a complete UTF-8 character and have `bodyEncoding: "utf8"`. Binary previews
use `bodyEncoding: "base64"`; the byte budget applies before base64 encoding.
`bodyBytes` and `truncated` describe the original body, whose archive is unchanged.

There is no redirect following, cookie jar or retry. Supply identities explicitly.
HTTP errors such as 403 are complete responses. Transport errors, timeouts and
bodies exceeding 16 MiB produce incomplete evidence and stop the remaining batch.
Use `timeoutSeconds` per request (default 30) and optional tool `timeout` for the
whole batch. At most 16 requests are accepted; the entire input is validated before
network work. Evidence write failures stop execution after the affected request.
Inspect any uncertain side effects before manually retrying. Tunnels, protocol
upgrades, larger transfers and algorithmic loops can use command mode.

Bundle requests whose inputs are already known into one call. For independent,
body-free GET/HEAD probes, set `independent: true` and `concurrency` from 2 to 4
inside `http`. Every other batch remains sequential; concurrent POST requests,
request bodies or missing independence declarations are rejected before I/O.
Receipts retain request order even when responses finish in a different order.
On failure no queued requests start; in-flight reads finish and retain their
evidence. A GET method alone cannot prove the target has no side effects: declare
independence only after checking the operation's meaning.

Within one Execute run, HTTP mode reuses connections across calls for the same
origin and explicit headers. Changing identity headers selects a separate pool;
there is no cookie jar or shared model history. At most eight origin/header pools
are retained, with up to four sockets each; idle pools expire or are evicted.
The runner closes them on success, failure or cancellation. PowerShell command
mode still uses a fresh process, so shell variables and working-directory changes
cannot leak into the next call.

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
