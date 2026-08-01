$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "realbrowser.mjs"
& node $scriptPath @args
exit $LASTEXITCODE
