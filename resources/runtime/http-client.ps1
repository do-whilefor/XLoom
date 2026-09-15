# Dot-source once inside a PowerShell 7 script. Caller owns/disposes the client.
function New-XloomHttpClient {
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $client = [System.Net.Http.HttpClient]::new($handler, $true)
    $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
    return $client
}

function Invoke-XloomHttp {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][System.Net.Http.HttpClient]$Client,
        [Parameter(Mandatory)][uri]$Uri,
        [string]$Method = 'GET',
        [hashtable]$Headers = @{},
        [byte[]]$Body,
        [ValidateRange(1, 3600)][int]$TimeoutSeconds = 30,
        [string]$EvidenceFile
    )
    if ($Uri.Scheme -notin @('http', 'https') -or $Uri.UserInfo) {
        throw 'Use an HTTP(S) URI without embedded credentials.'
    }
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Uri)
    $cancel = [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
    $response = $null
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $started = [DateTimeOffset]::UtcNow.ToString('o')
    try {
        if ($null -ne $Body) { $request.Content = [System.Net.Http.ByteArrayContent]::new($Body) }
        foreach ($key in $Headers.Keys) {
            if (-not $request.Headers.TryAddWithoutValidation([string]$key, [string[]]@($Headers[$key]))) {
                if ($null -eq $request.Content) { $request.Content = [System.Net.Http.ByteArrayContent]::new([byte[]]@()) }
                if (-not $request.Content.Headers.TryAddWithoutValidation([string]$key, [string[]]@($Headers[$key]))) {
                    throw "Invalid HTTP header: $key"
                }
            }
        }
        # One application request; no automatic redirect, cookie sharing, or retry loop.
        $response = $Client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token).GetAwaiter().GetResult()
        $bytes = $response.Content.ReadAsByteArrayAsync($cancel.Token).GetAwaiter().GetResult()
        $responseHeaders = [ordered]@{}
        foreach ($header in $response.Headers) { $responseHeaders[$header.Key] = [string[]]@($header.Value) }
        foreach ($header in $response.Content.Headers) { $responseHeaders[$header.Key] = [string[]]@($header.Value) }
        $watch.Stop()
        $result = [pscustomobject]@{
            StartedAt = $started
            DurationMs = $watch.Elapsed.TotalMilliseconds
            Request = @{ Method = $Method; Uri = $Uri.AbsoluteUri; Headers = $Headers; BodyBase64 = if ($null -eq $Body) { '' } else { [Convert]::ToBase64String($Body) } }
            Status = [int]$response.StatusCode
            Headers = $responseHeaders
            Body = [System.Text.Encoding]::UTF8.GetString($bytes)
            BodyBase64 = [Convert]::ToBase64String($bytes)
        }
        if ($EvidenceFile) {
            # Append after each completed request so a later failure retains prior observations.
            $line = ($result | ConvertTo-Json -Depth 12 -Compress) + "`n"
            [System.IO.File]::AppendAllText($EvidenceFile, $line, [System.Text.UTF8Encoding]::new($false))
        }
        return $result
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        $request.Dispose()
        $cancel.Dispose()
    }
}
