$embed = Get-Content .\query-embedding.json -Raw | ConvertFrom-Json

$request = @{
    vectorBucketName = "n12371661-repo-vectors"
    indexName = "repo-context"
    topK = 3
    queryVector = @{
        float32 = $embed.embedding
    }
    returnMetadata = $true
    returnDistance = $true
}

$json = $request | ConvertTo-Json -Depth 20 -Compress

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

[System.IO.File]::WriteAllText(
    (Join-Path $PWD "query-vector.json"),
    $json,
    $utf8NoBom
)

Write-Host "Created query-vector.json without UTF-8 BOM"