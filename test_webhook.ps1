$Base = if ($env:BASE) { $env:BASE } else { "http://localhost:3000/webhook" }
$CallId = "demo-auth-lock"

# The server reads WEBHOOK_TOKEN from .env, so a shell without it would get 401 on
# every step and look like a broken gate. Fall back to the same .env the server
# read, in a local variable rather than $env: so the token does not outlive this
# script. A shell value still wins, which is how the public URL gets tested.
$Token = $env:WEBHOOK_TOKEN
if (-not $Token) {
  $EnvFile = Join-Path $PSScriptRoot ".env"
  if (Test-Path $EnvFile) {
    $Line = Select-String -Path $EnvFile -Pattern '^\s*WEBHOOK_TOKEN\s*=' | Select-Object -First 1
    if ($Line) {
      $Token = ($Line.Line -replace '^\s*WEBHOOK_TOKEN\s*=\s*', '').Trim().Trim('"').Trim("'")
    }
  }
}

$Headers = @{}
if ($Token) {
  $Headers["Authorization"] = "Bearer $Token"
  Write-Host "using bearer token from $(if ($env:WEBHOOK_TOKEN) { 'the shell' } else { '.env' }); target $Base`n"
} else {
  Write-Host "no WEBHOOK_TOKEN found; target $Base is expected to be open`n"
}

function Invoke-ToolCall {
  param(
    [string]$Id,
    [string]$Name,
    [hashtable]$Arguments
  )

  $body = @{
    message = @{
      type = "tool-calls"
      call = @{ id = $CallId }
      toolCallList = @(
        @{
          id = $Id
          name = $Name
          arguments = $Arguments
        }
      )
    }
  } | ConvertTo-Json -Depth 8

  Invoke-RestMethod -Uri $Base -Method Post -ContentType "application/json" -Headers $Headers -Body $body
}

Write-Host "1. Pre-auth lookup must be denied"
Invoke-ToolCall -Id "t1" -Name "get_account_details" -Arguments @{} | ConvertTo-Json -Depth 8

Write-Host "1b. Pre-auth payment action must be denied"
Invoke-ToolCall -Id "t1b" -Name "send_payment_link" -Arguments @{ channel = "SMS" } | ConvertTo-Json -Depth 8

Write-Host "2. Verify customer"
Invoke-ToolCall -Id "t2" -Name "verify_customer" -Arguments @{ verification_type = "DOB_FULL"; verification_value = "15-06-1995" } | ConvertTo-Json -Depth 8

Write-Host "3. Same call ID can now fetch account details"
Invoke-ToolCall -Id "t3" -Name "get_account_details" -Arguments @{} | ConvertTo-Json -Depth 8

Write-Host "4. Repeating t3 must return the same result without another action"
Invoke-ToolCall -Id "t3" -Name "get_account_details" -Arguments @{} | ConvertTo-Json -Depth 8

Write-Host "5. A different call ID remains locked"
$CallId = "different-call"
Invoke-ToolCall -Id "t4" -Name "get_account_details" -Arguments @{} | ConvertTo-Json -Depth 8
