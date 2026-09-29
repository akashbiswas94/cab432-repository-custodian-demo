$embed = Get-Content .\embed-output.json -Raw | ConvertFrom-Json

$request = @{
    vectorBucketName = "n12371661-repo-vectors"
    indexName = "repo-context"
    vectors = @(
        @{
            key = "issue-auth-token-expiry"
            data = @{
                float32 = $embed.embedding
            }
            metadata = @{
                type   = "issue"
                source = "demo"
                text   = "Login fails when the user's authentication token expires."
            }
        }
    )
}

$json = $request | ConvertTo-Json -Depth 20 -Compress

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

[System.IO.File]::WriteAllText(
    (Join-Path $PWD "put-vector.json"),
    $json,
    $utf8NoBom
)

Write-Host "Created put-vector.json without UTF-8 BOM"